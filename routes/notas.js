// routes/notas.js
// ============================================================================
// Rotas de NOTAS
// - GET /alunos/:id/notas                   → lista notas do aluno (todas, 2024+2025)
// - GET /alunos/:alunoId/ranking            → ranking (ESCOLA) do aluno (apenas 2025)
// - GET /alunos/:alunoId/ranking-completo   → ranking ESCOLA + TURMA (apenas 2025)
// Regras solicitadas:
//   • O RANKING deve considerar SOMENTE 2025.
//   • A soma de notas no front continua usando todas as notas (nenhuma mudança aqui).
// ============================================================================

import express from "express";
import db from "../db.js";

const router = express.Router();

// Ano-base do ranking
const ANO_RANKING = 2025;

// ---------------------------------------------------------------------------
// Middleware anti-cache (evita 304 e "Calculando..." no front)
// Aplica-se a TODAS as rotas deste router.
// ---------------------------------------------------------------------------
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  if (typeof res.removeHeader === "function") res.removeHeader("ETag");
  next();
});

// ---------------------------------------------------------------------------
// Middleware: exige que req.user.escola_id exista (mantido para compatibilidade)
// Usado apenas na LISTAGEM de notas (não no ranking).
// ---------------------------------------------------------------------------
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /alunos/:id/notas
// Lista notas do aluno, apenas se ele pertencer à escola do usuário
// (RETORNA TODAS AS NOTAS – 2024 e 2025 – para manter a soma no rodapé)
// ---------------------------------------------------------------------------
router.get("/alunos/:id/notas", verificarEscola, async (req, res) => {
  try {
    const alunoId = req.params.id;
    const { escola_id } = req.user;

    const [rows] = await db.query(
      `SELECT 
         d.nome      AS disciplina,
         n.disciplina_id,
         n.ano,
         n.bimestre,
         n.nota,
         n.faltas,
         n.aluno_id
       FROM notas n
       LEFT JOIN disciplinas d ON d.id = n.disciplina_id
       LEFT JOIN alunos a ON a.id = n.aluno_id
       WHERE n.aluno_id = ? AND a.escola_id = ?
       ORDER BY n.ano, n.bimestre, d.nome`,
      [alunoId, escola_id]
    );

    return res.status(200).json(rows);
  } catch (err) {
    console.warn("Notas não encontradas ou erro:", err?.code, err?.message);
    return res.status(200).json([]);
  }
});

// ---------------------------------------------------------------------------
// GET /alunos/:alunoId/ranking
// Ranking do aluno em relação aos demais da ESCOLA (APENAS 2025)
// • Mantido para compatibilidade (Boletim.jsx usa este formato simples).
// ---------------------------------------------------------------------------
router.get("/alunos/:alunoId/ranking", async (req, res) => {
  const alunoId = req.params.alunoId;

  try {
    // 1) Descobrir a escola do aluno
    const [alunoRes] = await db.query(
      "SELECT escola_id FROM alunos WHERE id = ?",
      [alunoId]
    );
    if (!alunoRes.length) {
      return res.status(200).json({ ranking: null, total_alunos: 0, total_notas: 0 });
    }
    const escola_id = alunoRes[0].escola_id;

    // 2) Calcular ranking (somente 2025)
    const [result] = await db.query(
      `
      SELECT
          t1.aluno_id,
          t1.total_notas,
          (
              SELECT COUNT(*) + 1
              FROM (
                  SELECT a.id AS aluno_id, SUM(n.nota) AS soma
                  FROM notas n
                  JOIN alunos a ON a.id = n.aluno_id
                  WHERE n.ano = ? AND a.escola_id = ?
                  GROUP BY a.id
              ) t2
              WHERE t2.soma > t1.total_notas
          ) AS ranking,
          (
              SELECT COUNT(DISTINCT a.id)
              FROM notas n
              JOIN alunos a ON a.id = n.aluno_id
              WHERE n.ano = ? AND a.escola_id = ?
          ) AS total_alunos
      FROM (
          SELECT a.id AS aluno_id, SUM(n.nota) AS total_notas
          FROM notas n
          JOIN alunos a ON a.id = n.aluno_id
          WHERE n.ano = ? AND a.escola_id = ?
          GROUP BY a.id
      ) t1
      WHERE t1.aluno_id = ?
      `,
      [
        ANO_RANKING, escola_id,     // quem está à frente
        ANO_RANKING, escola_id,     // total participantes (com notas 2025)
        ANO_RANKING, escola_id,     // soma do próprio aluno (2025)
        alunoId
      ]
    );

    if (result.length === 0) {
      return res.status(200).json({ ranking: null, total_alunos: 0, total_notas: 0 });
    }

    return res.json({
      ranking: result[0].ranking,
      total_alunos: result[0].total_alunos,
      total_notas: result[0].total_notas
    });
  } catch (err) {
    console.error("Erro ao calcular ranking:", err);
    return res.status(500).json({ ranking: null, total_alunos: 0, total_notas: 0 });
  }
});

