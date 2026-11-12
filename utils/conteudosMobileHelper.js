// utils/conteudosMobileHelper.js
// ============================================================================
// EDUCA.MELHOR — Helper unificado para os endpoints Mobile de Conteúdos
//   • GET /api/app-pais/conteudos/disciplinas
//   • GET /api/app-pais/conteudos
//
// Regras de negócio:
//   1. Escopo estrito por estudante/turma ativa (matriculas -> fallback alunos.turma_id).
//   2. Suporte nativo à Semestralidade (turmas.regime = 'semestral'):
//      - Detecta automaticamente o semestre vigente via governanca_ano_letivo_periodos.
//      - Filtra turma_cargas, modulacao, agrupamentos (IFA/Eletivas/Projetos do aluno)
//        e notas lançadas de acordo com o semestre selecionado (1 ou 2).
//      - Impede vazamento de IFAs/Eletivas de outros estudantes ou de outras turmas.
//   3. Resolução de disciplinas mescladas (mesclada_em) e deduplicação insensível
//      a caixa/acentos (ex.: "Educação Física" vs "EDUCAÇÃO FÍSICA").
//   4. Leitura consolidada de objetivos em conteudos_objetivos_escola (+ seedf_conteudos)
//      e conteudos_plano_itens, tolerando variações de grafia de série ("3° ANO",
//      "3º ANO", "3ª SÉRIE") e IDs de disciplinas mescladas/homônimas.
// ============================================================================

function normTxt(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[º°ª]/g, "o")
    .replace(/\s+/g, " ");
}

function normNomeDisciplinaKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function toIsoDateOnly(val) {
  if (!val) return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

function hojeBrasilIso() {
  // UTC-3 (America/Sao_Paulo)
  const br = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return br.toISOString().slice(0, 10);
}

/**
 * Determina o semestre vigente (1 ou 2) da escola no ano letivo a partir de
 * governanca_ano_letivo_periodos, com fallback seguro pelo mês corrente.
 */
async function resolverSemestreAtualGovernanca(db, escolaId, anoLetivo) {
  const hojeIso = hojeBrasilIso();
  const mesFallback = Number(hojeIso.slice(5, 7)) <= 7 ? 1 : 2;

  try {
    const [rows] = await db.query(
      `SELECT tipo, numero, data_inicio, data_fim
         FROM governanca_ano_letivo_periodos
        WHERE escola_id = ? AND ano_letivo = ?
        ORDER BY tipo ASC, numero ASC`,
      [escolaId, anoLetivo]
    );

    if (!rows || rows.length === 0) return mesFallback;

    const semestres = [];
    const bimestres = [];
    for (const r of rows) {
      const dataInicio = toIsoDateOnly(r.data_inicio);
      const dataFim = toIsoDateOnly(r.data_fim);
      if (!dataInicio || !dataFim) continue;
      const item = { numero: Number(r.numero), dataInicio, dataFim };
      if (r.tipo === "semestre") semestres.push(item);
      else if (r.tipo === "bimestre") bimestres.push(item);
    }

    if (semestres.length > 0) {
      for (const s of semestres) {
        if ((s.numero === 1 || s.numero === 2) && hojeIso >= s.dataInicio && hojeIso <= s.dataFim) {
          return s.numero;
        }
      }
      const s2 = semestres.find((s) => s.numero === 2);
      const s1 = semestres.find((s) => s.numero === 1);
      if (s2?.dataInicio && hojeIso >= s2.dataInicio) return 2;
      if (s1?.dataFim && hojeIso <= s1.dataFim) return 1;
    }

    if (bimestres.length > 0) {
      const b3 = bimestres.find((b) => b.numero === 3);
      const b2 = bimestres.find((b) => b.numero === 2);
      if (b3?.dataInicio && hojeIso >= b3.dataInicio) return 2;
      if (b2?.dataFim && hojeIso > b2.dataFim) return 2;
      return 1;
    }
  } catch (err) {
    console.warn("[CONTEUDOS_MOBILE] Aviso ao ler governanca_ano_letivo_periodos:", err.message);
  }

  return mesFallback;
}

/**
 * Valida vínculo de acesso (ALUNO ou RESPONSAVEL) e resolve a turma ativa,
 * série, etapa, regime ('anual' | 'semestral') e semestre_atual.
 */
export async function resolverContextoConteudosAluno(db, req, alunoId, anoLetivo) {
  let row = null;

  if (req.alunoAuth) {
    if (Number(req.alunoAuth.aluno_id) !== Number(alunoId)) {
      return { forbidden: true };
    }

    try {
      const [[r]] = await db.query(
        `SELECT
           a.id AS aluno_id,
           a.escola_id,
           COALESCE(tm.id, t.id) AS turma_id,
           COALESCE(tm.nome, t.nome) AS turma_nome,
           COALESCE(tm.serie, t.serie, a.serie) AS serie,
           COALESCE(tm.etapa, t.etapa) AS etapa,
           COALESCE(tm.turno, t.turno) AS turno,
           COALESCE(tm.nome_oficial, t.nome_oficial) AS turma_nome_oficial,
           LOWER(COALESCE(tm.regime, t.regime, 'anual')) AS regime
         FROM alunos a
         LEFT JOIN turmas t ON t.id = a.turma_id
         LEFT JOIN matriculas m
           ON m.aluno_id = a.id
          AND m.escola_id = a.escola_id
          AND m.status IN ('ativo', 'matriculado')
          AND m.id = (
            SELECT m2.id
              FROM matriculas m2
             WHERE m2.aluno_id = a.id
               AND m2.escola_id = a.escola_id
               AND m2.status IN ('ativo', 'matriculado')
             ORDER BY (m2.ano_letivo = ?) DESC, m2.ano_letivo DESC, m2.id DESC
             LIMIT 1
          )
         LEFT JOIN turmas tm ON tm.id = m.turma_id
         WHERE a.id = ?
         LIMIT 1`,
        [anoLetivo, alunoId]
      );
      row = r || null;
    } catch {
      const [[rFallback]] = await db.query(
        `SELECT
           a.id AS aluno_id,
           a.escola_id,
           a.turma_id,
           t.nome AS turma_nome,
           COALESCE(t.serie, a.serie) AS serie,
           t.etapa AS etapa,
           t.turno AS turno,
           NULL AS turma_nome_oficial,
           'anual' AS regime
         FROM alunos a
         LEFT JOIN turmas t ON t.id = a.turma_id
         WHERE a.id = ?
         LIMIT 1`,
        [alunoId]
      );
      row = rFallback || null;
    }
  } else if (req.appPaisAuth) {
    const { responsavel_id } = req.appPaisAuth;
    try {
      const [[r]] = await db.query(
        `SELECT
           a.id AS aluno_id,
           ra.escola_id,
           COALESCE(tm.id, t.id) AS turma_id,
           COALESCE(tm.nome, t.nome) AS turma_nome,
           COALESCE(tm.serie, t.serie, a.serie) AS serie,
           COALESCE(tm.etapa, t.etapa) AS etapa,
           COALESCE(tm.turno, t.turno) AS turno,
           COALESCE(tm.nome_oficial, t.nome_oficial) AS turma_nome_oficial,
           LOWER(COALESCE(tm.regime, t.regime, 'anual')) AS regime
         FROM responsaveis_alunos ra
         INNER JOIN alunos a ON a.id = ra.aluno_id
         LEFT JOIN turmas t ON t.id = a.turma_id
         LEFT JOIN matriculas m
           ON m.aluno_id = a.id
          AND m.escola_id = ra.escola_id
          AND m.status IN ('ativo', 'matriculado')
          AND m.id = (
            SELECT m2.id
              FROM matriculas m2
             WHERE m2.aluno_id = a.id
               AND m2.escola_id = ra.escola_id
               AND m2.status IN ('ativo', 'matriculado')
             ORDER BY (m2.ano_letivo = ?) DESC, m2.ano_letivo DESC, m2.id DESC
             LIMIT 1
          )
         LEFT JOIN turmas tm ON tm.id = m.turma_id
         WHERE ra.responsavel_id = ?
           AND ra.aluno_id = ?
           AND ra.ativo = 1
         LIMIT 1`,
        [anoLetivo, responsavel_id, alunoId]
      );
      row = r || null;
    } catch {
      const [[rFallback]] = await db.query(
        `SELECT
           a.id AS aluno_id,
           ra.escola_id,
           a.turma_id,
           t.nome AS turma_nome,
           COALESCE(t.serie, a.serie) AS serie,
           t.etapa AS etapa,
           t.turno AS turno,
           NULL AS turma_nome_oficial,
           'anual' AS regime
         FROM responsaveis_alunos ra
         INNER JOIN alunos a ON a.id = ra.aluno_id
         LEFT JOIN turmas t ON t.id = a.turma_id
         WHERE ra.responsavel_id = ?
           AND ra.aluno_id = ?
           AND ra.ativo = 1
         LIMIT 1`,
        [responsavel_id, alunoId]
      );
      row = rFallback || null;
    }
  }

  if (!row) {
    return { forbidden: true };
  }

  const escolaId = Number(row.escola_id);
  const turmaId = row.turma_id ? Number(row.turma_id) : null;
  const turmaNome = String(row.turma_nome || "").trim();
  const serie = String(row.serie || "").trim();
  const etapaRaw = String(row.etapa || "").trim();
  const oficialUpper = String(row.turma_nome_oficial || "").toUpperCase();

  const etapaResolvida =
    etapaRaw ||
    (/\bEMI_[123]_/.test(oficialUpper)
      ? "ENSINO MÉDIO INTEGRAL"
      : /\bEM_[123]_/.test(oficialUpper)
      ? "ENSINO MÉDIO"
      : "");

  const etapaNorm = normTxt(etapaResolvida);
  const serieNorm = normTxt(serie);
  const turmaNorm = normTxt(turmaNome);

  const isEnsinoMedio =
    etapaNorm.includes("medio") ||
    /\bEMI?_[123]_/.test(oficialUpper) ||
    serieNorm.includes("serie") ||
    turmaNorm.includes("serie") ||
    turmaNorm.includes("ensino medio");

  const regime = row.regime === "semestral" ? "semestral" : "anual";
  const semestreAtual =
    regime === "semestral"
      ? await resolverSemestreAtualGovernanca(db, escolaId, anoLetivo)
      : 1;

  return {
    forbidden: false,
    escolaId,
    turmaId,
    turmaNome,
    serie,
    etapa: etapaResolvida,
    isEnsinoMedio,
    regime,
    semestreAtual,
  };
}

function extrairDigitoSerie(str) {
  const m = String(str || "").match(/\b([1-9])\b|([1-9])[º°ªo]/i);
  if (!m) return null;
  return Number(m[1] || m[2]);
}

/**
 * Verifica se o campo `serie` salvo no planejamento corresponde à série/etapa
 * do estudante, tolerando diferenças como "3° ANO", "3º ANO" e "3ª SÉRIE" no EM,
 * sem jamais misturar 3º Ano do Fundamental com 3ª Série do Ensino Médio.
 */
function serieCorrespondeConteudo(rowSerie, ctx) {
  const sRowRaw = String(rowSerie || "").trim();
  if (!sRowRaw) return false;

  const sRow = normTxt(sRowRaw);
  const sAluno = normTxt(ctx.serie);
  const sTurma = normTxt(ctx.turmaNome);

  if (sAluno && sRow === sAluno) return true;

  const numAluno = extrairDigitoSerie(ctx.serie) ?? extrairDigitoSerie(ctx.turmaNome);
  const numRow = extrairDigitoSerie(sRowRaw);

  if (!numAluno || !numRow || numAluno !== numRow) {
    return false;
  }

  const rowIndicaFundamental =
    /\bef\b/.test(sRow) || sRow.includes("fund") || sRow.includes("inicia") || sRow.includes("finais");
  const rowIndicaMedio =
    /\bem\b/.test(sRow) || sRow.includes("medio") || sRow.includes("serie");

  if (ctx.isEnsinoMedio) {
    if (rowIndicaFundamental) return false;
    return numAluno >= 1 && numAluno <= 3;
  }

  // Ensino Fundamental: rejeita registros exclusivos de Ensino Médio ("1ª Série", "EM", etc.)
  if (rowIndicaMedio && !sTurma.includes("serie")) {
    return false;
  }
  return true;
}

function isDisciplinaRegularDaTurma(d) {
  const modo = String(d?.modo_oferta || "TURMA").trim().toUpperCase();
  const tipo = String(d?.tipo || "REGULAR").trim().toUpperCase();
  const nomeUpper = String(d?.nome || "").trim().toUpperCase();

  if (modo === "AGRUPAMENTO") return false;
  if (["IFA", "ELETIVA", "PROJETO"].includes(tipo)) return false;
  if (nomeUpper.startsWith("IFA_") || nomeUpper.startsWith("IFA ") || nomeUpper.startsWith("IFA-")) {
    return false;
  }
  return true;
}

/**
 * Handler compartilhado: GET /conteudos/disciplinas
 */
export async function handleGetConteudosDisciplinas(db, req, res) {
  const alunoId = Number(req.query.aluno_id);

  if (!alunoId || Number.isNaN(alunoId)) {
    return res.status(400).json({ message: "aluno_id é obrigatório." });
  }

  try {
    // ── DEMO-APPLE bypass ────────────────────────────────────────────────────
    if (req.appPaisAuth?.cpf === "00000000019") {
      return res.json({
        ok: true,
        regime: "anual",
        semestre_atual: 1,
        semestre_selecionado: 1,
        disciplinas: [
          { id: 1, nome: "Português" },
          { id: 2, nome: "Matemática" },
          { id: 3, nome: "Ciências" },
          { id: 4, nome: "História" },
          { id: 5, nome: "Geografia" },
          { id: 6, nome: "Artes" },
          { id: 7, nome: "Educação Física" },
        ],
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const anoLetivo = req.query.ano_letivo
      ? Number(req.query.ano_letivo)
      : new Date().getFullYear();

    const ctx = await resolverContextoConteudosAluno(db, req, alunoId, anoLetivo);
    if (ctx.forbidden) {
      return res.status(403).json({ message: "Acesso negado para este aluno." });
    }

    const semParam = Number(req.query.semestre);
    const semestreEfetivo =
      ctx.regime === "semestral"
        ? semParam === 1 || semParam === 2
          ? semParam
          : ctx.semestreAtual
        : 1;

    // Catálogo completo de disciplinas da escola (para resolver mesclada_em e metadados)
    let catalogoRows = [];
    try {
      const [rows] = await db.query(
        `SELECT id, nome, etapa, tipo, modo_oferta, mesclada_em
           FROM disciplinas
          WHERE escola_id = ?`,
        [ctx.escolaId]
      );
      catalogoRows = rows || [];
    } catch {
      const [rowsFallback] = await db.query(
        `SELECT id, nome, etapa, 'REGULAR' AS tipo, 'TURMA' AS modo_oferta, NULL AS mesclada_em
           FROM disciplinas
          WHERE escola_id = ?`,
        [ctx.escolaId]
      );
      catalogoRows = rowsFallback || [];
    }

    const discById = new Map(catalogoRows.map((d) => [Number(d.id), d]));

    const resolverCanonico = (rawId) => {
      let atual = discById.get(Number(rawId));
      const visitados = new Set();
      while (atual && atual.mesclada_em && !visitados.has(Number(atual.id))) {
        visitados.add(Number(atual.id));
        const pai = discById.get(Number(atual.mesclada_em));
        if (!pai) break;
        atual = pai;
      }
      return atual || null;
    };

    const idsColetados = new Set();
    let temCargasNoSemestre = false;

    // 1) Cargas horárias regulares da turma no semestre ativo
    if (ctx.turmaId) {
      try {
        const [tcRows] = await db.query(
          `SELECT tc.disciplina_id
             FROM turma_cargas tc
            WHERE tc.escola_id = ?
              AND tc.turma_id = ?
              AND tc.semestre = ?`,
          [ctx.escolaId, ctx.turmaId, semestreEfetivo]
        );
        for (const r of tcRows || []) {
          const d = resolverCanonico(r.disciplina_id);
          if (d && isDisciplinaRegularDaTurma(d)) {
            idsColetados.add(Number(d.id));
            temCargasNoSemestre = true;
          }
        }
      } catch (err) {
        console.warn("[CONTEUDOS_MOBILE] Aviso turma_cargas:", err.message);
      }

      // 2) Modulação regular da turma
      try {
        if (ctx.regime === "anual") {
          const [modRows] = await db.query(
            `SELECT DISTINCT m.disciplina_id
               FROM modulacao m
              WHERE m.escola_id = ?
                AND m.turma_id = ?`,
            [ctx.escolaId, ctx.turmaId]
          );
          for (const r of modRows || []) {
            const d = resolverCanonico(r.disciplina_id);
            if (d && isDisciplinaRegularDaTurma(d)) {
              idsColetados.add(Number(d.id));
            }
          }
        } else {
          // Regime semestral: prioriza estritamente m.semestre = semestreEfetivo
          const [modSemRows] = await db.query(
            `SELECT DISTINCT m.disciplina_id
               FROM modulacao m
              WHERE m.escola_id = ?
                AND m.turma_id = ?
                AND m.semestre = ?`,
            [ctx.escolaId, ctx.turmaId, semestreEfetivo]
          );
          for (const r of modSemRows || []) {
            const d = resolverCanonico(r.disciplina_id);
            if (d && isDisciplinaRegularDaTurma(d)) {
              idsColetados.add(Number(d.id));
            }
          }

          // Fallback apenas se a turma não tiver turma_cargas nem modulação explícita no semestre
          if (!temCargasNoSemestre && (!modSemRows || modSemRows.length === 0)) {
            const [modZeroRows] = await db.query(
              `SELECT DISTINCT m.disciplina_id
                 FROM modulacao m
                WHERE m.escola_id = ?
                  AND m.turma_id = ?
                  AND (m.semestre IS NULL OR m.semestre = 0)`,
              [ctx.escolaId, ctx.turmaId]
            );
            for (const r of modZeroRows || []) {
              const d = resolverCanonico(r.disciplina_id);
              if (d && isDisciplinaRegularDaTurma(d)) {
                idsColetados.add(Number(d.id));
              }
            }
          }
        }
      } catch (err) {
        console.warn("[CONTEUDOS_MOBILE] Aviso modulacao:", err.message);
      }
    }

    // 3) Agrupamentos / Projetos / IFAs / Eletivas em que ESTE estudante está ativo no semestre
    try {
      const sqlAgrup = `
        SELECT DISTINCT
          ac.disciplina_id AS comp_disc_id,
          ep.disciplina_id AS proj_disc_id
        FROM agrupamento_alunos aa
        INNER JOIN agrupamentos g ON g.id = aa.agrupamento_id
        LEFT JOIN agrupamento_componentes ac ON ac.agrupamento_id = g.id
        LEFT JOIN em_projetos ep ON ep.id = g.projeto_id
        WHERE aa.escola_id = ?
          AND aa.aluno_id = ?
          AND aa.status = 'ativo'
          AND g.ano_letivo = ?
          AND g.status <> 'ENCERRADO'
          ${ctx.regime === "semestral" ? "AND (g.semestre IS NULL OR g.semestre = 0 OR g.semestre = ?)" : ""}
      `;
      const paramsAgrup =
        ctx.regime === "semestral"
          ? [ctx.escolaId, alunoId, anoLetivo, semestreEfetivo]
          : [ctx.escolaId, alunoId, anoLetivo];

      const [agRows] = await db.query(sqlAgrup, paramsAgrup);
      for (const r of agRows || []) {
        for (const candId of [r.comp_disc_id, r.proj_disc_id]) {
          if (!candId) continue;
          const d = resolverCanonico(candId);
          if (d) idsColetados.add(Number(d.id));
        }
      }
    } catch {
      try {
        const sqlAgrupFallback = `
          SELECT DISTINCT ac.disciplina_id AS comp_disc_id
          FROM agrupamento_alunos aa
          INNER JOIN agrupamentos g ON g.id = aa.agrupamento_id
          INNER JOIN agrupamento_componentes ac ON ac.agrupamento_id = g.id
          WHERE aa.escola_id = ?
            AND aa.aluno_id = ?
            AND aa.status = 'ativo'
            AND g.ano_letivo = ?
            AND g.status <> 'ENCERRADO'
            ${ctx.regime === "semestral" ? "AND (g.semestre IS NULL OR g.semestre = 0 OR g.semestre = ?)" : ""}
        `;
        const paramsAgrupFallback =
          ctx.regime === "semestral"
            ? [ctx.escolaId, alunoId, anoLetivo, semestreEfetivo]
            : [ctx.escolaId, alunoId, anoLetivo];
        const [agRowsFb] = await db.query(sqlAgrupFallback, paramsAgrupFallback);
        for (const r of agRowsFb || []) {
          const d = resolverCanonico(r.comp_disc_id);
          if (d) idsColetados.add(Number(d.id));
        }
      } catch (err2) {
        console.warn("[CONTEUDOS_MOBILE] Aviso agrupamento_alunos:", err2.message);
      }
    }

    // 4) Notas já lançadas para ESTE estudante no ano/semestre (preserva histórico semestral fiel ao Boletim)
    try {
      const filtroBimNotas =
        ctx.regime === "semestral"
          ? semestreEfetivo === 1
            ? "AND n.bimestre IN (1, 2)"
            : "AND n.bimestre IN (3, 4)"
          : "";
      const [notaRows] = await db.query(
        `SELECT DISTINCT n.disciplina_id
           FROM notas n
          WHERE n.escola_id = ?
            AND n.aluno_id = ?
            AND n.ano = ?
            ${filtroBimNotas}`,
        [ctx.escolaId, alunoId, anoLetivo]
      );
      for (const r of notaRows || []) {
        const d = resolverCanonico(r.disciplina_id);
        if (d) idsColetados.add(Number(d.id));
      }
    } catch (err) {
      console.warn("[CONTEUDOS_MOBILE] Aviso notas:", err.message);
    }

    // 5) Fallback seguro caso a turma recém-criada ainda não tenha carga, modulação nem notas
    if (idsColetados.size === 0) {
      for (const d of catalogoRows) {
        if (d.mesclada_em) continue;
        if (!isDisciplinaRegularDaTurma(d)) continue;

        const dEtapaNorm = normTxt(d.etapa);
        const dNomeNorm = normNomeDisciplinaKey(d.nome);

        if (ctx.isEnsinoMedio) {
          if (
            dEtapaNorm.includes("fund") ||
            dEtapaNorm.includes("inicia") ||
            dEtapaNorm.includes("finais")
          ) {
            continue;
          }
          if (dNomeNorm === "ciencias" || dNomeNorm === "ciencias naturais") {
            continue;
          }
        } else if (dEtapaNorm.includes("medio")) {
          continue;
        }

        idsColetados.add(Number(d.id));
      }
    }

    // Identifica quais disciplinas possuem conteúdos salvos no ano letivo (desempate inteligente)
    const idsComConteudo = new Set();
    try {
      const [cRows] = await db.query(
        `SELECT DISTINCT disciplina_id
           FROM conteudos_objetivos_escola
          WHERE escola_id = ? AND ano_letivo = ? AND ativo = 1`,
        [ctx.escolaId, anoLetivo]
      );
      for (const r of cRows || []) {
        idsComConteudo.add(Number(r.disciplina_id));
      }
    } catch {}

    // Deduplicação insensível a acentos/caixa ("Educação Física" vs "EDUCAÇÃO FÍSICA")
    const porChaveNome = new Map();
    for (const id of idsColetados) {
      const d = discById.get(Number(id));
      if (!d || !d.nome) continue;

      const key = normNomeDisciplinaKey(d.nome);
      if (!key) continue;

      const candidato = {
        id: Number(d.id),
        nome: String(d.nome).trim(),
        temConteudo: idsComConteudo.has(Number(d.id)),
        canonica: !d.mesclada_em,
      };

      const existente = porChaveNome.get(key);
      if (!existente) {
        porChaveNome.set(key, candidato);
      } else {
        const scoreCand = (candidato.canonica ? 4 : 0) + (candidato.temConteudo ? 2 : 0);
        const scoreExist = (existente.canonica ? 4 : 0) + (existente.temConteudo ? 2 : 0);
        if (scoreCand > scoreExist || (scoreCand === scoreExist && candidato.id < existente.id)) {
          porChaveNome.set(key, candidato);
        }
      }
    }

    const disciplinas = Array.from(porChaveNome.values())
      .map(({ id, nome }) => ({ id, nome }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));

    return res.json({
      ok: true,
      regime: ctx.regime,
      semestre_atual: ctx.semestreAtual,
      semestre_selecionado: semestreEfetivo,
      turma_id: ctx.turmaId,
      etapa: ctx.etapa || null,
      disciplinas,
    });
  } catch (error) {
    console.error("[CONTEUDOS_MOBILE] Erro em GET /conteudos/disciplinas:", error);
    return res.status(500).json({ message: "Erro ao carregar disciplinas." });
  }
}

export function parseObjetivoTextoEstruturado(texto) {
  if (!texto) return [];
  const topicos = [];
  let atual = null;

  for (const linha of String(texto).split("\n")) {
    const tMatch = linha.match(/^\s*\d+[.)]\s+(.+)/);
    const sMatch = linha.match(/^\s*[*\-]\s+(.+)/) || linha.match(/^\s*\u2022\s+(.+)/);

    if (tMatch) {
      atual = { texto: tMatch[1].trim(), subitens: [] };
      topicos.push(atual);
    } else if (sMatch && atual) {
      const sub = sMatch[1].trim();
      if (sub) atual.subitens.push(sub);
    } else {
      const raw = linha.replace(/^[*\-\u2022]\s*/, "").trim();
      if (!raw) continue;
      if (!atual) {
        atual = { texto: raw, subitens: [] };
        topicos.push(atual);
      } else if (raw !== atual.texto) {
        if (/^\s{2,}/.test(linha)) {
          atual.subitens.push(raw);
        } else {
          atual = { texto: raw, subitens: [] };
          topicos.push(atual);
        }
      }
    }
  }

  return topicos;
}

/**
 * Handler compartilhado: GET /conteudos
 */
export async function handleGetConteudos(db, req, res) {
  try {
    const alunoId = Number(req.query.aluno_id);
    const disciplinaId = Number(req.query.disciplina_id);
    const bimestre = Number(req.query.bimestre);
    const anoLetivo = req.query.ano_letivo
      ? Number(req.query.ano_letivo)
      : new Date().getFullYear();

    if (!alunoId || Number.isNaN(alunoId)) {
      return res.status(400).json({ message: "Parâmetro aluno_id inválido." });
    }
    if (!disciplinaId || Number.isNaN(disciplinaId)) {
      return res.status(400).json({ message: "Parâmetro disciplina_id inválido." });
    }

    // ── DEMO-APPLE bypass ────────────────────────────────────────────────────
    if (req.appPaisAuth?.cpf === "00000000019") {
      const DEMO_OBJETIVOS = {
        1: [
          {
            texto: "Compreender os diferentes gêneros textuais e suas funções comunicativas",
            subitens: [
              "Narrativo: conto, crônica, fábula",
              "Descritivo: descrição de pessoas e lugares",
              "Argumentativo: artigo de opinião",
            ],
          },
          {
            texto: "Desenvolver habilidades de leitura e interpretação de texto",
            subitens: ["Identificação de tema central", "Inferências e conclusões"],
          },
        ],
        2: [
          {
            texto: "Dominar as operações fundamentais com números naturais e inteiros",
            subitens: [
              "Adição e subtração de inteiros",
              "Multiplicação e divisão",
              "Potenciação e radiciação",
            ],
          },
          {
            texto: "Resolver situações-problema do cotidiano usando operações básicas",
            subitens: [],
          },
        ],
        3: [
          {
            texto: "Analisar fenômenos naturais e suas relações com o cotidiano",
            subitens: [
              "Ciclo da água e clima",
              "Ecossistemas brasileiros",
              "Biodiversidade e preservação",
            ],
          },
        ],
        4: [
          {
            texto: "Consolidar os aprendizados do ano letivo com foco em revisão e aplicação",
            subitens: [
              "Revisão dos principais conteúdos",
              "Avaliação prática e contextualizada",
            ],
          },
        ],
      };

      return res.json({
        ok: true,
        ref: {
          escola_id: null,
          turma_id: null,
          disciplina_id: disciplinaId,
          bimestre,
          ano_letivo: anoLetivo,
        },
        objetivos: DEMO_OBJETIVOS[bimestre] || DEMO_OBJETIVOS[1],
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!bimestre || Number.isNaN(bimestre) || bimestre < 1 || bimestre > 4) {
      return res.status(400).json({ message: "Parâmetro bimestre inválido (1..4)." });
    }
    if (!anoLetivo || Number.isNaN(anoLetivo)) {
      return res.status(400).json({ message: "Parâmetro ano_letivo inválido." });
    }

    const ctx = await resolverContextoConteudosAluno(db, req, alunoId, anoLetivo);
    if (ctx.forbidden) {
      return res.status(403).json({ message: "Acesso negado para este aluno." });
    }

    if (!ctx.turmaId && !ctx.serie && !ctx.turmaNome) {
      return res.json({
        ok: true,
        ref: {
          escola_id: ctx.escolaId,
          turma_id: null,
          disciplina_id: disciplinaId,
          bimestre,
          ano_letivo: anoLetivo,
        },
        objetivos: [],
      });
    }

    // Expande IDs equivalentes da disciplina na escola (mesclagens + homônimas com/sem acento)
    let discRows = [];
    try {
      const [rows] = await db.query(
        `SELECT id, nome, tipo, modo_oferta, mesclada_em
           FROM disciplinas
          WHERE escola_id = ?`,
        [ctx.escolaId]
      );
      discRows = rows || [];
    } catch {
      const [rowsFb] = await db.query(
        `SELECT id, nome, 'REGULAR' AS tipo, 'TURMA' AS modo_oferta, NULL AS mesclada_em
           FROM disciplinas
          WHERE escola_id = ?`,
        [ctx.escolaId]
      );
      discRows = rowsFb || [];
    }

    const alvo = discRows.find((d) => Number(d.id) === disciplinaId);
    const idsEquivalentes = new Set([disciplinaId]);
    let isDisciplinaMultisserieAgrupamento = false;

    if (alvo) {
      isDisciplinaMultisserieAgrupamento = !isDisciplinaRegularDaTurma(alvo);
      const rootId = alvo.mesclada_em ? Number(alvo.mesclada_em) : Number(alvo.id);
      const chaveNomeAlvo = normNomeDisciplinaKey(alvo.nome);

      idsEquivalentes.add(rootId);
      for (const d of discRows) {
        const dId = Number(d.id);
        const dPai = d.mesclada_em ? Number(d.mesclada_em) : null;
        if (
          dId === rootId ||
          dPai === rootId ||
          dPai === disciplinaId ||
          (chaveNomeAlvo && normNomeDisciplinaKey(d.nome) === chaveNomeAlvo)
        ) {
          idsEquivalentes.add(dId);
        }
      }
    }

    const listaDiscIds = Array.from(idsEquivalentes);
    const textosBrutos = [];

    // Fonte 1 (Principal): conteudos_objetivos_escola (+ fallback seedf_conteudos)
    try {
      const [coeRows] = await db.query(
        `SELECT
           coe.id,
           coe.serie,
           COALESCE(NULLIF(TRIM(coe.texto), ''), NULLIF(TRIM(sc.texto), '')) AS objetivo_texto
         FROM conteudos_objetivos_escola coe
         LEFT JOIN seedf_conteudos sc ON sc.id = coe.seedf_conteudo_id
         WHERE coe.escola_id = ?
           AND coe.disciplina_id IN (?)
           AND coe.ano_letivo = ?
           AND coe.bimestre = ?
           AND coe.ativo = 1
         ORDER BY coe.id ASC
         LIMIT 300`,
        [ctx.escolaId, listaDiscIds, anoLetivo, bimestre]
      );

      const filtradosSerie = (coeRows || []).filter(
        (r) => r.objetivo_texto && serieCorrespondeConteudo(r.serie, ctx)
      );

      if (filtradosSerie.length > 0) {
        textosBrutos.push(...filtradosSerie.map((r) => r.objetivo_texto));
      } else if (isDisciplinaMultisserieAgrupamento && ctx.isEnsinoMedio && (coeRows || []).length > 0) {
        // Turmas de agrupamento multissérie (ex.: IFA 1ª/2ª/3ª Série): aceita registro salvo em qualquer série do EM
        for (const r of coeRows) {
          if (r.objetivo_texto) textosBrutos.push(r.objetivo_texto);
        }
      }
    } catch (err) {
      console.warn("[CONTEUDOS_MOBILE] Aviso conteudos_objetivos_escola:", err.message);
    }

    // Fonte 2 (Compatibilidade legada): conteudos_plano_itens
    try {
      const [planoRows] = await db.query(
        `SELECT
           id,
           serie,
           objetivo_texto
         FROM conteudos_plano_itens
         WHERE escola_id = ?
           AND disciplina_id IN (?)
           AND ano_letivo = ?
           AND bimestre = ?
           AND objetivo_texto IS NOT NULL
           AND TRIM(objetivo_texto) != ''
         ORDER BY id ASC
         LIMIT 300`,
        [ctx.escolaId, listaDiscIds, anoLetivo, bimestre]
      );

      for (const r of planoRows || []) {
        if (r.objetivo_texto && serieCorrespondeConteudo(r.serie, ctx)) {
          textosBrutos.push(r.objetivo_texto);
        }
      }
    } catch {
      // Tabela legada opcional
    }

    // Estrutura e deduplica objetivos mantendo ordem de inserção
    const mapaTopicos = new Map();
    for (const raw of textosBrutos) {
      const parsed = parseObjetivoTextoEstruturado(raw);
      for (const item of parsed) {
        const chave = normTxt(item.texto);
        if (!chave) continue;
        const existente = mapaTopicos.get(chave);
        if (!existente) {
          mapaTopicos.set(chave, {
            texto: item.texto,
            subitens: Array.isArray(item.subitens) ? [...item.subitens] : [],
          });
        } else if (Array.isArray(item.subitens)) {
          const setSub = new Set(existente.subitens.map((s) => normTxt(s)));
          for (const sub of item.subitens) {
            const subKey = normTxt(sub);
            if (subKey && !setSub.has(subKey)) {
              setSub.add(subKey);
              existente.subitens.push(sub);
            }
          }
        }
      }
    }

    const objetivos = Array.from(mapaTopicos.values());

    return res.json({
      ok: true,
      ref: {
        escola_id: ctx.escolaId,
        turma_id: ctx.turmaId,
        disciplina_id: disciplinaId,
        bimestre,
        ano_letivo: anoLetivo,
      },
      objetivos,
    });
  } catch (error) {
    console.error("[CONTEUDOS_MOBILE] Erro em GET /conteudos:", error);
    return res.status(500).json({ message: "Erro ao carregar conteúdos." });
  }
}
