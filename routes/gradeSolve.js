// routes/gradeSolve.js
// -----------------------------------------------------------------------------
// Pré-solve (validações) + montagem do payload do solver.
// POST /api/grade/solve  { turno, turma_ids: [...]}  (aceita também turmaIds)
// -----------------------------------------------------------------------------
// Notas:
// - Normalizamos snake_case/camelCase para maior robustez.
// - Sempre retornamos { pre_solve, payload }.
// - validatePreSolve usa pool; buildSolverPayload importa pool internamente.
// -----------------------------------------------------------------------------

import express from "express";
import pool from "../db.js";
import { validatePreSolve } from "../services/gradeValidationService.js";
import { buildSolverPayload } from "../services/solverPayloadService.js";

const router = express.Router();

// Middleware simples: exige escola_id (vem do token)
function requireEscola(req, res, next) {
  const escolaId = req.user?.escola_id || Number(req.headers["x-escola-id"]);
  if (!escolaId) return res.status(403).json({ error: "Acesso negado: escola não definida." });
  req.escolaId = escolaId;
  next();
}

router.post("/solve", requireEscola, async (req, res) => {
  try {
    const escolaId = req.escolaId;

    // Normalização de campos do body
    const body = req.body || {};
    const turno = String(body.turno || "").trim();
    const turmaIds = Array.isArray(body.turmaIds)
      ? body.turmaIds
      : Array.isArray(body.turma_ids)
      ? body.turma_ids
      : [];

    if (!turno) return res.status(400).json({ error: "turno obrigatório." });
    if (!turmaIds.length) return res.status(400).json({ error: "Envie ao menos 1 turma no escopo." });

    // 1) Validações de consistência (pré-solve)
    const pre = await validatePreSolve(pool, {
      escolaId,
      turno,
      turmaIds: turmaIds.map(Number).filter((n) => Number.isFinite(n) && n > 0),
    });

    // 2) Montagem do payload para o solver
    //    (buildSolverPayload já importa o pool internamente)
    const payload = await buildSolverPayload({
      escolaId,
      turno,
      turmaIds,
    });

    // Observação: mesmo havendo 'errors' no pré-solve, devolvemos payload
    // para inspeção no front. O front decide se bloqueia o próximo passo.
    return res.json({
      pre_solve: { errors: pre.errors || [], warnings: pre.warnings || [], stats: pre.stats || {} },
      payload,
    });
  } catch (err) {
    console.error("POST /api/grade/solve:", err);
    return res.status(500).json({ error: "Erro ao executar o pré-solve." });
  }
});

export default router;
