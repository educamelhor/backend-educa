// routes/secretaria-relatorios.js
// ============================================================================
// Rotas de relatórios da Secretaria
// Todos os endpoints são protegidos por escola_id (via req.user)
// ============================================================================

import express from 'express';
import pool from '../db.js';

const router = express.Router();

// Helper: ano letivo padrão com data de corte em 31/jan
function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// ============================================================================
// 1) RELATÓRIO SINTÉTICO DE MATRÍCULAS
// GET /api/secretaria/relatorios/sintetico-matriculas
// Query: ano_letivo, turno
// Retorna: contagem de alunos ativos por série (6º, 7º, 8º, 9º Ano)
// ============================================================================
router.get('/sintetico-matriculas', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano_letivo, turno } = req.query;
    const anoEfetivo = ano_letivo ? Number(ano_letivo) : anoLetivoPadrao();

    // Parâmetros base
    const params = [escola_id, anoEfetivo];
    let turnoFilter = '';
    if (turno && turno !== 'todos') {
      turnoFilter = 'AND UPPER(t.turno) = UPPER(?)';
      params.push(turno);
    }

    // Contagem por série (extraída do nome da turma: "6º ANO", "7º ANO", etc.)
    const sql = `
      SELECT
        CASE
          WHEN t.nome LIKE '6%' OR t.nome LIKE '6º%' OR t.nome LIKE '6 %' THEN '6º Ano'
          WHEN t.nome LIKE '7%' OR t.nome LIKE '7º%' OR t.nome LIKE '7 %' THEN '7º Ano'
          WHEN t.nome LIKE '8%' OR t.nome LIKE '8º%' OR t.nome LIKE '8 %' THEN '8º Ano'
          WHEN t.nome LIKE '9%' OR t.nome LIKE '9º%' OR t.nome LIKE '9 %' THEN '9º Ano'
          ELSE 'Outra'
        END AS serie,
        t.turno,
        COUNT(DISTINCT m.aluno_id) AS total
      FROM matriculas m
      INNER JOIN turmas t ON t.id = m.turma_id
      WHERE m.escola_id = ?
        AND m.ano_letivo = ?
        AND m.status = 'ativo'
        ${turnoFilter}
      GROUP BY serie, t.turno
      ORDER BY
        CASE serie
          WHEN '6º Ano' THEN 1
          WHEN '7º Ano' THEN 2
          WHEN '8º Ano' THEN 3
          WHEN '9º Ano' THEN 4
          ELSE 5
        END,
        t.turno
    `;

    const [rows] = await pool.query(sql, params);

    // Total geral
    const total = rows.reduce((acc, r) => acc + Number(r.total), 0);

    // Resumo por série (agrupando turnos)
    const porSerie = {};
    for (const row of rows) {
      if (!porSerie[row.serie]) {
        porSerie[row.serie] = { serie: row.serie, total: 0, turnos: {} };
      }
      porSerie[row.serie].total += Number(row.total);
      porSerie[row.serie].turnos[row.turno] = (porSerie[row.serie].turnos[row.turno] || 0) + Number(row.total);
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
// GET /api/secretaria/relatorios/idades
// Query: ano_letivo, turno, idade_min, idade_max, serie
// Retorna: distribuição de alunos por faixa etária
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
      // Série: "6", "7", "8", "9"
      extraFilters += ` AND (t.nome LIKE ? OR t.nome LIKE ? OR t.nome LIKE ?)`;
      params.push(`${serie}%`, `${serie}º%`, `${serie} %`);
    }

    const sql = `
      SELECT
        a.id,
        a.estudante,
        a.data_nascimento,
        TIMESTAMPDIFF(YEAR, a.data_nascimento, CURDATE()) AS idade,
        t.nome AS turma,
        t.turno,
        CASE
          WHEN t.nome LIKE '6%' OR t.nome LIKE '6º%' OR t.nome LIKE '6 %' THEN '6º Ano'
          WHEN t.nome LIKE '7%' OR t.nome LIKE '7º%' OR t.nome LIKE '7 %' THEN '7º Ano'
          WHEN t.nome LIKE '8%' OR t.nome LIKE '8º%' OR t.nome LIKE '8 %' THEN '8º Ano'
          WHEN t.nome LIKE '9%' OR t.nome LIKE '9º%' OR t.nome LIKE '9 %' THEN '9º Ano'
          ELSE 'Outra'
        END AS serie
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

    // Distribuição por faixas etárias
    const faixas = [
      { label: 'Até 11 anos',   min: 0,  max: 11  },
      { label: '12 anos',       min: 12, max: 12  },
      { label: '13 anos',       min: 13, max: 13  },
      { label: '14 anos',       min: 14, max: 14  },
      { label: '15 anos',       min: 15, max: 15  },
      { label: '16 anos',       min: 16, max: 16  },
      { label: '17 anos',       min: 17, max: 17  },
      { label: '18 anos ou +',  min: 18, max: 999 },
    ];

    const distribuicao = faixas.map(f => ({
      ...f,
      total: rows.filter(r => r.idade >= f.min && r.idade <= f.max).length,
    }));

    // Sem data de nascimento — busca separada
    const sqlSemDob = `
      SELECT COUNT(DISTINCT m.aluno_id) AS sem_dob
      FROM matriculas m
      INNER JOIN alunos a ON a.id = m.aluno_id
      WHERE m.escola_id = ?
        AND m.ano_letivo = ?
        AND m.status = 'ativo'
        AND a.data_nascimento IS NULL
    `;
    const [[{ sem_dob }]] = await pool.query(sqlSemDob, [escola_id, anoEfetivo]);

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
// GET /api/secretaria/relatorios/turmas
// Retorna: lista de turmas com total de alunos
// ============================================================================
router.get('/turmas', async (req, res) => {
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

    const sql = `
      SELECT
        t.id AS turma_id,
        t.nome AS turma,
        t.turno,
        CASE
          WHEN t.nome LIKE '6%' OR t.nome LIKE '6º%' THEN '6º Ano'
          WHEN t.nome LIKE '7%' OR t.nome LIKE '7º%' THEN '7º Ano'
          WHEN t.nome LIKE '8%' OR t.nome LIKE '8º%' THEN '8º Ano'
          WHEN t.nome LIKE '9%' OR t.nome LIKE '9º%' THEN '9º Ano'
          ELSE 'Outra'
        END AS serie,
        COUNT(DISTINCT m.aluno_id) AS total_alunos
      FROM turmas t
      INNER JOIN matriculas m ON m.turma_id = t.id AND m.ano_letivo = ? AND m.status = 'ativo'
      WHERE t.escola_id = ?
        ${turnoFilter}
      GROUP BY t.id, t.nome, t.turno
      ORDER BY
        CASE
          WHEN t.nome LIKE '6%' THEN 1
          WHEN t.nome LIKE '7%' THEN 2
          WHEN t.nome LIKE '8%' THEN 3
          WHEN t.nome LIKE '9%' THEN 4
          ELSE 5
        END,
        t.nome
    `;

    // Reordenar params: para GROUP BY com escola_id e ano_letivo corretos
    const [rows] = await pool.query(sql, [anoEfetivo, escola_id, ...(turno && turno !== 'todos' ? [turno] : [])]);

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
// GET /api/secretaria/relatorios/genero
// Retorna: distribuição por sexo (M/F) por série e turno
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

    const sql = `
      SELECT
        CASE
          WHEN t.nome LIKE '6%' OR t.nome LIKE '6º%' THEN '6º Ano'
          WHEN t.nome LIKE '7%' OR t.nome LIKE '7º%' THEN '7º Ano'
          WHEN t.nome LIKE '8%' OR t.nome LIKE '8º%' THEN '8º Ano'
          WHEN t.nome LIKE '9%' OR t.nome LIKE '9º%' THEN '9º Ano'
          ELSE 'Outra'
        END AS serie,
        COALESCE(UPPER(a.sexo), 'NÃO INFORMADO') AS sexo,
        COUNT(DISTINCT m.aluno_id) AS total
      FROM matriculas m
      INNER JOIN alunos a ON a.id = m.aluno_id
      INNER JOIN turmas t ON t.id = m.turma_id
      WHERE m.escola_id = ?
        AND m.ano_letivo = ?
        AND m.status = 'ativo'
        ${turnoFilter}
      GROUP BY serie, sexo
      ORDER BY
        CASE serie
          WHEN '6º Ano' THEN 1
          WHEN '7º Ano' THEN 2
          WHEN '8º Ano' THEN 3
          WHEN '9º Ano' THEN 4
          ELSE 5
        END,
        sexo
    `;

    const [rows] = await pool.query(sql, params);

    const totais = { M: 0, F: 0, outro: 0, total: 0 };
    for (const r of rows) {
      const n = Number(r.total);
      totais.total += n;
      if (r.sexo === 'M') totais.M += n;
      else if (r.sexo === 'F') totais.F += n;
      else totais.outro += n;
    }

    return res.json({
      ano_letivo: anoEfetivo,
      totais,
      detalhado: rows,
    });
  } catch (err) {
    console.error('[relatorios] genero:', err);
    return res.status(500).json({ message: 'Erro ao gerar relatório de gênero.' });
  }
});

// ============================================================================
// 5) ANOS LETIVOS DISPONÍVEIS (helper compartilhado)
// GET /api/secretaria/relatorios/anos-letivos
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

export default router;
