// routes/secretaria-relatorios.js
// ============================================================================
// Rotas de relatórios da Secretaria
// ============================================================================

import express from 'express';
import pool from '../db.js';
import { resolverIdsEquivalentes, reconciliarNotasComModulacao, sincronizarDiarioParaBoletim } from '../utils/disciplinasHelper.js';

const router = express.Router();

function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// CASE reutilizável — classifica série pelo nome da turma
const CASE_SERIE = `CASE
  WHEN t.nome LIKE '6%' THEN '6\xba Ano'
  WHEN t.nome LIKE '7%' THEN '7\xba Ano'
  WHEN t.nome LIKE '8%' THEN '8\xba Ano'
  WHEN t.nome LIKE '9%' THEN '9\xba Ano'
  ELSE 'Outra'
END`;

// ============================================================================
// 1) RELATÓRIO SINTÉTICO DE MATRÍCULAS
// ============================================================================
router.get('/sintetico-matriculas', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano_letivo, turno } = req.query;
    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    const params = [escola_id, anoEfetivo];
    let turnoFilter = '';
    if (turno && turno !== 'todos') {
      turnoFilter = 'AND UPPER(t.turno) = UPPER(?)';
      params.push(turno);
    }

    // ✅ Subquery: agrupa pela expressão CASE internamente.
    // A query externa ordena pelo alias 'serie' — sem referenciar t.nome diretamente.
    const sql = `
      SELECT serie, turno, total FROM (
        SELECT
          ${CASE_SERIE} AS serie,
          t.turno                           AS turno,
          COUNT(DISTINCT m.aluno_id)        AS total
        FROM matriculas m
        INNER JOIN turmas t ON t.id = m.turma_id
        WHERE m.escola_id = ?
          AND m.ano_letivo = ?
          AND m.status = 'ativo'
          ${turnoFilter}
        GROUP BY ${CASE_SERIE}, t.turno
      ) AS sub
      ORDER BY
        CASE serie
          WHEN '6\xba Ano' THEN 1
          WHEN '7\xba Ano' THEN 2
          WHEN '8\xba Ano' THEN 3
          WHEN '9\xba Ano' THEN 4
          ELSE 5
        END,
        turno
    `;

    const [rows] = await pool.query(sql, params);

    const total = rows.reduce((acc, r) => acc + Number(r.total), 0);

    const porSerie = {};
    for (const row of rows) {
      if (!porSerie[row.serie]) {
        porSerie[row.serie] = { serie: row.serie, total: 0, turnos: {} };
      }
      porSerie[row.serie].total += Number(row.total);
      porSerie[row.serie].turnos[row.turno] =
        (porSerie[row.serie].turnos[row.turno] || 0) + Number(row.total);
    }

    return res.json({
      ano_letivo: anoEfetivo,
      turno_filtro: turno || 'todos',
      total_geral: total,
      por_serie: Object.values(porSerie),
      detalhado: rows,
    });
  } catch (err) {
    console.error('[relatorios] sintetico-matriculas:', err);
    return res.status(500).json({ message: 'Erro ao gerar relatório de matrículas.' });
  }
});

