// utils/professorVinculosSubstituicaoHelper.js
// ============================================================================
// Governança de Vínculos Docentes (professor_vinculos) e Substituição de Regência
// - Evita fragmentação de vínculos por turma (ex.: 10x 3h em vez de 1x 30h)
// - Respeita anualidade das turmas (turmas.regime <> 'semestral' -> semestre = 0 ANUAL),
//   evitando saldo negativo (-30 aulas) no 2º Semestre do módulo Modulação
// - Contorna armadilha do MySQL em UNIQUE KEY com etapa_id NULL (NULL != NULL)
// - Auto-reparo idempotente de vínculos fragmentados em substituições já realizadas
// ============================================================================

function normTurnoKey(turno) {
  return String(turno || "MATUTINO").trim().toLowerCase();
}

function normTurnoUpper(turno) {
  return String(turno || "MATUTINO").trim().toUpperCase();
}

export function isTurmaSemestral(regime) {
  return String(regime || "anual").trim().toLowerCase() === "semestral";
}

export function calcularCargaEfetivaModulacao(mod) {
  const tcCarga = Number(mod?.carga_turma) || 0;
  const mAulas = Number(mod?.aulas) || 0;
  const dCarga = Number(mod?.carga_disc) || 0;
  if (tcCarga > 0) return tcCarga;
  if (mAulas > 1) return mAulas;
  if (dCarga > 0) return dCarga;
  return mAulas > 0 ? mAulas : 1;
}

function somarValoresMapa(mapa) {
  let soma = 0;
  for (const val of mapa.values()) {
    soma += Number(val) || 0;
  }
  return soma;
}

/**
 * Insere ou atualiza um vínculo em `professor_vinculos` sem gerar linhas duplicadas
 * quando `etapa_id` é NULL (pois no MySQL UNIQUE KEY permite múltiplos NULLs).
 */
export async function upsertVinculoConsolidado(
  conn,
  { escolaId, professorId, turno, disciplinaId, etapaId = null, aulas = 0, semestre = 0 }
) {
  const escId = Number(escolaId);
  const profId = Number(professorId);
  const discId = Number(disciplinaId);
  const turnoUpper = normTurnoUpper(turno);
  const turnoKey = normTurnoKey(turno);
  const semVal = Number(semestre) || 0;
  const etapaVal = etapaId ? Number(etapaId) : null;
  const aulasVal = Math.max(0, Number(aulas) || 0);

  const [existentes] = await conn.query(
    `SELECT id, aulas, turno
       FROM professor_vinculos
      WHERE professor_id = ?
        AND escola_id = ?
        AND disciplina_id = ?
        AND LOWER(TRIM(turno)) = ?
        AND COALESCE(semestre, 0) = ?
        AND (etapa_id <=> ?)
      ORDER BY id ASC
      FOR UPDATE`,
    [profId, escId, discId, turnoKey, semVal, etapaVal]
  );

  if (existentes.length >= 1) {
    const keepId = existentes[0].id;
    await conn.query(
      `UPDATE professor_vinculos
          SET turno = ?, aulas = ?, semestre = ?, status = 'ativo'
        WHERE id = ? AND escola_id = ?`,
      [turnoUpper, aulasVal, semVal, keepId, escId]
    );

    if (existentes.length > 1) {
      const extraIds = existentes.slice(1).map((r) => Number(r.id));
      const ph = extraIds.map(() => "?").join(",");
      await conn.query(
        `DELETE FROM professor_vinculos
          WHERE escola_id = ? AND professor_id = ? AND id IN (${ph})`,
        [escId, profId, ...extraIds]
      );
    }
    return { id: keepId, updated: true, consolidatedDuplicates: existentes.length - 1 };
  }

  const [ins] = await conn.query(
    `INSERT INTO professor_vinculos
       (professor_id, escola_id, turno, disciplina_id, etapa_id, aulas, semestre, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ativo')`,
    [profId, escId, turnoUpper, discId, etapaVal, aulasVal, semVal]
  );

  return { id: ins?.insertId || null, updated: false, consolidatedDuplicates: 0 };
}

