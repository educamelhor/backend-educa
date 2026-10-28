// apps/educa-backend/utils/disciplinasHelper.js
// ============================================================================
// HELPER UNIVERSAL DE DISCIPLINA, ALIASES E RECONCILIAÇÃO DE NOTAS
// Garante 100% de consistência entre Secretaria, Agente, Conselho e Boletins
// ============================================================================

export const SEEDF_CANONICAL_ALIASES = [
  {
    canon: "PARTE DIVERSIFICADA I",
    aliases: [
      "PARTE DIVERSIFICADA I", "PRATICA DIVERSIFICADA I", "PRATICAS DIVERSIFICADAS I",
      "PRATICA DIVERSIFICADA 1", "PRATICAS DIVERSIFICADAS 1", "PARTE DIVERSIFICADA 1",
      "PD1", "PD 1", "PD I", "PARTE DIV I", "PARTE DIV 1"
    ]
  },
  {
    canon: "PARTE DIVERSIFICADA II",
    aliases: [
      "PARTE DIVERSIFICADA II", "PRATICA DIVERSIFICADA II", "PRATICAS DIVERSIFICADAS II",
      "PRATICA DIVERSIFICADA 2", "PRATICAS DIVERSIFICADAS 2", "PARTE DIVERSIFICADA 2",
      "PD2", "PD 2", "PD II", "PARTE DIV II", "PARTE DIV 2"
    ]
  },
  {
    canon: "PARTE DIVERSIFICADA III",
    aliases: [
      "PARTE DIVERSIFICADA III", "PRATICA DIVERSIFICADA III", "PRATICAS DIVERSIFICADAS III",
      "PRATICA DIVERSIFICADA 3", "PRATICAS DIVERSIFICADAS 3", "PARTE DIVERSIFICADA 3",
      "PD3", "PD 3", "PD III", "PARTE DIV III", "PARTE DIV 3"
    ]
  },
  {
    canon: "LÍNGUA PORTUGUESA",
    aliases: ["LINGUA PORTUGUESA", "PORTUGUES", "PORTUGUESA", "LP", "L PORTUGUESA", "L. PORTUGUESA", "PORT"]
  },
  {
    canon: "MATEMÁTICA",
    aliases: ["MATEMATICA", "MAT"]
  },
  {
    canon: "CIÊNCIAS NATURAIS",
    aliases: ["CIENCIAS NATURAIS", "CIENCIAS", "CIENCIA", "CN", "CIE"]
  },
  {
    canon: "EDUCAÇÃO FÍSICA",
    aliases: ["EDUCACAO FISICA", "ED FISICA", "ED. FISICA", "EF", "ED_FISICA"]
  },
  {
    canon: "HISTÓRIA",
    aliases: ["HISTORIA", "HIST"]
  },
  {
    canon: "GEOGRAFIA",
    aliases: ["GEOGRAFIA", "GEO"]
  },
  {
    canon: "ARTES",
    aliases: ["ARTES", "ARTE", "ART"]
  },
  {
    canon: "LEM/INGLÊS",
    aliases: ["LEM/INGLES", "INGLES", "LEM INGLES", "LINGUA INGLESA", "LÍNGUA INGLESA", "LINGUA ESTRANGEIRA INGLES", "ING"]
  },
  {
    canon: "LEM/ESPANHOL",
    aliases: ["LEM/ESPANHOL", "ESPANHOL", "LEM ESPANHOL", "LINGUA ESPANHOLA", "LÍNGUA ESPANHOLA", "ESP"]
  },
  {
    canon: "ENSINO RELIGIOSO",
    aliases: ["ENSINO RELIGIOSO", "RELIGIAO", "ER"]
  },
  {
    canon: "BIOLOGIA",
    aliases: ["BIOLOGIA", "BIO"]
  },
  {
    canon: "FÍSICA",
    aliases: ["FISICA", "FIS"]
  },
  {
    canon: "QUÍMICA",
    aliases: ["QUIMICA", "QUI"]
  },
  {
    canon: "FILOSOFIA",
    aliases: ["FILOSOFIA", "FIL"]
  },
  {
    canon: "SOCIOLOGIA",
    aliases: ["SOCIOLOGIA", "SOC"]
  },
  {
    canon: "PROJETO DE VIDA",
    aliases: ["PROJETO DE VIDA", "PV"]
  }
];