// ============================================================================
// 2) RELATÓRIO DE IDADES
// ============================================================================
router.get('/idades', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano_letivo, turno, serie } = req.query;
    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    const params = [escola_id, anoEfetivo];
    let extraFilters = '';

    if (turno && turno !== 'todos') {
      extraFilters += ' AND UPPER(t.turno) = UPPER(?)';
      params.push(turno);
    }
    if (serie && serie !== 'todas') {
      extraFilters += ' AND t.nome LIKE ?';
      params.push(`${serie}%`);
    }

    const sql = `
      SELECT
        a.id,
        a.estudante,
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
        TIMESTAMPDIFF(YEAR, a.data_nascimento, CURDATE()) AS idade,
        t.nome  AS turma,
        t.turno AS turno,
        ${CASE_SERIE} AS serie
      FROM matriculas m
      INNER JOIN alunos a ON a.id = m.aluno_id
      INNER JOIN turmas t ON t.id = m.turma_id
      WHERE m.escola_id = ?
        AND m.ano_letivo = ?
        AND m.status = 'ativo'
        AND a.data_nascimento IS NOT NULL
        ${extraFilters}
      ORDER BY a.estudante
    `;

    const [rows] = await pool.query(sql, params);

    const faixas = [
      { label: 'Até 11 anos',  min: 0,  max: 11  },
      { label: '12 anos',      min: 12, max: 12  },
      { label: '13 anos',      min: 13, max: 13  },
      { label: '14 anos',      min: 14, max: 14  },
      { label: '15 anos',      min: 15, max: 15  },
      { label: '16 anos',      min: 16, max: 16  },
      { label: '17 anos',      min: 17, max: 17  },
      { label: '18 anos ou +', min: 18, max: 999 },
    ];

    const distribuicao = faixas.map(f => ({
      ...f,
      total: rows.filter(r => Number(r.idade) >= f.min && Number(r.idade) <= f.max).length,
    }));

    // Sem data de nascimento — respeitando os mesmos filtros
    const semDobParams = [escola_id, anoEfetivo];
    let semDobFilter = '';
    if (turno && turno !== 'todos') {
      semDobFilter += ' AND UPPER(t.turno) = UPPER(?)';
      semDobParams.push(turno);
    }
    if (serie && serie !== 'todas') {
      semDobFilter += ' AND t.nome LIKE ?';
      semDobParams.push(`${serie}%`);
    }

    const sqlSemDob = `
      SELECT COUNT(DISTINCT m.aluno_id) AS sem_dob
      FROM matriculas m
      INNER JOIN alunos a ON a.id = m.aluno_id
      INNER JOIN turmas t ON t.id = m.turma_id
      WHERE m.escola_id = ?
        AND m.ano_letivo = ?
        AND m.status = 'ativo'
        AND a.data_nascimento IS NULL
        ${semDobFilter}
    `;
    const [[{ sem_dob }]] = await pool.query(sqlSemDob, semDobParams);

    return res.json({
      ano_letivo: anoEfetivo,
      total: rows.length,
      sem_data_nascimento: Number(sem_dob),
      distribuicao,
      alunos: rows.map(r => ({
        id: r.id,
        estudante: r.estudante,
        data_nascimento: r.data_nascimento,
        idade: r.idade,
        turma: r.turma,
        turno: r.turno,
        serie: r.serie,
      })),
    });
  } catch (err) {
    console.error('[relatorios] idades:', err);
    return res.status(500).json({ message: 'Erro ao gerar relatório de idades.' });
  }
});

// ============================================================================
// 3) RELATÓRIO DE TURMAS
// ============================================================================
router.get('/turmas', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano_letivo, turno } = req.query;
    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    const params = [anoEfetivo, escola_id];
    let turnoFilter = '';
    if (turno && turno !== 'todos') {
      turnoFilter = 'AND UPPER(t.turno) = UPPER(?)';
      params.push(turno);
    }

    // ✅ Subquery: GROUP BY colunas reais; ORDER BY pelo alias da subquery
    const sql = `
      SELECT turma_id, turma, turno, serie, total_alunos FROM (
        SELECT
          t.id                               AS turma_id,
          t.nome                             AS turma,
          t.turno                            AS turno,
          ${CASE_SERIE}                      AS serie,
          COUNT(DISTINCT m.aluno_id)         AS total_alunos
        FROM turmas t
        INNER JOIN matriculas m
          ON m.turma_id = t.id
          AND m.ano_letivo = ?
          AND m.status = 'ativo'
        WHERE t.escola_id = ?
          ${turnoFilter}
        GROUP BY t.id, t.nome, t.turno
      ) AS sub
      ORDER BY
        CASE serie
          WHEN '6\xba Ano' THEN 1
          WHEN '7\xba Ano' THEN 2
          WHEN '8\xba Ano' THEN 3
          WHEN '9\xba Ano' THEN 4
          ELSE 5
        END,
        turma
    `;

    const [rows] = await pool.query(sql, params);
    const total = rows.reduce((acc, r) => acc + Number(r.total_alunos), 0);

    return res.json({
      ano_letivo: anoEfetivo,
      total_geral: total,
      turmas: rows,
    });
  } catch (err) {
    console.error('[relatorios] turmas:', err);
    return res.status(500).json({ message: 'Erro ao gerar relatório de turmas.' });
  }
});

