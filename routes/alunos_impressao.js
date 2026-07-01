// routes/alunos_impressao.js
// ============================================================================
// Rotas relacionadas à impressão de boletins
// Agora retornando RANKING por ESCOLA e também por TURMA
// Fix (2026): usa tabela `matriculas` (igual à Fiscalização de Notas) para
// buscar alunos da turma, evitando o campo legado `alunos.turma_id` que
// aponta para turmas de anos anteriores.
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

// Ano-base do ranking — usa o ano letivo atual
const ANO_RANKING = new Date().getFullYear();


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
// FIX 2026: usa tabela `matriculas` (igual à Fiscalização de Notas) em vez
// de `alunos.turma_id` (campo legado que aponta para turmas de anos anteriores)
// -------------------------------------------------------------------------
router.get("/impressao/boletins", async (req, res) => {
  try {
    const { turma_id } = req.query;

    if (!turma_id) {
      return res
        .status(400)
        .json({ error: "Parâmetro turma_id é obrigatório." });
    }

    // ── Descobrir o ano letivo da turma (usa o maior ano_letivo nas matrículas) ──
    const [[turmaInfo]] = await pool.query(
      `SELECT t.id, t.nome AS turma, t.turno, t.etapa, t.escola_id,
              MAX(m.ano_letivo) AS ano_letivo
         FROM turmas t
         LEFT JOIN matriculas m ON m.turma_id = t.id AND m.status = 'ativo'
        WHERE t.id = ?
        GROUP BY t.id`,
      [turma_id]
    );

    if (!turmaInfo) {
      return res.json({ turma_id, total: 0, alunos: [] });
    }

    const anoLetivo = turmaInfo.ano_letivo || new Date().getFullYear();
    const escolaIdTurma = turmaInfo.escola_id;

    // 1) Buscar alunos via tabela MATRICULAS (igual à Fiscalização de Notas)
    //    Garante alunos matriculados no ano letivo correto, independente do
    //    campo legado `alunos.turma_id`.
    const [alunosDados] = await pool.query(
      `SELECT
         a.id,
         a.codigo,
         a.estudante AS nome,
         ? AS turma,
         ? AS turno,
         ? AS turma_id,
         a.status,
         a.escola_id,
         ? AS etapa
       FROM matriculas m
       INNER JOIN alunos a ON a.id = m.aluno_id
       WHERE m.turma_id = ?
         AND m.escola_id = ?
         AND m.ano_letivo = ?
         AND m.status = 'ativo'
       ORDER BY a.estudante`,
      [
        turmaInfo.turma,
        turmaInfo.turno,
        turmaInfo.id,
        turmaInfo.etapa,
        turma_id,
        escolaIdTurma,
        anoLetivo,
      ]
    );

    if (alunosDados.length === 0) {
      return res.json({ turma_id, total: 0, alunos: [] });
    }

    // 2) Buscar notas filtradas por escola_id — IGUAL à Fiscalização de Notas.
    //    Não filtra por ano para retornar todos os bimestres disponíveis.
    const alunoIds = alunosDados.map((a) => a.id);
    const [notas] = await pool.query(
      `SELECT
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
       WHERE n.aluno_id IN (?)
         AND n.escola_id = ?
       ORDER BY n.ano, n.bimestre, d.nome`,
      [alunoIds, escolaIdTurma]
    );

    // 3) Buscar ranking (escola e turma) — ano letivo atual
    const rankings = {};
    for (const aluno of alunosDados) {
      rankings[aluno.codigo] = await calculaRankings(aluno, anoLetivo);
    }

    // 4) Montar estrutura final
    const boletins = alunosDados.map((aluno) => {
      return {
        id: aluno.id,
        escola_id: aluno.escola_id,
        etapa: aluno.etapa,
        codigo: aluno.codigo,
        nome: aluno.nome,
        turma: aluno.turma,
        turno: aluno.turno,
        situacao: aluno.status,
        ranking: rankings[aluno.codigo] || null,
        notas: notas
          .filter((n) => Number(n.aluno_id) === Number(aluno.id))
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
      a.escola_id,
      t.etapa
    FROM alunos a
    INNER JOIN turmas t ON a.turma_id = t.id
    WHERE a.codigo IN (?)
    `,
    [codigos]
  );

  // Consulta para buscar as notas de cada aluno filtrando por n.escola_id
  // (espelha exatamente o critério da Fiscalização de Notas)
  const alunoIds = alunosDados.map((a) => a.id);
  const escolaId = alunosDados[0]?.escola_id;
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
    WHERE n.aluno_id IN (?)
      AND n.escola_id = ?
    ORDER BY n.ano, n.bimestre, d.nome
    `,
    [alunoIds, escolaId]
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
      escola_id: aluno.escola_id,
      etapa: aluno.etapa,
      nome: aluno.nome,
      turma: aluno.turma,
      turno: aluno.turno,
      situacao: aluno.status,
      ranking: rankings[aluno.codigo] || null,
      notas: notas
        // Filtra por aluno_id (número) — garante match correto
        .filter((n) => Number(n.aluno_id) === Number(aluno.id))
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
// Função auxiliar: calcula ranking ESCOLA e TURMA (ano letivo corrente)
// ============================================================================
async function calculaRankings(aluno, anoRanking = ANO_RANKING) {
  // Soma das notas do aluno — ano letivo atual
  const [somaNotasAluno] = await pool.query(
    `SELECT SUM(n.nota) AS soma 
       FROM notas n 
      WHERE n.aluno_id = ? 
        AND n.ano = ?`,
    [aluno.id, anoRanking]
  );
  const soma2025 = somaNotasAluno[0]?.soma;

  // Total de alunos da escola COM notas no ano letivo atual
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
    [aluno.escola_id, anoRanking]
  );

  // Total de alunos da turma COM notas no ano letivo atual
  const [totalTurma] = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM (
      SELECT a.id
        FROM matriculas m
        INNER JOIN alunos a ON a.id = m.aluno_id
        INNER JOIN notas n ON n.aluno_id = a.id
       WHERE m.turma_id = ?
         AND m.ano_letivo = ?
         AND m.status = 'ativo'
         AND n.ano = ?
       GROUP BY a.id
      HAVING SUM(n.nota) IS NOT NULL
    ) sub
    `,
    [aluno.turma_id, anoRanking, anoRanking]
  );

  // Se o aluno não tem notas no ano letivo atual, ele não entra no ranking
  if (!soma2025) {
    return {
      escola: {
        ranking: totalEscola[0]?.total || 0,
        total_alunos: totalEscola[0]?.total || 0,
        semNotas: true,
      },
      turma: {
        ranking: totalTurma[0]?.total || 0,
        total_alunos: totalTurma[0]?.total || 0,
        semNotas: true,
      },
    };
  }

  // Ranking por escola (ano letivo atual)
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
    [aluno.escola_id, anoRanking, aluno.id, anoRanking]
  );

  // Ranking por turma (ano letivo atual, via matriculas)
  const [posTurma] = await pool.query(
    `
    SELECT COUNT(*) + 1 AS posicao
      FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
          FROM matriculas m
          INNER JOIN alunos a ON a.id = m.aluno_id
          INNER JOIN notas n ON n.aluno_id = a.id
         WHERE m.turma_id = ?
           AND m.ano_letivo = ?
           AND m.status = 'ativo'
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
    [aluno.turma_id, anoRanking, anoRanking, aluno.id, anoRanking]
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