export const norm = (s) => (s || "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toUpperCase().replace(/[^A-Z0-9]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Encontra a disciplina correspondente em uma lista dada
 * Prioridade:
 * 1. nome_oficial (modal de mapeamento global)
 * 2. nome exato / normalizado
 * 3. abreviatura
 * 4. aliases canônicos da SEEDF
 */
export function resolverDisciplina(discNameRaw, listaDisciplinas) {
  if (!discNameRaw || !Array.isArray(listaDisciplinas) || listaDisciplinas.length === 0) return null;
  const targetNorm = norm(discNameRaw);

  // 1. Prioridade Máxima: nome_oficial configurado pela escola no modal
  for (const d of listaDisciplinas) {
    if (d.nome_oficial && norm(d.nome_oficial) === targetNorm) {
      return d;
    }
  }

  // 2. Segunda Prioridade: nome local exato/normalizado da disciplina
  for (const d of listaDisciplinas) {
    if (d.nome && norm(d.nome) === targetNorm) {
      return d;
    }
  }

  // 3. Terceira Prioridade: abreviatura da disciplina
  for (const d of listaDisciplinas) {
    if (d.abreviatura && norm(d.abreviatura) === targetNorm) {
      return d;
    }
  }

  // 4. Quarta Prioridade: Busca via grupo canônico da SEEDF
  for (const group of SEEDF_CANONICAL_ALIASES) {
    const allVariants = [norm(group.canon), ...group.aliases.map(norm)];
    if (allVariants.includes(targetNorm)) {
      for (const d of listaDisciplinas) {
        const dNomeNorm = norm(d.nome);
        const dOficNorm = norm(d.nome_oficial);
        const dAbrevNorm = norm(d.abreviatura);
        if (
          allVariants.includes(dNomeNorm) ||
          (dOficNorm && allVariants.includes(dOficNorm)) ||
          (dAbrevNorm && allVariants.includes(dAbrevNorm))
        ) {
          return d;
        }
      }
    }
  }

  return null;
}

/**
 * Retorna todos os IDs de disciplinas da escola que são equivalentes a targetDisc
 */
export function resolverIdsEquivalentes(targetDisc, listaDisciplinas) {
  if (!targetDisc) return [];
  const ids = new Set();
  const baseId = Number(targetDisc.id ?? targetDisc.disciplina_id);
  if (!isNaN(baseId) && baseId > 0) {
    ids.add(baseId);
  }

  if (!Array.isArray(listaDisciplinas)) return [...ids];

  const tNomeNorm = norm(targetDisc.nome);
  const tOficNorm = norm(targetDisc.nome_oficial);
  const tAbrevNorm = norm(targetDisc.abreviatura);

  // Encontra grupos canônicos aos quais targetDisc pertence
  const matchingCanonicalGroups = [];
  for (const group of SEEDF_CANONICAL_ALIASES) {
    const allVariants = [norm(group.canon), ...group.aliases.map(norm)];
    if (
      (tNomeNorm && allVariants.includes(tNomeNorm)) ||
      (tOficNorm && allVariants.includes(tOficNorm)) ||
      (tAbrevNorm && allVariants.includes(tAbrevNorm))
    ) {
      matchingCanonicalGroups.push(allVariants);
    }
  }

  for (const d of listaDisciplinas) {
    const dId = Number(d.id ?? d.disciplina_id);
    if (isNaN(dId) || dId <= 0) continue;
    if (dId === baseId) {
      ids.add(dId);
      continue;
    }

    const dNomeNorm = norm(d.nome);
    const dOficNorm = norm(d.nome_oficial);
    const dAbrevNorm = norm(d.abreviatura);

    // 1. Mesmo nome
    if (dNomeNorm && dNomeNorm === tNomeNorm) {
      ids.add(dId);
      continue;
    }
    // 2. nome_oficial cruzado
    if (tOficNorm && (dNomeNorm === tOficNorm || dOficNorm === tOficNorm)) {
      ids.add(dId);
      continue;
    }
    if (dOficNorm && dOficNorm === tNomeNorm) {
      ids.add(dId);
      continue;
    }
    // 3. abreviatura cruzada
    if (tAbrevNorm && (dAbrevNorm === tAbrevNorm || dNomeNorm === tAbrevNorm)) {
      ids.add(dId);
      continue;
    }
    if (dAbrevNorm && dAbrevNorm === tNomeNorm) {
      ids.add(dId);
      continue;
    }

    // 4. Aliases canônicos
    let matchedGroup = false;
    for (const groupVariants of matchingCanonicalGroups) {
      if (
        (dNomeNorm && groupVariants.includes(dNomeNorm)) ||
        (dOficNorm && groupVariants.includes(dOficNorm)) ||
        (dAbrevNorm && groupVariants.includes(dAbrevNorm))
      ) {
        ids.add(dId);
        matchedGroup = true;
        break;
      }
    }
    if (matchedGroup) continue;
  }

  return [...ids];
}

/**
 * Reconcilia registros da tabela `notas` com a modulação da turma do aluno.
 * Se uma nota foi lançada para um disciplina_id equivalente mas diferente
 * do configurado na modulação daquela turma, atualiza o disciplina_id para
 * coincidir com o da modulação.
 */
export async function reconciliarNotasComModulacao(pool, escola_id) {
  if (!escola_id) return 0;
  try {
    // 1. Buscar todas as modulações ativas da escola
    const [modulacoes] = await pool.query(
      `SELECT mo.turma_id, mo.disciplina_id, mo.semestre, d.nome, d.nome_oficial, d.abreviatura, t.regime
       FROM modulacao mo
       JOIN disciplinas d ON d.id = mo.disciplina_id
       LEFT JOIN turmas t ON t.id = mo.turma_id
       WHERE mo.escola_id = ? AND mo.turma_id IS NOT NULL`,
      [escola_id]
    );

    if (!modulacoes.length) return 0;

    // 2. Buscar todas as disciplinas da escola
    const [todasDiscs] = await pool.query(
      `SELECT id, nome, nome_oficial, abreviatura FROM disciplinas WHERE escola_id = ?`,
      [escola_id]
    );

    let totalAtualizados = 0;

    for (const mod of modulacoes) {
      const eqIds = resolverIdsEquivalentes(mod, todasDiscs);
      const otherIds = eqIds.filter(id => id !== Number(mod.disciplina_id));
      if (!otherIds.length) continue;

      // Alunos da turma (por alunos.turma_id ou matriculas)
      const [alunos] = await pool.query(
        `SELECT DISTINCT a.id 
         FROM alunos a
         LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.status = 'ativo'
         WHERE (a.turma_id = ? OR m.turma_id = ?) AND a.escola_id = ?`,
        [mod.turma_id, mod.turma_id, escola_id]
      );

      if (!alunos.length) continue;
      const alunoIds = alunos.map(a => a.id);

      // Se turma for semestral, restringe aos bimestres do semestre da modulação
      let bimCondition = "";
      if (mod.regime === "semestral") {
        bimCondition = Number(mod.semestre) === 2 ? " AND bimestre IN (3, 4)" : " AND bimestre IN (1, 2)";
      }

      // Busca notas desses alunos com outros IDs equivalentes
      const [notasParaMigrar] = await pool.query(
        `SELECT id, aluno_id, ano, bimestre, disciplina_id, nota, faltas
         FROM notas
         WHERE escola_id = ?
           AND aluno_id IN (?)
           AND disciplina_id IN (?)${bimCondition}`,
        [escola_id, alunoIds, otherIds]
      );

      for (const n of notasParaMigrar) {
        // Verifica se já existe nota para o disciplina_id da modulação
        const [[jaExiste]] = await pool.query(
          `SELECT id, nota, faltas FROM notas
           WHERE escola_id = ? AND aluno_id = ? AND ano = ? AND bimestre = ? AND disciplina_id = ? LIMIT 1`,
          [escola_id, n.aluno_id, n.ano, n.bimestre, mod.disciplina_id]
        );

        if (!jaExiste) {
          // Pode simplesmente atualizar o disciplina_id
          await pool.query(
            `UPDATE notas SET disciplina_id = ? WHERE id = ?`,
            [mod.disciplina_id, n.id]
          );
          totalAtualizados++;
        } else {
          // Já existe uma nota para o ID da modulação.
          if ((jaExiste.nota == null || jaExiste.nota === "") && (n.nota != null && n.nota !== "")) {
            // Se a existente estiver nula e a antiga tiver valor, atualiza a existente
            await pool.query(
              `UPDATE notas SET nota = ?, faltas = COALESCE(?, faltas) WHERE id = ?`,
              [n.nota, n.faltas, jaExiste.id]
            );
            await pool.query(`DELETE FROM notas WHERE id = ?`, [n.id]);
            totalAtualizados++;
          } else if (String(jaExiste.nota) === String(n.nota) && Number(jaExiste.faltas || 0) === Number(n.faltas || 0)) {
            // Se nota e faltas forem exatamente idênticas, remove a duplicata redundante
            await pool.query(`DELETE FROM notas WHERE id = ?`, [n.id]);
            totalAtualizados++;
          } else {
            // DIVERGÊNCIA DE NOTAS: NUNCA apagar silenciosamente. Registrar na fila de conflitos!
            await pool.query(
              `INSERT IGNORE INTO migracao_conflitos_notas 
               (escola_id, aluno_id, ano, bimestre, disciplina_nome, nota_id_1, nota_id_2, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'ABERTO')`,
              [escola_id, n.aluno_id, n.ano, n.bimestre, mod.nome, jaExiste.id, n.id]
            );
            console.warn(`[RECONCILIAÇÃO NOTAS] Conflito retido entre nota ${jaExiste.id} e ${n.id} do aluno ${n.aluno_id} (${mod.nome}). Nenhuma nota foi apagada.`);
          }
        }
      }
    }

    if (totalAtualizados > 0) {
      console.log(`[RECONCILIAÇÃO NOTAS] Escola ${escola_id}: ${totalAtualizados} notas reconciliadas com a modulação.`);
    }
    return totalAtualizados;
  } catch (err) {
    console.error(`[RECONCILIAÇÃO NOTAS] Erro na escola ${escola_id}:`, err.message);
    return 0;
  }
}

/**
 * Calcula o total de notas do diário de um aluno seguindo exatamente a mesma regra
 * oficial de `POST /api/avaliacoes/:id/exportar-boletim` (oportunidades, RC, RCp, ausente, ponto extra).
 */
export function calcularTotalDiarioAluno(arrItens, mapaNotas) {
  if (!arrItens || arrItens.length === 0) {
    let total = 0;
    for (const entry of Object.values(mapaNotas)) {
      if (entry && !isNaN(entry.nota) && entry.cor !== "ausente") {
        total += entry.nota;
      }
    }
    return {
      total: Math.min(10, Math.max(0, Math.round(total * 100) / 100)),
      itensAvaliados: Object.keys(mapaNotas).length,
      totalItensRegulares: 0,
    };
  }

  let totalRegular = 0;
  let totalExtra = 0;
  let itensAvaliados = 0;
  let totalItensRegulares = 0;

  arrItens.forEach((item, itemIdx) => {
    const isExtra = !!item.ponto_extra || !!item.eh_ponto_extra || item.tipo_avaliacao === "Ponto Extra";
    const isFixo = !!item.fixo_direcao;

    if (isFixo) {
      totalItensRegulares++;
      const entry = mapaNotas[`${itemIdx}_0`];
      if (entry && entry.nota !== null && !isNaN(entry.nota)) {
        totalRegular += entry.nota;
        itensAvaliados++;
      }
      return;
    }

    if (isExtra) {
      const entry = mapaNotas[`${itemIdx}_0`];
      if (entry && entry.nota !== null && !isNaN(entry.nota)) {
        totalExtra += entry.nota;
      }
      return;
    }

    totalItensRegulares++;
    const freq = Number(item.oportunidades) || 1;
    let avaliadoNesteItem = false;
    for (let opIdx = 0; opIdx < freq; opIdx++) {
      const entryOrig = mapaNotas[`${itemIdx}_${opIdx}`];
      const isAusente = entryOrig?.cor === "ausente";
      const numOrig = (!isAusente && entryOrig && entryOrig.nota !== null && !isNaN(entryOrig.nota)) ? entryOrig.nota : null;

      const rcOpIdx = freq > 1 ? 100 + opIdx : 1;
      const entryRC = mapaNotas[`${itemIdx}_${rcOpIdx}`] || (freq === 1 ? mapaNotas[`${itemIdx}_100`] : null);
      const numRC = (entryRC && entryRC.nota !== null && !isNaN(entryRC.nota)) ? entryRC.nota : null;

      const rcpOpIdx = freq > 1 ? 200 + opIdx : 2;
      const entryRCp = mapaNotas[`${itemIdx}_${rcpOpIdx}`] || (freq === 1 ? mapaNotas[`${itemIdx}_200`] : null);
      const numRCp = (entryRCp && entryRCp.nota !== null && !isNaN(entryRCp.nota)) ? entryRCp.nota : null;

      if (isAusente) {
        avaliadoNesteItem = true;
        if (numRCp !== null) {
          totalRegular += numRCp;
        }
        continue;
      }

      const candidatos = [numOrig, numRC, numRCp].filter(n => n !== null);
      if (candidatos.length > 0) {
        avaliadoNesteItem = true;
        totalRegular += Math.max(...candidatos);
      }
    }
    if (avaliadoNesteItem) itensAvaliados++;
  });

  let totalFinal = totalRegular + totalExtra;
  if (totalFinal > 10) totalFinal = 10;
  return {
    total: Math.min(10, Math.max(0, Math.round(totalFinal * 100) / 100)),
    itensAvaliados,
    totalItensRegulares,
  };
}

/**
 * Sincroniza automaticamente as notas lançadas no Diário (`notas_diario`) para o Boletim (`notas`),
 * sem exigir que o professor refaça manualmente a exportação:
 *  - Caso A: O aluno está sem nota no boletim (`notas`), mas possui notas lançadas no diário da sua turma atual
 *            (em plano já exportado pela turma OU com todos os itens regulares avaliados).
 *  - Caso B: O aluno já tinha nota no boletim, mas o professor editou o diário posteriormente
 *            (`notas_diario.updated_at > notas.data_lancamento`) com todos os itens regulares avaliados.
 */
export async function sincronizarDiarioParaBoletim(pool, escola_id, opts = {}) {
  if (!escola_id) return { total: 0, inseridas: 0, atualizadas: 0 };
  const { ano, turma_id, bimestre, plano_id } = opts;
  const anoLetivo = ano ? Number(ano) : new Date().getFullYear();

  const parseBim = (b) => {
    const m = String(b || "").match(/(\d+)/);
    return m ? Number(m[1]) : Number(b);
  };
  const bimFiltro = bimestre ? parseBim(bimestre) : null;

  try {
    const whereExtra = [];
    const params = [escola_id, anoLetivo];

    if (turma_id) {
      whereExtra.push("AND nd.turma_id = ?");
      params.push(Number(turma_id));
    }
    if (plano_id) {
      whereExtra.push("AND nd.plano_id = ?");
      params.push(Number(plano_id));
    }
    if (bimFiltro && bimFiltro >= 1 && bimFiltro <= 4) {
      whereExtra.push("AND pa.bimestre LIKE ?");
      params.push(`%${bimFiltro}%`);
    }

    const [ndRows] = await pool.query(
      `SELECT 
         nd.plano_id,
         nd.turma_id,
         nd.aluno_id,
         nd.item_idx,
         nd.oportunidade_idx,
         nd.nota,
         nd.cor,
         nd.updated_at,
         pa.disciplina AS plano_disc,
         pa.bimestre AS bimestre_str
       FROM notas_diario nd
       JOIN planos_avaliacao pa ON pa.id = nd.plano_id
       JOIN alunos a ON a.id = nd.aluno_id
       WHERE pa.escola_id = ? AND pa.ano = ?
         AND nd.turma_id = a.turma_id
         AND nd.nota IS NOT NULL
         ${whereExtra.join(" ")}`,
      params
    );

    if (!ndRows.length) return { total: 0, inseridas: 0, atualizadas: 0 };

    const planoIds = [...new Set(ndRows.map(r => r.plano_id))];
    const alunoIds = [...new Set(ndRows.map(r => r.aluno_id))];

    const notasWhereBim = bimFiltro && bimFiltro >= 1 && bimFiltro <= 4 ? "AND bimestre = ?" : "";
    const notasParams = bimFiltro && bimFiltro >= 1 && bimFiltro <= 4
      ? [escola_id, anoLetivo, alunoIds, bimFiltro]
      : [escola_id, anoLetivo, alunoIds];

    const [
      [listaDisciplinas],
      [modulacoes],
      [itensAll],
      [notasRows],
    ] = await Promise.all([
      pool.query(
        "SELECT id, nome, nome_oficial, abreviatura, etapa, turno FROM disciplinas WHERE escola_id = ?",
        [escola_id]
      ),
      pool.query(
        "SELECT turma_id, disciplina_id FROM modulacao WHERE escola_id = ?",
        [escola_id]
      ),
      pool.query(
        `SELECT * FROM itens_avaliacao WHERE plano_id IN (?) ORDER BY plano_id ASC, id ASC`,
        [planoIds]
      ),
      pool.query(
        `SELECT id, aluno_id, disciplina_id, bimestre, nota, faltas, data_lancamento
         FROM notas
         WHERE escola_id = ? AND ano = ? AND aluno_id IN (?) ${notasWhereBim}`,
        notasParams
      ),
    ]);

    const itensPorPlano = new Map();
    for (const it of itensAll) {
      if (!itensPorPlano.has(it.plano_id)) itensPorPlano.set(it.plano_id, []);
      itensPorPlano.get(it.plano_id).push(it);
    }

    const notasMap = new Map();
    for (const n of notasRows) {
      notasMap.set(`${n.aluno_id}_${n.disciplina_id}_${n.bimestre}`, n);
    }

    const resolverDiscDaTurma = (plano_disc, tId) => {
      const discBase = resolverDisciplina(plano_disc, listaDisciplinas);
      if (!discBase) return null;
      const eqIds = resolverIdsEquivalentes(discBase, listaDisciplinas);
      for (const m of modulacoes) {
        if (Number(m.turma_id) === Number(tId) && eqIds.includes(Number(m.disciplina_id))) {
          return listaDisciplinas.find(d => Number(d.id) === Number(m.disciplina_id)) || discBase;
        }
      }
      return discBase;
    };

    const findNotaBoletim = (alId, discObj, bim) => {
      if (!discObj) return null;
      const eqIds = resolverIdsEquivalentes(discObj, listaDisciplinas);
      for (const id of eqIds) {
        const n = notasMap.get(`${alId}_${id}_${bim}`);
        if (n && n.nota !== null) return n;
      }
      return notasMap.get(`${alId}_${discObj.id}_${bim}`) || null;
    };

    const grupos = new Map();
    for (const r of ndRows) {
      const k = `${r.plano_id}_${r.turma_id}_${r.aluno_id}`;
      if (!grupos.has(k)) {
        grupos.set(k, {
          plano_id: r.plano_id,
          turma_id: r.turma_id,
          plano_disc: r.plano_disc,
          bimestre: parseBim(r.bimestre_str),
          aluno_id: r.aluno_id,
          max_upd: r.updated_at,
          mapaNotas: {},
        });
      }
      const g = grupos.get(k);
      if (r.updated_at && (!g.max_upd || r.updated_at > g.max_upd)) {
        g.max_upd = r.updated_at;
      }
      g.mapaNotas[`${r.item_idx}_${r.oportunidade_idx}`] = {
        nota: Number(r.nota),
        cor: r.cor,
      };
    }

    const planoTurmaExportados = new Set();
    for (const g of grupos.values()) {
      const discObj = resolverDiscDaTurma(g.plano_disc, g.turma_id);
      const nb = findNotaBoletim(g.aluno_id, discObj, g.bimestre);
      if (nb && nb.nota !== null) {
        planoTurmaExportados.add(`${g.plano_id}_${g.turma_id}`);
      }
    }

    const upserts = [];
    let inseridas = 0;
    let atualizadas = 0;
    const agora = new Date();

    for (const g of grupos.values()) {
      if (bimFiltro && g.bimestre !== bimFiltro) continue;
      if (!g.bimestre || g.bimestre < 1 || g.bimestre > 4) continue;

      const arrItens = itensPorPlano.get(g.plano_id) || [];
      const { total, itensAvaliados, totalItensRegulares } = calcularTotalDiarioAluno(arrItens, g.mapaNotas);
      const discObj = resolverDiscDaTurma(g.plano_disc, g.turma_id);
      if (!discObj) continue;

      const nb = findNotaBoletim(g.aluno_id, discObj, g.bimestre);
      const jaExp = planoTurmaExportados.has(`${g.plano_id}_${g.turma_id}`);
      const todosItensLancados = totalItensRegulares > 0 && itensAvaliados >= totalItensRegulares;

      if (!nb || nb.nota === null) {
        if ((jaExp && (todosItensLancados || total > 0)) || todosItensLancados) {
          upserts.push([escola_id, g.aluno_id, anoLetivo, g.bimestre, discObj.id, total.toFixed(2), agora]);
          inseridas++;
        }
      } else {
        const vb = Math.round(Number(nb.nota) * 100) / 100;
        if (Math.abs(total - vb) > 0.05 && g.max_upd && nb.data_lancamento) {
          const dtDiario = new Date(g.max_upd).getTime();
          const dtBoletim = new Date(nb.data_lancamento).getTime();
          if (dtDiario > dtBoletim + 60000 && todosItensLancados) {
            upserts.push([escola_id, g.aluno_id, anoLetivo, g.bimestre, nb.disciplina_id || discObj.id, total.toFixed(2), agora]);
            atualizadas++;
          }
        }
      }
    }

    if (upserts.length > 0) {
      await pool.query(
        `INSERT INTO notas (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, data_lancamento)
         VALUES ?
         ON DUPLICATE KEY UPDATE nota = VALUES(nota), data_lancamento = NOW()`,
        [upserts]
      );
      console.log(`[SYNC DIÁRIO->BOLETIM] Escola ${escola_id}: ${upserts.length} nota(s) sincronizada(s) automaticamente (${inseridas} inserida(s), ${atualizadas} atualizada(s)).`);
    }

    return { total: upserts.length, inseridas, atualizadas };
  } catch (err) {
    console.error(`[SYNC DIÁRIO->BOLETIM] Erro na escola ${escola_id}:`, err.message);
    return { total: 0, inseridas: 0, atualizadas: 0 };
  }
}

