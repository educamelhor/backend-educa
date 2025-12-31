// routes/alunos_impressao.js
// ============================================================================
// Rotas relacionadas à impressão de boletins
// Agora retornando RANKING por ESCOLA e também por TURMA
// Ajuste (2025): ranking considera APENAS notas do ano 2025.
// A soma de notas no front continua somando 2024 + 2025 (sem mudanças aqui).
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

// Ano-base do ranking
const ANO_RANKING = 2025;

// -------------------------------------------------------------------------
// POST /api/impressao/boletins
// Objetivo: receber lista de alunos (via body) e retornar seus boletins
// -------------------------------------------------------------------------
router.post("/impressao/boletins", async (req, res) => {
  try {
    const { alunos } = req.body;

    if (!alunos || alunos.length === 0) {
      return res.status(400).json({ error: "Nenhum aluno enviado." });
    }

    // Extrair apenas os códigos dos alunos recebidos
    const codigos = alunos.map((a) => a.codigo);

    const boletins = await montaBoletins(pool, { codigos });
    res.json({ boletins });
  } catch (err) {
    console.error("Erro ao buscar boletins (POST):", err);
    res.status(500).json({ error: "Erro ao buscar boletins." });
  }
});

// -------------------------------------------------------------------------
// GET /api/impressao/boletins?turma_id=123
// Objetivo: buscar todos os alunos de uma turma e retornar boletins completos
// -------------------------------------------------------------------------
router.get("/impressao/boletins", async (req, res) => {
  try {
    const { turma_id } = req.query;

    if (!turma_id) {
      return res
        .status(400)
        .json({ error: "Parâmetro turma_id é obrigatório." });
    }

    // 1) Buscar alunos da turma
    const [alunosDados] = await pool.query(
      `
      SELECT 
        a.id,
        a.codigo,
        a.estudante AS nome,
        t.nome AS turma,
        t.turno,
        t.id AS turma_id,
        a.status,
        a.escola_id
      FROM alunos a
      INNER JOIN turmas t ON a.turma_id = t.id
      WHERE a.turma_id = ?
      ORDER BY a.estudante
      `,
      [turma_id]
    );

    if (alunosDados.length === 0) {
      return res.json({ turma_id, total: 0, alunos: [] });
    }

    // 2) Buscar notas desses alunos (todas, 2024+2025) — soma do rodapé depende disso
    const codigos = alunosDados.map((a) => a.codigo);
    const [notas] = await pool.query(
      `
      SELECT 
        n.aluno_id,
        a.codigo AS aluno_codigo,
        d.nome AS disciplina,
        n.nota,
        n.faltas,
        n.ano,
        n.bimestre,
        d.id AS disciplina_id
      FROM notas n
      INNER JOIN disciplinas d ON n.disciplina_id = d.id
      INNER JOIN alunos a ON n.aluno_id = a.id
      WHERE a.codigo IN (?)
      `,
      [codigos]
    );

    // 3) Buscar ranking (escola e turma) — APENAS 2025
    const rankings = {};
    for (const aluno of alunosDados) {
      rankings[aluno.codigo] = await calculaRankings(aluno);
    }

    // 4) Montar estrutura final
    const boletins = alunosDados.map((aluno) => {
      return {
        id: aluno.id,
        codigo: aluno.codigo,
        nome: aluno.nome,
        turma: aluno.turma,
        turno: aluno.turno,
        situacao: aluno.status,
        ranking: rankings[aluno.codigo] || null, // inclui ranking escola + turma (2025)
        notas: notas
          .filter((n) => n.aluno_codigo === aluno.codigo)
          .map((n) => ({
            disciplina_id: n.disciplina_id,
            disciplina: n.disciplina,
            nota: n.nota,
            faltas: n.faltas,
            ano: n.ano,
            bimestre: n.bimestre,
            estudante: aluno.nome,
            turma: aluno.turma,
            turno: aluno.turno,
          })),
      };
    });

    res.json({ turma_id, total: boletins.length, alunos: boletins });
  } catch (err) {
    console.error("Erro ao buscar boletins (GET):", err);
    res.status(500).json({ error: "Erro ao buscar boletins da turma." });
  }
});

export default router;

