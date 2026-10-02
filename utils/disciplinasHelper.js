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
  ids.add(Number(targetDisc.id));

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
    const dId = Number(d.id);
    if (dId === Number(targetDisc.id)) {
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
      `SELECT mo.turma_id, mo.disciplina_id, d.nome, d.nome_oficial, d.abreviatura
       FROM modulacao mo
       JOIN disciplinas d ON d.id = mo.disciplina_id
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

      // Busca notas desses alunos com outros IDs equivalentes
      const [notasParaMigrar] = await pool.query(
        `SELECT id, aluno_id, ano, bimestre, disciplina_id, nota, faltas
         FROM notas
         WHERE escola_id = ?
           AND aluno_id IN (?)
           AND disciplina_id IN (?)`,
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
          // Se a existente estiver nula/vazia e a antiga tiver valor, mescla.
          if ((jaExiste.nota == null || jaExiste.nota === "") && (n.nota != null && n.nota !== "")) {
            await pool.query(
              `UPDATE notas SET nota = ?, faltas = COALESCE(?, faltas) WHERE id = ?`,
              [n.nota, n.faltas, jaExiste.id]
            );
          }
          // Remove a duplicata antiga
          await pool.query(`DELETE FROM notas WHERE id = ?`, [n.id]);
          totalAtualizados++;
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