// ============================================================================
// 4) RELATÓRIO DE GÊNERO
// ============================================================================
router.get('/genero', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano_letivo, turno } = req.query;
    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    const params = [escola_id, anoEfetivo];
    let turnoFilter = '';
    if (turno && turno !== 'todos') {
      turnoFilter = 'AND UPPER(t.turno) = UPPER(?)';
      params.push(turno);
    }

    // ✅ Subquery: agrupa internamente; ORDER BY pelo alias 'serie' externo
    const sql = `
      SELECT serie, sexo, total FROM (
        SELECT
          ${CASE_SERIE}                                    AS serie,
          COALESCE(UPPER(a.sexo), 'NÃO INFORMADO')        AS sexo,
          COUNT(DISTINCT m.aluno_id)                       AS total
        FROM matriculas m
        INNER JOIN alunos a ON a.id = m.aluno_id
        INNER JOIN turmas t ON t.id = m.turma_id
        WHERE m.escola_id = ?
          AND m.ano_letivo = ?
          AND m.status = 'ativo'
          ${turnoFilter}
        GROUP BY ${CASE_SERIE}, COALESCE(UPPER(a.sexo), 'NÃO INFORMADO')
      ) AS sub
      ORDER BY
        CASE serie
          WHEN '6\xba Ano' THEN 1
          WHEN '7\xba Ano' THEN 2
          WHEN '8\xba Ano' THEN 3
          WHEN '9\xba Ano' THEN 4
          ELSE 5
        END,
        sexo
    `;

    const [rows] = await pool.query(sql, params);

    const totais = { M: 0, F: 0, outro: 0, total: 0 };
    for (const r of rows) {
      const n = Number(r.total);
      totais.total += n;
      // BD armazena 'Masculino'/'Feminino' — após UPPER() vira 'MASCULINO'/'FEMININO'
      if (r.sexo === 'MASCULINO' || r.sexo === 'M') totais.M += n;
      else if (r.sexo === 'FEMININO' || r.sexo === 'F') totais.F += n;
      else totais.outro += n;
    }

    return res.json({ ano_letivo: anoEfetivo, totais, detalhado: rows });
  } catch (err) {
    console.error('[relatorios] genero:', err);
    return res.status(500).json({ message: 'Erro ao gerar relatório de gênero.' });
  }
});

// ============================================================================
// 5) ANOS LETIVOS DISPONÍVEIS
// ============================================================================
router.get('/anos-letivos', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const [rows] = await pool.query(
      `SELECT DISTINCT ano_letivo FROM matriculas WHERE escola_id = ? ORDER BY ano_letivo DESC`,
      [escola_id]
    );
    return res.json(rows.map(r => r.ano_letivo));
  } catch (err) {
    console.error('[relatorios] anos-letivos:', err);
    return res.status(500).json({ message: 'Erro ao buscar anos letivos.' });
  }
});