// ============================================================================
// Função auxiliar: monta boletins a partir de lista de códigos de alunos
// Agora também busca ranking de cada aluno a nível de escola e turma (2025)
// ============================================================================
async function montaBoletins(pool, { codigos }) {
  // Consulta principal para buscar dados dos alunos + turma
  const [alunosDados] = await pool.query(
    `
    SELECT 
      a.id,
      a.codigo,
      a.estudante AS nome,
      t.nome AS turma,
      t.turno,
      t.id AS turma_id,
      a.status,
      a.escola_id
    FROM alunos a
    INNER JOIN turmas t ON a.turma_id = t.id
    WHERE a.codigo IN (?)
    `,
    [codigos]
  );

  // Consulta para buscar as notas de cada aluno (todas, 2024+2025)
  const [notas] = await pool.query(
    `
    SELECT 
      n.aluno_id,
      a.codigo AS aluno_codigo,
      d.nome AS disciplina,
      n.nota,
      n.faltas,
      n.ano,
      n.bimestre,
      d.id AS disciplina_id
    FROM notas n
    INNER JOIN disciplinas d ON n.disciplina_id = d.id
    INNER JOIN alunos a ON n.aluno_id = a.id
    WHERE a.codigo IN (?)
    `,
    [codigos]
  );

  // Buscar rankings (escola e turma) — APENAS 2025
  const rankings = {};
  for (const aluno of alunosDados) {
    rankings[aluno.codigo] = await calculaRankings(aluno);
  }

  // Montar estrutura final de resposta
  return alunosDados.map((aluno) => {
    return {
      codigo: aluno.codigo,
      nome: aluno.nome,
      turma: aluno.turma,
      turno: aluno.turno,
      situacao: aluno.status,
      ranking: rankings[aluno.codigo] || null,
      notas: notas
        .filter((n) => n.aluno_codigo === aluno.codigo)
        .map((n) => ({
          disciplina_id: n.disciplina_id,
          disciplina: n.disciplina,
          nota: n.nota,
          faltas: n.faltas,
          ano: n.ano,
          bimestre: n.bimestre,
          estudante: aluno.nome,
          turma: aluno.turma,
          turno: aluno.turno,
        })),
    };
  });
}

// ============================================================================
// Função auxiliar: calcula ranking ESCOLA e TURMA (apenas ano 2025)
// ============================================================================
async function calculaRankings(aluno) {
  // Soma das notas do aluno — somente 2025
  const [somaNotasAluno] = await pool.query(
    `SELECT SUM(n.nota) AS soma 
       FROM notas n 
      WHERE n.aluno_id = ? 
        AND n.ano = ?`,
    [aluno.id, ANO_RANKING]
  );
  const soma2025 = somaNotasAluno[0]?.soma;

  // Total de alunos da escola COM notas em 2025
  const [totalEscola] = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM (
      SELECT a.id
        FROM alunos a
        INNER JOIN notas n ON n.aluno_id = a.id
       WHERE a.escola_id = ?
         AND n.ano = ?
       GROUP BY a.id
      HAVING SUM(n.nota) IS NOT NULL
    ) sub
    `,
    [aluno.escola_id, ANO_RANKING]
  );

  // Total de alunos da turma COM notas em 2025
  const [totalTurma] = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM (
      SELECT a.id
        FROM alunos a
        INNER JOIN notas n ON n.aluno_id = a.id
       WHERE a.turma_id = ?
         AND n.ano = ?
       GROUP BY a.id
      HAVING SUM(n.nota) IS NOT NULL
    ) sub
    `,
    [aluno.turma_id, ANO_RANKING]
  );

  // Se o aluno não tem notas em 2025, ele não entra no ranking
  if (!soma2025) {
    return {
      escola: {
        ranking: totalEscola[0]?.total || 0,
        total_alunos: totalEscola[0]?.total || 0,
        semNotas: true, // sem notas em 2025
      },
      turma: {
        ranking: totalTurma[0]?.total || 0,
        total_alunos: totalTurma[0]?.total || 0,
        semNotas: true, // sem notas em 2025
      },
    };
  }

  // Ranking por escola (somente 2025)
  const [posEscola] = await pool.query(
    `
    SELECT COUNT(*) + 1 AS posicao
      FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
          FROM alunos a
          INNER JOIN notas n ON n.aluno_id = a.id
         WHERE a.escola_id = ?
           AND n.ano = ?
         GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) ranking
     WHERE ranking.soma_notas > (
        SELECT SUM(n2.nota)
          FROM alunos a2
          INNER JOIN notas n2 ON n2.aluno_id = a2.id
         WHERE a2.id = ?
           AND n2.ano = ?
     )
    `,
    [aluno.escola_id, ANO_RANKING, aluno.id, ANO_RANKING]
  );

  // Ranking por turma (somente 2025)
  const [posTurma] = await pool.query(
    `
    SELECT COUNT(*) + 1 AS posicao
      FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
          FROM alunos a
          INNER JOIN notas n ON n.aluno_id = a.id
         WHERE a.turma_id = ?
           AND n.ano = ?
         GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) ranking
     WHERE ranking.soma_notas > (
        SELECT SUM(n2.nota)
          FROM alunos a2
          INNER JOIN notas n2 ON n2.aluno_id = a2.id
         WHERE a2.id = ?
           AND n2.ano = ?
     )
    `,
    [aluno.turma_id, ANO_RANKING, aluno.id, ANO_RANKING]
  );

  return {
    escola: {
      ranking: posEscola[0]?.posicao || 1,
      total_alunos: totalEscola[0]?.total || 0,
      semNotas: false,
    },
    turma: {
      ranking: posTurma[0]?.posicao || 1,
      total_alunos: totalTurma[0]?.total || 0,
      semNotas: false,
    },
  };
}