// ---------------------------------------------------------------------------
// GET /alunos/:alunoId/ranking-completo
// Ranking do aluno por ESCOLA e TURMA (APENAS 2025)
// • Formato compatível com o fluxo de impressão/BoletimPrint:
//   { escola: { ranking, total_alunos, semNotas }, turma: { ... } }
// ---------------------------------------------------------------------------
router.get("/alunos/:alunoId/ranking-completo", async (req, res) => {
  const alunoId = req.params.alunoId;

  try {
    // 1) Escola e turma do aluno
    const [alRes] = await db.query(
      "SELECT escola_id, turma_id FROM alunos WHERE id = ?",
      [alunoId]
    );
    if (!alRes.length) {
      return res.status(200).json({
        escola: { ranking: 0, total_alunos: 0, semNotas: true },
        turma:  { ranking: 0, total_alunos: 0, semNotas: true }
      });
    }
    const { escola_id, turma_id } = alRes[0];

    // 2) Soma 2025 do aluno (se não tiver, ele não entra no ranking)
    const [somaRes] = await db.query(
      "SELECT SUM(n.nota) AS soma FROM notas n WHERE n.aluno_id = ? AND n.ano = ?",
      [alunoId, ANO_RANKING]
    );
    const soma2025 = somaRes[0]?.soma;

    // 3) Totais de participantes (com notas 2025)
    const [[{ total: totalEscola }]] = await db.query(
      `
      SELECT COUNT(*) AS total FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
        FROM alunos a
        JOIN notas n ON n.aluno_id = a.id
        WHERE a.escola_id = ? AND n.ano = ?
        GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) x
      `,
      [escola_id, ANO_RANKING]
    );
    const [[{ total: totalTurma }]] = await db.query(
      `
      SELECT COUNT(*) AS total FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
        FROM alunos a
        JOIN notas n ON n.aluno_id = a.id
        WHERE a.turma_id = ? AND n.ano = ?
        GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) x
      `,
      [turma_id, ANO_RANKING]
    );

    // 4) Se o aluno não tem notas 2025, marcar semNotas
    if (!soma2025) {
      return res.json({
        escola: { ranking: totalEscola || 0, total_alunos: totalEscola || 0, semNotas: true },
        turma:  { ranking: totalTurma  || 0, total_alunos: totalTurma  || 0, semNotas: true }
      });
    }

    // 5) Posições (conta quantos têm soma maior + 1)
    const [[{ posicao: posEscola }]] = await db.query(
      `
      SELECT COUNT(*) + 1 AS posicao
      FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
        FROM alunos a
        JOIN notas n ON n.aluno_id = a.id
        WHERE a.escola_id = ? AND n.ano = ?
        GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) r
      WHERE r.soma_notas > (
        SELECT SUM(n2.nota) FROM notas n2 WHERE n2.aluno_id = ? AND n2.ano = ?
      )
      `,
      [escola_id, ANO_RANKING, alunoId, ANO_RANKING]
    );

    const [[{ posicao: posTurma }]] = await db.query(
      `
      SELECT COUNT(*) + 1 AS posicao
      FROM (
        SELECT a.id, SUM(n.nota) AS soma_notas
        FROM alunos a
        JOIN notas n ON n.aluno_id = a.id
        WHERE a.turma_id = ? AND n.ano = ?
        GROUP BY a.id
        HAVING soma_notas IS NOT NULL
      ) r
      WHERE r.soma_notas > (
        SELECT SUM(n2.nota) FROM notas n2 WHERE n2.aluno_id = ? AND n2.ano = ?
      )
      `,
      [turma_id, ANO_RANKING, alunoId, ANO_RANKING]
    );

    return res.json({
      escola: { ranking: posEscola || 1, total_alunos: totalEscola || 0, semNotas: false },
      turma:  { ranking: posTurma  || 1, total_alunos: totalTurma  || 0, semNotas: false }
    });
  } catch (err) {
    console.error("Erro ao calcular ranking-completo:", err);
    return res.status(500).json({
      escola: { ranking: 0, total_alunos: 0, semNotas: true },
      turma:  { ranking: 0, total_alunos: 0, semNotas: true }
    });
  }
});

export default router;