// ============================================================================
// 6) ACOMPANHAMENTO DE LANÇAMENTO DE NOTAS
// ============================================================================
router.get('/acompanhamento-notas', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano_letivo, turno, disciplina_id, turma_id, bimestre } = req.query;
    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();
    const bimEfetivo = bimestre ? Number(bimestre) : 1;

    // Dispara reconciliação de notas x modulação de forma não-bloqueante e sincroniza notas completas do Diário para o Boletim
    reconciliarNotasComModulacao(pool, escola_id).catch(() => {});
    await sincronizarDiarioParaBoletim(pool, escola_id, {
      ano: anoEfetivo,
      turma_id: (turma_id && turma_id !== 'todas') ? Number(turma_id) : undefined,
      bimestre: bimEfetivo,
    }).catch(() => {});

    // 1. Modulação com filtros (respeitando regime anual/semestral: 1º/2º Bim -> semestre 1; 3º/4º Bim -> semestre 2)
    const semestreAlvo = bimEfetivo <= 2 ? 1 : 2;
    let extraFilter = '';
    const paramsMod = [
      escola_id,
      escola_id,
      anoEfetivo,
      semestreAlvo,
      semestreAlvo,
      semestreAlvo,
      semestreAlvo,
    ];

    if (turno && turno !== 'todos') {
      extraFilter += ' AND UPPER(t.turno) = UPPER(?)';
      paramsMod.push(turno);
    }
    if (disciplina_id && disciplina_id !== 'todas') {
      extraFilter += ' AND d.id = ?';
      paramsMod.push(Number(disciplina_id));
    }
    if (turma_id && turma_id !== 'todas') {
      extraFilter += ' AND t.id = ?';
      paramsMod.push(Number(turma_id));
    }

    const sqlMod = `
      SELECT DISTINCT
        p.id AS professor_id,
        p.nome AS professor_nome,
        t.id AS turma_id,
        t.nome AS turma_nome,
        t.turno AS turno,
        d.id AS disciplina_id,
        d.nome AS disciplina_nome,
        d.nome_oficial AS disciplina_nome_oficial,
        d.abreviatura AS disciplina_abreviatura
      FROM modulacao m
      JOIN professores p ON p.id = m.professor_id
      JOIN turmas t ON t.id = m.turma_id
      JOIN disciplinas d ON d.id = m.disciplina_id
      WHERE m.escola_id = ?
        AND p.escola_id = ?
        AND t.ano = ?
        AND (
          LOWER(COALESCE(t.regime, 'anual')) <> 'semestral'
          OR m.semestre IS NULL
          OR m.semestre = 0
          OR m.semestre = ?
          OR (
            NOT EXISTS (
              SELECT 1 FROM modulacao m2
              WHERE m2.escola_id = m.escola_id
                AND m2.turma_id = m.turma_id
                AND m2.disciplina_id = m.disciplina_id
                AND m2.semestre = ?
            )
            AND EXISTS (
              SELECT 1 FROM professor_vinculos pv0
              WHERE pv0.professor_id = p.id
                AND pv0.disciplina_id = m.disciplina_id
                AND LOWER(pv0.turno) COLLATE utf8mb4_unicode_ci = LOWER(t.turno) COLLATE utf8mb4_unicode_ci
                AND pv0.escola_id = p.escola_id
                AND (pv0.semestre = 0 OR pv0.semestre IS NULL)
            )
            AND NOT EXISTS (
              SELECT 1 FROM professor_vinculos pvs
              WHERE pvs.professor_id = p.id
                AND pvs.disciplina_id = m.disciplina_id
                AND LOWER(pvs.turno) COLLATE utf8mb4_unicode_ci = LOWER(t.turno) COLLATE utf8mb4_unicode_ci
                AND pvs.escola_id = p.escola_id
                AND pvs.semestre IN (1, 2)
            )
            AND (
              EXISTS (
                SELECT 1 FROM turma_cargas tc
                WHERE tc.escola_id = m.escola_id
                  AND tc.turma_id = m.turma_id
                  AND tc.disciplina_id = m.disciplina_id
                  AND tc.semestre = ?
              )
              OR NOT EXISTS (
                SELECT 1 FROM turma_cargas tc_any
                WHERE tc_any.escola_id = m.escola_id
                  AND tc_any.turma_id = m.turma_id
                  AND tc_any.semestre = ?
              )
            )
          )
        )
        ${extraFilter}
      ORDER BY p.nome, t.nome, d.nome
    `;

    const [modRows] = await pool.query(sqlMod, paramsMod);

    // 1b. Modulação de Turmas de Agrupamento (Eletivas, Nivelamento, Agrupamentos)
    let agrupModRows = [];
    if (!turma_id || turma_id === 'todas') {
      try {
        let extraFilterAgrup = '';
        const paramsAgrup = [escola_id, escola_id, anoEfetivo, semestreAlvo];
        if (turno && turno !== 'todos') {
          extraFilterAgrup += ' AND UPPER(g.turno) = UPPER(?)';
          paramsAgrup.push(turno);
        }
        if (disciplina_id && disciplina_id !== 'todas') {
          extraFilterAgrup += ' AND d.id = ?';
          paramsAgrup.push(Number(disciplina_id));
        }

        const [agRows] = await pool.query(
          `SELECT DISTINCT
             p.id AS professor_id,
             p.nome AS professor_nome,
             g.id AS agrupamento_id,
             g.nome AS turma_nome,
             g.turno AS turno,
             g.origem_disciplina_legada_id,
             d.id AS disciplina_id,
             d.nome AS disciplina_nome,
             d.nome_oficial AS disciplina_nome_oficial,
             d.abreviatura AS disciplina_abreviatura
           FROM agrupamento_modulacao am
           JOIN agrupamentos g ON g.id = am.agrupamento_id
           JOIN professores p ON p.id = am.professor_id
           JOIN disciplinas d ON d.id = am.disciplina_id
           WHERE am.escola_id = ?
             AND g.escola_id = ?
             AND g.ano_letivo = ?
             AND g.status <> 'ENCERRADO'
             AND (g.semestre IS NULL OR g.semestre = 0 OR g.semestre = ?)
             ${extraFilterAgrup}
           ORDER BY p.nome, g.nome, d.nome`,
          paramsAgrup
        );
        agrupModRows = agRows || [];
      } catch (_) {
        // Tabela agrupamento_modulacao pode não existir ainda em ambientes legados
      }
    }

    if (modRows.length === 0 && agrupModRows.length === 0) {
      return res.json({
        ano_letivo: anoEfetivo,
        bimestre: bimEfetivo,
        dados: []
      });
    }

    // 2. Todas as disciplinas da escola (para resolver equivalências de forma instantânea)
    const [todasDiscs] = await pool.query(
      `SELECT id, nome, nome_oficial, abreviatura FROM disciplinas WHERE escola_id = ?`,
      [escola_id]
    );

    // 3. Total de alunos ativos por turma no ano letivo
    const [alunosPorTurmaRows] = await pool.query(
      `SELECT 
         COALESCE(m.turma_id, a.turma_id) AS turma_id,
         COUNT(DISTINCT a.id) AS total
       FROM alunos a
       LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.status = 'ativo' AND m.ano_letivo = ? AND m.escola_id = ?
       WHERE a.escola_id = ?
         AND (a.status = 'ativo' OR a.status IS NULL)
         AND COALESCE(m.turma_id, a.turma_id) IS NOT NULL
       GROUP BY COALESCE(m.turma_id, a.turma_id)`,
      [anoEfetivo, escola_id, escola_id]
    );

    const totalAlunosMap = new Map();
    for (const r of alunosPorTurmaRows) {
      totalAlunosMap.set(Number(r.turma_id), Number(r.total));
    }

    // 4. Notas lançadas no ano e bimestre (traz turma_id, disciplina_id e aluno_id)
    const [notasLancadasRows] = await pool.query(
      `SELECT 
         COALESCE(m.turma_id, a.turma_id) AS turma_id,
         n.disciplina_id,
         n.aluno_id
       FROM notas n
       JOIN alunos a ON a.id = n.aluno_id
       LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.status = 'ativo' AND m.ano_letivo = ? AND m.escola_id = ?
       WHERE n.escola_id = ?
         AND n.ano = ?
         AND n.bimestre = ?
         AND (n.nota IS NOT NULL OR n.faltas IS NOT NULL)
         AND (a.status = 'ativo' OR a.status IS NULL)
         AND COALESCE(m.turma_id, a.turma_id) IS NOT NULL`,
      [anoEfetivo, escola_id, escola_id, anoEfetivo, bimEfetivo]
    );

    // Mapa: "turmaId_discId" -> Set de aluno_ids
    // E mapa por disciplina: "discId" -> Set de aluno_ids (usado para agrupamentos multi-turma)
    const notasMap = new Map();
    const notasPorDiscMap = new Map();
    for (const n of notasLancadasRows) {
      const key = `${n.turma_id}_${n.disciplina_id}`;
      if (!notasMap.has(key)) {
        notasMap.set(key, new Set());
      }
      notasMap.get(key).add(n.aluno_id);

      const dId = Number(n.disciplina_id);
      if (!notasPorDiscMap.has(dId)) {
        notasPorDiscMap.set(dId, new Set());
      }
      notasPorDiscMap.get(dId).add(Number(n.aluno_id));
    }

    // Cache de IDs equivalentes por disciplina_id para evitar recomputar
    const equivalenciasMap = new Map();

    // 5. Montar o resultado final combinando os dados com tolerância multi-ID
    const dados = modRows.map(row => {
      const turmaId = Number(row.turma_id);
      const discId = Number(row.disciplina_id);

      if (!equivalenciasMap.has(discId)) {
        const targetDisc = {
          id: discId,
          nome: row.disciplina_nome,
          nome_oficial: row.disciplina_nome_oficial,
          abreviatura: row.disciplina_abreviatura
        };
        const eqIds = resolverIdsEquivalentes(targetDisc, todasDiscs);
        equivalenciasMap.set(discId, eqIds);
      }

      const eqIds = equivalenciasMap.get(discId);

      // Agrupa alunos únicos que têm nota em qualquer uma das disciplinas equivalentes
      const alunosComNotaSet = new Set();
      for (const eqId of eqIds) {
        const key = `${turmaId}_${eqId}`;
        const setForDisc = notasMap.get(key);
        if (setForDisc) {
          for (const aId of setForDisc) {
            alunosComNotaSet.add(aId);
          }
        }
      }

      return {
        professor_id: row.professor_id,
        professor_nome: row.professor_nome,
        turma_id: row.turma_id,
        turma_nome: row.turma_nome,
        turno: row.turno,
        disciplina_id: row.disciplina_id,
        disciplina_nome: row.disciplina_nome,
        total_alunos: totalAlunosMap.get(turmaId) || 0,
        alunos_com_nota: alunosComNotaSet.size
      };
    });

    // 5b. Anexar Turmas de Agrupamento (se houver)
    if (agrupModRows.length > 0) {
      try {
        const [agAlunosRows] = await pool.query(
          `SELECT aa.agrupamento_id, aa.aluno_id
           FROM agrupamento_alunos aa
           JOIN alunos a ON a.id = aa.aluno_id
           WHERE aa.escola_id = ?
             AND (aa.status = 'ATIVO' OR aa.status IS NULL)
             AND (a.status = 'ativo' OR a.status IS NULL)`,
          [escola_id]
        );
        const alunosPorAgrupMap = new Map();
        for (const r of agAlunosRows) {
          const agId = Number(r.agrupamento_id);
          if (!alunosPorAgrupMap.has(agId)) {
            alunosPorAgrupMap.set(agId, new Set());
          }
          alunosPorAgrupMap.get(agId).add(Number(r.aluno_id));
        }

        for (const row of agrupModRows) {
          const agId = Number(row.agrupamento_id);
          const discId = Number(row.disciplina_id);

          if (!equivalenciasMap.has(discId)) {
            const targetDisc = {
              id: discId,
              nome: row.disciplina_nome,
              nome_oficial: row.disciplina_nome_oficial,
              abreviatura: row.disciplina_abreviatura
            };
            const eqIds = resolverIdsEquivalentes(targetDisc, todasDiscs);
            equivalenciasMap.set(discId, eqIds);
          }

          const eqIds = [...(equivalenciasMap.get(discId) || [discId])];
          if (row.origem_disciplina_legada_id && !eqIds.includes(Number(row.origem_disciplina_legada_id))) {
            eqIds.push(Number(row.origem_disciplina_legada_id));
          }

          const alunosDoAgrup = alunosPorAgrupMap.get(agId) || new Set();
          const alunosComNotaSet = new Set();
          for (const aId of alunosDoAgrup) {
            for (const eqId of eqIds) {
              if (notasPorDiscMap.get(Number(eqId))?.has(aId)) {
                alunosComNotaSet.add(aId);
                break;
              }
            }
          }

          dados.push({
            professor_id: row.professor_id,
            professor_nome: row.professor_nome,
            turma_id: agId,
            turma_nome: row.turma_nome,
            turno: row.turno,
            disciplina_id: row.disciplina_id,
            disciplina_nome: row.disciplina_nome,
            total_alunos: alunosDoAgrup.size,
            alunos_com_nota: alunosComNotaSet.size,
            is_agrupamento: true
          });
        }

        dados.sort((a, b) =>
          String(a.professor_nome || '').localeCompare(String(b.professor_nome || ''), 'pt-BR') ||
          String(a.turma_nome || '').localeCompare(String(b.turma_nome || ''), 'pt-BR') ||
          String(a.disciplina_nome || '').localeCompare(String(b.disciplina_nome || ''), 'pt-BR')
        );
      } catch (agErr) {
        console.warn('[relatorios] Aviso ao processar agrupamentos no acompanhamento-notas:', agErr.message);
      }
    }

    return res.json({
      ano_letivo: anoEfetivo,
      bimestre: bimEfetivo,
      dados
    });
  } catch (err) {
    console.error('[relatorios] acompanhamento-notas:', err);
    return res.status(500).json({ message: 'Erro ao gerar acompanhamento de notas.' });
  }
});

