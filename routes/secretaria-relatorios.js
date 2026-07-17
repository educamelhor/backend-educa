// routes/secretaria-relatorios.js
// ============================================================================
// Rotas de relatórios da Secretaria
// ============================================================================

import express from 'express';
import pool from '../db.js';

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

    let extraFilter = '';
    const params = [escola_id, escola_id, anoEfetivo, bimEfetivo, escola_id, anoEfetivo];

    if (turno && turno !== 'todos') {
      extraFilter += ' AND UPPER(t.turno) = UPPER(?)';
      params.push(turno);
    }
    if (disciplina_id && disciplina_id !== 'todas') {
      extraFilter += ' AND d.id = ?';
      params.push(Number(disciplina_id));
    }
    if (turma_id && turma_id !== 'todas') {
      extraFilter += ' AND t.id = ?';
      params.push(Number(turma_id));
    }

    const sql = `
      SELECT 
        p.id AS professor_id,
        p.nome AS professor_nome,
        t.id AS turma_id,
        t.nome AS turma_nome,
        t.turno AS turno,
        d.id AS disciplina_id,
        d.nome AS disciplina_nome,
        (
          SELECT COUNT(a.id) 
          FROM alunos a 
          WHERE a.turma_id = t.id AND a.status = 'ativo' AND a.escola_id = ?
        ) AS total_alunos,
        (
          SELECT COUNT(n.id)
          FROM notas n
          JOIN alunos a ON a.id = n.aluno_id
          WHERE a.turma_id = t.id 
            AND a.status = 'ativo' 
            AND a.escola_id = ?
            AND n.disciplina_id = d.id
            AND n.ano = ?
            AND n.bimestre = ?
            AND (n.nota IS NOT NULL OR n.faltas IS NOT NULL)
        ) AS alunos_com_nota
      FROM modulacao m
      JOIN professores p ON p.id = m.professor_id
      JOIN turmas t ON t.id = m.turma_id
      JOIN disciplinas d ON d.id = m.disciplina_id
      WHERE p.escola_id = ?
        AND t.ano = ?
        ${extraFilter}
      ORDER BY p.nome, t.nome, d.nome
    `;

    const [rows] = await pool.query(sql, params);
    return res.json({
      ano_letivo: anoEfetivo,
      bimestre: bimEfetivo,
      dados: rows
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
    const { turma_id, disciplina_id, bimestre, ano_letivo } = req.query;

    if (!turma_id || !disciplina_id || !bimestre) {
      return res.status(400).json({ message: "turma_id, disciplina_id e bimestre são obrigatórios." });
    }

    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    const sql = `
      SELECT
        a.id AS aluno_id,
        a.estudante AS nome,
        a.codigo AS matricula,
        a.foto,
        n.nota,
        n.faltas
      FROM alunos a
      LEFT JOIN notas n ON n.aluno_id = a.id
        AND n.disciplina_id = ?
        AND n.bimestre = ?
        AND n.ano = ?
        AND n.escola_id = ?
      WHERE a.turma_id = ?
        AND a.escola_id = ?
        AND a.status = 'ativo'
      ORDER BY a.estudante
    `;

    const [rows] = await pool.query(sql, [
      Number(disciplina_id),
      Number(bimestre),
      anoEfetivo,
      escola_id,
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
      extraFilter += ` AND UPPER(t.turno) = UPPER(?)`;
      params.push(turno);
    }

    if (turma_id && turma_id !== 'todas') {
      extraFilter += ` AND t.id = ?`;
      params.push(Number(turma_id));
    }

    // ── A ponte é: pa.turmas = t.nome  E  pa.disciplina = d.nome
    // ── COLLATE necessário: planos_avaliacao usa utf8mb4_0900_ai_ci,
    //    turmas/disciplinas usam utf8mb4_unicode_ci — collations incompatíveis.
    // ── diario_fechado: não é coluna de planos_avaliacao, vem de diario_fechamento (tabela separada)
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
        p.id               AS professor_id,
        p.nome             AS professor_nome
      FROM planos_avaliacao pa
      -- Liga pelo NOME da turma com COLLATE para resolver conflito de charset
      JOIN turmas t
        ON CONVERT(t.nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
         = CONVERT(pa.turmas USING utf8mb4) COLLATE utf8mb4_unicode_ci
       AND t.escola_id = pa.escola_id
       AND t.ano       = pa.ano
      -- Liga pelo NOME da disciplina com COLLATE
      JOIN disciplinas d
        ON CONVERT(d.nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
         = CONVERT(pa.disciplina USING utf8mb4) COLLATE utf8mb4_unicode_ci
       AND d.escola_id = pa.escola_id
      -- Obtém o professor via modulação (IDs resolvidos pelos JOINs acima)
      LEFT JOIN modulacao mo
        ON mo.turma_id      = t.id
       AND mo.disciplina_id = d.id
       AND mo.escola_id     = pa.escola_id
      LEFT JOIN professores p
        ON p.id = mo.professor_id
      -- Verifica se o diário foi fechado (tabela separada)
      LEFT JOIN diario_fechamento df
        ON df.plano_id  = pa.id
       AND df.turma_id  = t.id
       AND df.escola_id = pa.escola_id
      WHERE pa.escola_id = ?
        AND pa.ano       = ?
        ${extraFilter}
      ORDER BY p.nome, t.nome, pa.disciplina
    `;


    const [rows] = await pool.query(sql, params);

    return res.json({ ok: true, diarios: rows });
  } catch (err) {
    console.error('[relatorios] diarios:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao listar diários.' });
  }
});

export default router;