/**
 * Calcula e sincroniza os vínculos consolidados do professor substituto
 * ANTES de transferir/remover as linhas da tabela `modulacao`.
 *
 * Regras:
 * 1) Consolida por (turno, disciplina_id, semestre_efetivo) somando as aulas das turmas
 *    (ex.: 10 turmas anuais de 3h -> 1 único vínculo ANUAL de 30h).
 * 2) Turmas com regime <> 'semestral' geram SEMPRE vínculo ANUAL (semestre = 0),
 *    mesmo que `modulacao.semestre` esteja gravado como 1 no banco.
 * 3) Se o professor substituto já possuir vínculo prévio na mesma disciplina/turno,
 *    atualiza para `Math.max(vinculoAtual, aulasJaModuladasDestino + aulasTransferidas)`,
 *    evitando tanto duplicar badges quanto inflar vínculo pré-cadastrado pela secretaria.
 */
export async function sincronizarVinculosSubstituicao(
  conn,
  {
    escolaId,
    professorOrigemId,
    professorDestinoId,
    modulacoesTransferidas = [],
    agrupamentosTransferidos = [],
  }
) {
  const escId = Number(escolaId);
  const origemId = Number(professorOrigemId);
  const destinoId = Number(professorDestinoId);

  // 1. Consultar vínculos originais do titular para respeitar anualidade em escolas semestrais (FGB)
  const [vinculosOrigem] = await conn
    .query(
      `SELECT turno, disciplina_id, aulas, COALESCE(semestre, 0) AS semestre
         FROM professor_vinculos
        WHERE professor_id = ? AND escola_id = ?`,
      [origemId, escId]
    )
    .catch(() => [[]]);

  const origemAnualMap = new Map(); // key: `${turnoKey}|${discId}` -> { hasAnual, hasSemestral }
  for (const vo of vinculosOrigem || []) {
    const key = `${normTurnoKey(vo.turno)}|${Number(vo.disciplina_id)}`;
    const cur = origemAnualMap.get(key) || { hasAnual: false, hasSemestral: false };
    const s = Number(vo.semestre || 0);
    if (s === 0) cur.hasAnual = true;
    if (s === 1 || s === 2) cur.hasSemestral = true;
    origemAnualMap.set(key, cur);
  }

  // 2. Agrupar modulações transferidas por (turnoKey, discId, semVinculo)
  //    deduplicando por turma_id dentro de cada semestre para nunca dobrar FGB (sem 1 + sem 2)
  const buckets = new Map();

  const ensureBucket = (turnoRaw, discId, semVinculo) => {
    const tKey = normTurnoKey(turnoRaw);
    const tUpper = normTurnoUpper(turnoRaw);
    const bKey = `${tKey}|${discId}|${semVinculo}`;
    if (!buckets.has(bKey)) {
      buckets.set(bKey, {
        turnoKey: tKey,
        turnoUpper: tUpper,
        disciplinaId: discId,
        semestre: semVinculo,
        porTurmaSem1: new Map(),
        porTurmaSem2: new Map(),
        porTurmaSemEspecifico: new Map(),
        aulasAgrupamentoSem1: 0,
        aulasAgrupamentoSem2: 0,
        turmasTransferidasIds: new Set(),
      });
    }
    return buckets.get(bKey);
  };

  for (const mod of modulacoesTransferidas || []) {
    const discId = Number(mod?.disciplina_id);
    if (!discId) continue;

    const turnoRaw = mod?.turno || "MATUTINO";
    const tKey = normTurnoKey(turnoRaw);
    const origInfo = origemAnualMap.get(`${tKey}|${discId}`);
    const origemPuramenteAnual = Boolean(origInfo?.hasAnual && !origInfo?.hasSemestral);
    const semestral = isTurmaSemestral(mod?.regime);
    const modSem = Number(mod?.semestre || 0);

    let semVinculo = 0;
    if (!semestral) {
      // Turma de regime anual -> vínculo OBRIGATORIAMENTE anual (0)
      semVinculo = 0;
    } else if (origemPuramenteAnual || modSem === 0) {
      semVinculo = 0;
    } else {
      semVinculo = modSem === 2 ? 2 : 1;
    }

    const carga = calcularCargaEfetivaModulacao(mod);
    const turmaKey = mod?.turma_id != null ? String(mod.turma_id) : `mod_${mod?.id || Math.random()}`;
    const bucket = ensureBucket(turnoRaw, discId, semVinculo);

    if (mod?.turma_id != null) {
      bucket.turmasTransferidasIds.add(Number(mod.turma_id));
    }

    if (semVinculo === 0) {
      if (!semestral || modSem === 0 || modSem === 1) {
        bucket.porTurmaSem1.set(turmaKey, Math.max(bucket.porTurmaSem1.get(turmaKey) || 0, carga));
      }
      if (!semestral || modSem === 0 || modSem === 2) {
        bucket.porTurmaSem2.set(turmaKey, Math.max(bucket.porTurmaSem2.get(turmaKey) || 0, carga));
      }
    } else {
      bucket.porTurmaSemEspecifico.set(
        turmaKey,
        Math.max(bucket.porTurmaSemEspecifico.get(turmaKey) || 0, carga)
      );
    }
  }

  // Incluir eventuais agrupamentos transferidos (Eletivas / Projetos / IFAs)
  for (const agr of agrupamentosTransferidos || []) {
    const discId = Number(agr?.disciplina_id);
    if (!discId) continue;
    const turnoRaw = agr?.turno || modulacoesTransferidas?.[0]?.turno || "MATUTINO";
    const tKey = normTurnoKey(turnoRaw);
    const origInfo = origemAnualMap.get(`${tKey}|${discId}`);
    const origemPuramenteAnual = Boolean(origInfo?.hasAnual && !origInfo?.hasSemestral);
    const agrSem = Number(agr?.semestre || 0);
    const semVinculo = origemPuramenteAnual || agrSem === 0 ? 0 : agrSem === 2 ? 2 : 1;
    const cargaAgr = Number(agr?.aulas) || 1;
    const bucket = ensureBucket(turnoRaw, discId, semVinculo);

    if (semVinculo === 0) {
      if (agrSem === 0 || agrSem === 1) bucket.aulasAgrupamentoSem1 += cargaAgr;
      if (agrSem === 0 || agrSem === 2) bucket.aulasAgrupamentoSem2 += cargaAgr;
    } else {
      const agrKey = `agr_${agr?.id || agr?.agrupamento_id || Math.random()}`;
      bucket.porTurmaSemEspecifico.set(
        agrKey,
        (bucket.porTurmaSemEspecifico.get(agrKey) || 0) + cargaAgr
      );
    }
  }

  // Se em escola semestral o titular não tinha professor_vinculos (legado), mas as mesmas turmas
  // foram moduladas igualmente no 1º e no 2º semestre, consolida os dois buckets em ANUAL (0).
  const paresParaUnificar = [];
  for (const [bKey, b1] of buckets.entries()) {
    if (b1.semestre !== 1) continue;
    const origInfo = origemAnualMap.get(`${b1.turnoKey}|${b1.disciplinaId}`);
    if (origInfo?.hasSemestral) continue;
    const b2Key = `${b1.turnoKey}|${b1.disciplinaId}|2`;
    const b2 = buckets.get(b2Key);
    if (!b2) continue;
    const s1 = somarValoresMapa(b1.porTurmaSemEspecifico);
    const s2 = somarValoresMapa(b2.porTurmaSemEspecifico);
    const mesmasTurmas =
      b1.turmasTransferidasIds.size > 0 &&
      b1.turmasTransferidasIds.size === b2.turmasTransferidasIds.size &&
      [...b1.turmasTransferidasIds].every((id) => b2.turmasTransferidasIds.has(id));
    if (s1 > 0 && s1 === s2 && mesmasTurmas) {
      paresParaUnificar.push({ b1Key: bKey, b2Key, b1, b2 });
    }
  }
  for (const { b1Key, b2Key, b1, b2 } of paresParaUnificar) {
    const bAnual = ensureBucket(b1.turnoUpper, b1.disciplinaId, 0);
    for (const [k, v] of b1.porTurmaSemEspecifico.entries()) {
      bAnual.porTurmaSem1.set(k, Math.max(bAnual.porTurmaSem1.get(k) || 0, v));
    }
    for (const [k, v] of b2.porTurmaSemEspecifico.entries()) {
      bAnual.porTurmaSem2.set(k, Math.max(bAnual.porTurmaSem2.get(k) || 0, v));
    }
    for (const id of b1.turmasTransferidasIds) bAnual.turmasTransferidasIds.add(id);
    for (const id of b2.turmasTransferidasIds) bAnual.turmasTransferidasIds.add(id);
    buckets.delete(b1Key);
    buckets.delete(b2Key);
  }

  // 3. Para cada bucket consolidado, calcular carga prévia do substituto e atualizar/inserir 1 único vínculo
  const resultados = [];
  let primeiroVinculo = null;

  for (const bucket of buckets.values()) {
    const aulasTransferidas =
      bucket.semestre === 0
        ? Math.max(
            somarValoresMapa(bucket.porTurmaSem1) + bucket.aulasAgrupamentoSem1,
            somarValoresMapa(bucket.porTurmaSem2) + bucket.aulasAgrupamentoSem2
          )
        : somarValoresMapa(bucket.porTurmaSemEspecifico);

    if (aulasTransferidas <= 0) continue;

    // 3.1 Carga já modulada previamente pelo substituto neste (turno, disciplina)
    //     (excluindo turmas que fazem parte da própria transferência)
    const [modDestinoRows] = await conn
      .query(
        `SELECT m.turma_id, m.aulas, COALESCE(m.semestre, 0) AS semestre,
                t.regime, d.carga AS carga_disc,
                (
                  SELECT MAX(tc.carga)
                    FROM turma_cargas tc
                   WHERE tc.escola_id = m.escola_id
                     AND tc.turma_id = m.turma_id
                     AND tc.disciplina_id = m.disciplina_id
                ) AS carga_turma
           FROM modulacao m
           JOIN turmas t ON t.id = m.turma_id
           LEFT JOIN disciplinas d ON d.id = m.disciplina_id
          WHERE m.escola_id = ?
            AND m.professor_id = ?
            AND m.disciplina_id = ?
            AND LOWER(TRIM(t.turno)) = ?`,
        [escId, destinoId, bucket.disciplinaId, bucket.turnoKey]
      )
      .catch(() => [[]]);

    const destSem1 = new Map();
    const destSem2 = new Map();
    let destTemTurmaSemestral = false;

    for (const md of modDestinoRows || []) {
      const tId = Number(md.turma_id);
      if (bucket.turmasTransferidasIds.has(tId)) continue;
      const semDest = isTurmaSemestral(md.regime);
      if (semDest) destTemTurmaSemestral = true;
      const mSem = Number(md.semestre || 0);
      const c = calcularCargaEfetivaModulacao(md);
      const k = String(tId);
      if (!semDest || mSem === 0 || mSem === 1) {
        destSem1.set(k, Math.max(destSem1.get(k) || 0, c));
      }
      if (!semDest || mSem === 0 || mSem === 2) {
        destSem2.set(k, Math.max(destSem2.get(k) || 0, c));
      }
    }

    const aulasJaModuladasDestino =
      bucket.semestre === 1
        ? somarValoresMapa(destSem1)
        : bucket.semestre === 2
        ? somarValoresMapa(destSem2)
        : Math.max(somarValoresMapa(destSem1), somarValoresMapa(destSem2));

    // 3.2 Vínculos já existentes no substituto para (turnoKey, disciplinaId)
    const [vincDestinoRows] = await conn.query(
      `SELECT id, turno, aulas, COALESCE(semestre, 0) AS semestre, etapa_id
         FROM professor_vinculos
        WHERE professor_id = ?
          AND escola_id = ?
          AND disciplina_id = ?
          AND LOWER(TRIM(turno)) = ?
        ORDER BY id ASC
        FOR UPDATE`,
      [destinoId, escId, bucket.disciplinaId, bucket.turnoKey]
    );

    let semAlvo = bucket.semestre;
    let candidatos = (vincDestinoRows || []).filter((v) => Number(v.semestre || 0) === semAlvo);

    // Se a transferência é semestral, mas o substituto já opera sob vínculo ANUAL nessa disciplina/turno,
    // consolida no vínculo ANUAL existente para não duplicar regimes.
    if (candidatos.length === 0 && semAlvo !== 0) {
      const anuais = (vincDestinoRows || []).filter((v) => Number(v.semestre || 0) === 0);
      if (anuais.length > 0) {
        candidatos = anuais;
        semAlvo = 0;
      }
    }

    // Se a transferência é ANUAL e o substituto não possui vínculo ANUAL, mas possuía vínculo(s)
    // semestral(is) sem nenhuma turma semestral modulada (ex.: resquício ou pré-cadastro equivocado),
    // converte/consolida em ANUAL (0).
    if (candidatos.length === 0 && semAlvo === 0 && vincDestinoRows?.length > 0 && !destTemTurmaSemestral) {
      candidatos = vincDestinoRows;
    }

    const somaVinculoAtual = candidatos.reduce((acc, r) => acc + (Number(r.aulas) || 0), 0);
    // Se havia múltiplos fragmentos (ex.: 10x 3h), evita inflar caso fossem duplicatas de 30h
    const somaNormalizada =
      candidatos.length > 1 && somaVinculoAtual > 40
        ? Math.max(...candidatos.map((r) => Number(r.aulas) || 0))
        : somaVinculoAtual;

    const novoTotalAulas = Math.max(somaNormalizada, aulasJaModuladasDestino + aulasTransferidas);

    if (candidatos.length >= 1) {
      const keepId = candidatos[0].id;
      await conn.query(
        `UPDATE professor_vinculos
            SET turno = ?, aulas = ?, semestre = ?, status = 'ativo'
          WHERE id = ? AND escola_id = ?`,
        [bucket.turnoUpper, novoTotalAulas, semAlvo, keepId, escId]
      );

      if (candidatos.length > 1) {
        const extraIds = candidatos.slice(1).map((r) => Number(r.id));
        const ph = extraIds.map(() => "?").join(",");
        await conn.query(
          `DELETE FROM professor_vinculos
            WHERE escola_id = ? AND professor_id = ? AND id IN (${ph})`,
          [escId, destinoId, ...extraIds]
        );
      }
    } else {
      await conn.query(
        `INSERT INTO professor_vinculos
           (professor_id, escola_id, turno, disciplina_id, aulas, semestre, status)
         VALUES (?, ?, ?, ?, ?, ?, 'ativo')`,
        [destinoId, escId, bucket.turnoUpper, bucket.disciplinaId, novoTotalAulas, semAlvo]
      );
    }

    const resumoItem = {
      turno: bucket.turnoUpper,
      disciplina_id: bucket.disciplinaId,
      semestre: semAlvo,
      aulas: novoTotalAulas,
    };
    resultados.push(resumoItem);
    if (!primeiroVinculo) primeiroVinculo = resumoItem;
  }

  // 4. Compatibilidade legada: preenche professores.disciplina_id/turno/aulas se ainda estiverem nulos
  if (primeiroVinculo) {
    await conn
      .query(
        `UPDATE professores
            SET disciplina_id = COALESCE(disciplina_id, ?),
                turno = COALESCE(NULLIF(TRIM(turno), ''), ?),
                aulas = CASE WHEN COALESCE(aulas, 0) = 0 THEN ? ELSE aulas END
          WHERE id = ? AND escola_id = ?`,
        [
          primeiroVinculo.disciplina_id,
          primeiroVinculo.turno,
          primeiroVinculo.aulas,
          destinoId,
          escId,
        ]
      )
      .catch(() => {});
  }

  return resultados;
}