// ============================================================================
// 7) VISUALIZAÇÃO DE ALUNOS E NOTAS DO ACOMPANHAMENTO (SEM EDIÇÃO)
// ============================================================================
router.get('/acompanhamento-notas/alunos', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { turma_id, disciplina_id, bimestre, ano_letivo, is_agrupamento } = req.query;

    if (!turma_id || !disciplina_id || !bimestre) {
      return res.status(400).json({ message: "turma_id, disciplina_id e bimestre são obrigatórios." });
    }

    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();
    const bimNum = Number(bimestre);
    const isAgrup = Number(is_agrupamento) === 1 || is_agrupamento === 'true';

    if (!isAgrup) {
      await sincronizarDiarioParaBoletim(pool, escola_id, {
        ano: anoEfetivo,
        turma_id: Number(turma_id),
        bimestre: bimNum,
      }).catch(() => {});
    }

    // 1. Resolver todos os IDs equivalentes da disciplina na escola
    const [[targetDisc]] = await pool.query(
      "SELECT id, nome, nome_oficial, abreviatura FROM disciplinas WHERE id = ? AND escola_id = ?",
      [Number(disciplina_id), escola_id]
    );

    let equivalentDiscIds = [Number(disciplina_id)];
    if (targetDisc) {
      const [allDiscs] = await pool.query(
        "SELECT id, nome, nome_oficial, abreviatura FROM disciplinas WHERE escola_id = ?",
        [escola_id]
      );
      equivalentDiscIds = resolverIdsEquivalentes(targetDisc, allDiscs);
    }

    if (isAgrup) {
      try {
        const [[agRow]] = await pool.query(
          "SELECT origem_disciplina_legada_id FROM agrupamentos WHERE id = ? AND escola_id = ? LIMIT 1",
          [Number(turma_id), escola_id]
        );
        if (agRow?.origem_disciplina_legada_id && !equivalentDiscIds.includes(Number(agRow.origem_disciplina_legada_id))) {
          equivalentDiscIds.push(Number(agRow.origem_disciplina_legada_id));
        }
      } catch (_) {}

      const sqlAgrup = `
        SELECT
          a.id AS aluno_id,
          a.estudante AS nome,
          a.codigo AS matricula,
          a.foto,
          MAX(n.nota) AS nota,
          MAX(n.faltas) AS faltas
        FROM agrupamento_alunos aa
        JOIN alunos a ON a.id = aa.aluno_id
        LEFT JOIN notas n ON n.aluno_id = a.id
          AND n.disciplina_id IN (?)
          AND n.bimestre = ?
          AND n.ano = ?
          AND n.escola_id = ?
        WHERE aa.agrupamento_id = ?
          AND aa.escola_id = ?
          AND (aa.status = 'ATIVO' OR aa.status IS NULL)
          AND (a.status = 'ativo' OR a.status IS NULL)
        GROUP BY a.id, a.estudante, a.codigo, a.foto
        ORDER BY a.estudante
      `;
      const [rowsAgrup] = await pool.query(sqlAgrup, [
        equivalentDiscIds,
        bimNum,
        anoEfetivo,
        escola_id,
        Number(turma_id),
        escola_id
      ]);
      return res.json(rowsAgrup);
    }

    // 2. Query dos alunos e notas com tolerância multi-ID (Turmas Regulares)
    const sql = `
      SELECT
        a.id AS aluno_id,
        a.estudante AS nome,
        a.codigo AS matricula,
        a.foto,
        MAX(n.nota) AS nota,
        MAX(n.faltas) AS faltas
      FROM alunos a
      LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.status = 'ativo' AND m.ano_letivo = ?
      LEFT JOIN notas n ON n.aluno_id = a.id
        AND n.disciplina_id IN (?)
        AND n.bimestre = ?
        AND n.ano = ?
        AND n.escola_id = ?
      WHERE (a.turma_id = ? OR m.turma_id = ?)
        AND a.escola_id = ?
        AND (a.status = 'ativo' OR a.status IS NULL)
      GROUP BY a.id, a.estudante, a.codigo, a.foto
      ORDER BY a.estudante
    `;

    const [rows] = await pool.query(sql, [
      anoEfetivo,
      equivalentDiscIds,
      bimNum,
      anoEfetivo,
      escola_id,
      Number(turma_id),
      Number(turma_id),
      escola_id
    ]);

    return res.json(rows);
  } catch (err) {
    console.error('[relatorios] acompanhamento-notas-alunos:', err);
    return res.status(500).json({ message: 'Erro ao listar alunos do acompanhamento.' });
  }
});

// ============================================================================
// 8) LISTAGEM DE DIÁRIOS — Secretaria visualiza planos de toda a escola
// ============================================================================
// IMPORTANTE: planos_avaliacao NÃO tem disciplina_id nem turma_id como FK.
// A relação é feita por NOME:
//   pa.turmas  = t.nome   (nome da turma como string)
//   pa.disciplina = d.nome (nome da disciplina como string)
// O professor é obtido via modulação cruzando turma + disciplina por nome.
// ============================================================================
router.get('/diarios', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano_letivo, bimestre, turno, turma_id } = req.query;

    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    let extraFilter = '';
    const params = [escola_id, anoEfetivo];

    if (bimestre && bimestre !== 'todos') {
      // bimestre pode ser "1", "2", "1º Bimestre", "2º Bimestre"
      extraFilter += ` AND (pa.bimestre = ? OR pa.bimestre LIKE ?)`;
      params.push(String(bimestre), `${bimestre}%`);
    }

    if (turno && turno !== 'todos') {
      extraFilter += ` AND CONVERT(t.turno USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci`;
      params.push(turno);
    }

    if (turma_id && turma_id !== 'todas') {
      extraFilter += ` AND t.id = ?`;
      params.push(Number(turma_id));
    }

    // ── A ponte é: pa.turmas = t.nome  E  pa.disciplina = d.nome
    const sql = `
      SELECT
        pa.id              AS plano_id,
        pa.status          AS plano_status,
        pa.bimestre,
        pa.ano,
        pa.disciplina      AS disciplina_nome,
        IF(df.id IS NOT NULL, 1, 0) AS diario_fechado,
        t.id               AS turma_id,
        t.nome             AS turma_nome,
        t.turno,
        mod_prof.professor_id,
        mod_prof.professor_nome
      FROM planos_avaliacao pa
      -- Liga pelo NOME da turma com COLLATE
      -- E pelo turno: se pa.turno preenchido (novos planos) → filtra exato; se NULL (legados) → backward compatible
      JOIN turmas t
        ON CONVERT(t.nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
         = CONVERT(pa.turmas USING utf8mb4) COLLATE utf8mb4_unicode_ci
       AND t.escola_id = pa.escola_id
       AND t.ano       = pa.ano
       AND (pa.turno IS NULL OR
            CONVERT(t.turno USING utf8mb4) COLLATE utf8mb4_unicode_ci
            = CONVERT(pa.turno USING utf8mb4) COLLATE utf8mb4_unicode_ci)
      -- Obtém o professor via subquery consolidada por NOME da disciplina, evitando duplicatas de tabela disciplina
      LEFT JOIN (
        SELECT 
          mo.turma_id,
          d.nome AS disciplina_nome,
          mo.professor_id,
          p.nome AS professor_nome,
          mo.escola_id
        FROM modulacao mo
        JOIN disciplinas d ON d.id = mo.disciplina_id
        JOIN professores p ON p.id = mo.professor_id
        GROUP BY mo.turma_id, d.nome, mo.professor_id, p.nome, mo.escola_id
      ) mod_prof
        ON mod_prof.turma_id = t.id
       AND CONVERT(mod_prof.disciplina_nome USING utf8mb4) COLLATE utf8mb4_unicode_ci 
         = CONVERT(pa.disciplina USING utf8mb4) COLLATE utf8mb4_unicode_ci
       AND mod_prof.escola_id = pa.escola_id
      -- Verifica se o diário foi fechado
      LEFT JOIN diario_fechamento df
        ON df.plano_id  = pa.id
       AND df.turma_id  = t.id
       AND df.escola_id = pa.escola_id
      WHERE pa.escola_id = ?
        AND pa.ano       = ?
        ${extraFilter}
      ORDER BY mod_prof.professor_nome, t.nome, pa.disciplina
    `;


    const [rows] = await pool.query(sql, params);

    return res.json({ ok: true, diarios: rows });
  } catch (err) {
    console.error('[relatorios] diarios:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao listar diários.' });
  }
});

// ============================================================================
// 9) ALTERAR STATUS DO DIÁRIO (Secretaria override)
// ============================================================================
router.post('/diarios/toggle-status', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { plano_id, turma_id, acao } = req.body;

    if (!plano_id || !turma_id || !acao) {
      return res.status(400).json({ ok: false, error: 'Parâmetros inválidos.' });
    }

    if (acao === 'fechar') {
      await pool.query(
        `INSERT IGNORE INTO diario_fechamento (escola_id, plano_id, turma_id, fechado_por, total_alunos, total_notas_exportadas)
         VALUES (?, ?, ?, ?, 0, 0)`,
        [escola_id, plano_id, turma_id, req.user.id]
      );
    } else if (acao === 'abrir') {
      await pool.query(
        `DELETE FROM diario_fechamento
         WHERE escola_id = ? AND plano_id = ? AND turma_id = ?`,
        [escola_id, plano_id, turma_id]
      );
    }

    return res.json({ ok: true, message: `Diário ${acao === 'abrir' ? 'aberto' : 'fechado'} com sucesso.` });
  } catch (err) {
    console.error('[relatorios] toggle-status:', err);
    return res.status(500).json({ ok: false, error: 'Erro ao alterar status do diário.' });
  }
});

export default router;