/**
 * Auto-reparo idempotente na inicialização do servidor:
 * 1) Consolida vínculos fragmentados/duplicados (ex.: 10 vínculos de 3h criados pela Substituição
 *    quando `etapa_id IS NULL`) em 1 único vínculo consolidado com a soma correta de aulas.
 * 2) Corrige `semestre = 1/2` -> `0` (ANUAL) quando todas as turmas moduladas do professor
 *    naquele (turno, disciplina) são de regime ANUAL (resolvendo o saldo -30 no 2º Semestre).
 */
export async function reconciliarVinculosFragmentadosSubstituicao(pool) {
  let conn;
  try {
    // Pré-checagem leve sem transação para não gerar overhead em boots subsequentes
    const [dupGroups] = await pool.query(
      `SELECT escola_id, professor_id, LOWER(TRIM(turno)) AS turno_key, disciplina_id
         FROM professor_vinculos
        GROUP BY escola_id, professor_id, LOWER(TRIM(turno)), disciplina_id, COALESCE(etapa_id, 0), COALESCE(semestre, 0)
       HAVING COUNT(*) > 1`
    );

    let subAnualDesalinhados = [];
    try {
      const [subRows] = await pool.query(
        `SELECT DISTINCT pv.escola_id, pv.professor_id, LOWER(TRIM(pv.turno)) AS turno_key, pv.disciplina_id
           FROM professor_vinculos pv
           JOIN grade_substituicoes_historico gsh
             ON gsh.escola_id = pv.escola_id
            AND gsh.professor_substituto_id = pv.professor_id
          WHERE pv.semestre IN (1, 2)
            AND EXISTS (
              SELECT 1
                FROM modulacao m
                JOIN turmas t ON t.id = m.turma_id
               WHERE m.escola_id = pv.escola_id
                 AND m.professor_id = pv.professor_id
                 AND m.disciplina_id = pv.disciplina_id
                 AND LOWER(TRIM(t.turno)) = LOWER(TRIM(pv.turno))
                 AND LOWER(COALESCE(t.regime, 'anual')) <> 'semestral'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM modulacao ms
                JOIN turmas ts ON ts.id = ms.turma_id
               WHERE ms.escola_id = pv.escola_id
                 AND ms.professor_id = pv.professor_id
                 AND ms.disciplina_id = pv.disciplina_id
                 AND LOWER(TRIM(ts.turno)) = LOWER(TRIM(pv.turno))
                 AND LOWER(COALESCE(ts.regime, 'anual')) = 'semestral'
            )`
      );
      subAnualDesalinhados = subRows || [];
    } catch {
      subAnualDesalinhados = [];
    }

    const alvosMap = new Map();
    for (const r of [...(dupGroups || []), ...subAnualDesalinhados]) {
      const key = `${r.escola_id}|${r.professor_id}|${r.turno_key}|${r.disciplina_id}`;
      alvosMap.set(key, {
        escolaId: Number(r.escola_id),
        professorId: Number(r.professor_id),
        turnoKey: String(r.turno_key || "").trim().toLowerCase(),
        disciplinaId: Number(r.disciplina_id),
      });
    }

    if (alvosMap.size === 0) return { reparados: 0, removidos: 0 };

    conn = await pool.getConnection();
    await conn.beginTransaction();

    let reparados = 0;
    let removidos = 0;

    for (const alvo of alvosMap.values()) {
      const [pvRows] = await conn.query(
        `SELECT id, turno, disciplina_id, etapa_id, aulas, COALESCE(semestre, 0) AS semestre, status
           FROM professor_vinculos
          WHERE escola_id = ?
            AND professor_id = ?
            AND disciplina_id = ?
            AND LOWER(TRIM(turno)) = ?
          ORDER BY id ASC
          FOR UPDATE`,
        [alvo.escolaId, alvo.professorId, alvo.disciplinaId, alvo.turnoKey]
      );

      if (!pvRows.length) continue;

      const [modRows] = await conn.query(
        `SELECT m.turma_id, m.aulas, COALESCE(m.semestre, 0) AS semestre,
                t.regime, d.carga AS carga_disc,
                (
                  SELECT MAX(tc.carga)
                    FROM turma_cargas tc
                   WHERE tc.escola_id = m.escola_id
                     AND tc.turma_id = m.turma_id
                     AND tc.disciplina_id = m.disciplina_id
                ) AS carga_turma
           FROM modulacao m
           JOIN turmas t ON t.id = m.turma_id
           LEFT JOIN disciplinas d ON d.id = m.disciplina_id
          WHERE m.escola_id = ?
            AND m.professor_id = ?
            AND m.disciplina_id = ?
            AND LOWER(TRIM(t.turno)) = ?`,
        [alvo.escolaId, alvo.professorId, alvo.disciplinaId, alvo.turnoKey]
      );

      let qtdAnuais = 0;
      let qtdSemestrais = 0;
      const modSem1 = new Map();
      const modSem2 = new Map();

      for (const m of modRows || []) {
        const sem = isTurmaSemestral(m.regime);
        if (sem) qtdSemestrais++;
        else qtdAnuais++;

        const mSem = Number(m.semestre || 0);
        const c = calcularCargaEfetivaModulacao(m);
        const k = String(m.turma_id);
        if (!sem || mSem === 0 || mSem === 1) {
          modSem1.set(k, Math.max(modSem1.get(k) || 0, c));
        }
        if (!sem || mSem === 0 || mSem === 2) {
          modSem2.set(k, Math.max(modSem2.get(k) || 0, c));
        }
      }

      const exclusivamenteAnual = qtdAnuais > 0 && qtdSemestrais === 0;
      const cargaModuladaAnual = Math.max(somarValoresMapa(modSem1), somarValoresMapa(modSem2));

      if (exclusivamenteAnual) {
        // Consolida todos os vínculos deste (escola, professor, turno, disciplina) em 1 único vínculo ANUAL (semestre = 0)
        const somaBruta = pvRows.reduce((acc, r) => acc + (Number(r.aulas) || 0), 0);
        const maiorIndividual = Math.max(...pvRows.map((r) => Number(r.aulas) || 0));
        const aulasConsolidadas =
          somaBruta <= 40 && somaBruta >= cargaModuladaAnual
            ? somaBruta
            : Math.max(maiorIndividual, cargaModuladaAnual);

        const keepRow = pvRows.find((r) => Number(r.semestre) === 0) || pvRows[0];
        const turnoUpper = normTurnoUpper(keepRow.turno);

        await conn.query(
          `UPDATE professor_vinculos
              SET turno = ?, aulas = ?, semestre = 0, status = 'ativo'
            WHERE id = ? AND escola_id = ?`,
          [turnoUpper, aulasConsolidadas, keepRow.id, alvo.escolaId]
        );
        reparados++;

        const deleteIds = pvRows.filter((r) => r.id !== keepRow.id).map((r) => Number(r.id));
        if (deleteIds.length > 0) {
          const ph = deleteIds.map(() => "?").join(",");
          await conn.query(
            `DELETE FROM professor_vinculos
              WHERE escola_id = ? AND professor_id = ? AND id IN (${ph})`,
            [alvo.escolaId, alvo.professorId, ...deleteIds]
          );
          removidos += deleteIds.length;
        }

        // Sincroniza colunas legadas se necessário
        await conn
          .query(
            `UPDATE professores
                SET disciplina_id = COALESCE(disciplina_id, ?),
                    turno = COALESCE(NULLIF(TRIM(turno), ''), ?),
                    aulas = CASE WHEN COALESCE(aulas, 0) IN (0, ?) THEN ? ELSE aulas END
              WHERE id = ? AND escola_id = ?`,
            [
              alvo.disciplinaId,
              turnoUpper,
              maiorIndividual,
              aulasConsolidadas,
              alvo.professorId,
              alvo.escolaId,
            ]
          )
          .catch(() => {});
      } else {
        // Caso semestral ou sem modulação ativa: consolida duplicatas exatas por (etapa_id, semestre)
        const subGrupos = new Map();
        for (const r of pvRows) {
          const gKey = `${r.etapa_id ?? "null"}|${Number(r.semestre || 0)}`;
          if (!subGrupos.has(gKey)) subGrupos.set(gKey, []);
          subGrupos.get(gKey).push(r);
        }

        for (const grupo of subGrupos.values()) {
          if (grupo.length <= 1) continue;
          const semGrupo = Number(grupo[0].semestre || 0);
          const cargaModSem =
            semGrupo === 1
              ? somarValoresMapa(modSem1)
              : semGrupo === 2
              ? somarValoresMapa(modSem2)
              : cargaModuladaAnual;
          const somaGrupo = grupo.reduce((acc, r) => acc + (Number(r.aulas) || 0), 0);
          const maiorGrupo = Math.max(...grupo.map((r) => Number(r.aulas) || 0));
          const aulasConsolidadas =
            cargaModSem > 0
              ? somaGrupo <= 40 && somaGrupo >= cargaModSem
                ? somaGrupo
                : Math.max(maiorGrupo, cargaModSem)
              : somaGrupo <= 40
              ? somaGrupo
              : maiorGrupo;

          const keepRow = grupo[0];
          await conn.query(
            `UPDATE professor_vinculos
                SET turno = ?, aulas = ?, status = 'ativo'
              WHERE id = ? AND escola_id = ?`,
            [normTurnoUpper(keepRow.turno), aulasConsolidadas, keepRow.id, alvo.escolaId]
          );
          reparados++;

          const deleteIds = grupo.slice(1).map((r) => Number(r.id));
          const ph = deleteIds.map(() => "?").join(",");
          await conn.query(
            `DELETE FROM professor_vinculos
              WHERE escola_id = ? AND professor_id = ? AND id IN (${ph})`,
            [alvo.escolaId, alvo.professorId, ...deleteIds]
          );
          removidos += deleteIds.length;
        }
      }
    }

    await conn.commit();
    console.log(
      `[PROFESSOR_VINCULOS] Auto-reparo concluído: ${reparados} vínculo(s) consolidado(s), ${removidos} fragmento(s) removido(s).`
    );
    return { reparados, removidos };
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.warn("[PROFESSOR_VINCULOS] Aviso no auto-reparo de vínculos:", err?.message);
    return { reparados: 0, removidos: 0 };
  } finally {
    if (conn) conn.release();
  }
}
