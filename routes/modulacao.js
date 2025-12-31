// routes/modulacao.js
// ============================================================================
// ROTAS: Grade Horária (Secretaria → Horários)
// ----------------------------------------------------------------------------
// - GET    /api/modulacao                      → Lista a grade de um turno (turmas + alocações)
// - POST   /api/modulacao                      → (LEGADO) Upsert item-a-item (compatibilidade)
// - POST   /api/modulacao/upsert               → (NOVO) UPSERT em lote (performático)
// - POST   /api/modulacao/remover              → Remoção em lote (batch delete)
// - DELETE /api/modulacao/:prof/:turma/:disc   → Remoção 1-a-1 (fallback)
// ----------------------------------------------------------------------------
// Padrões aplicados:
// - Middleware verificarEscola: exige req.user.escola_id (multi-escola)
// - Controllers recebem escola_id do usuário autenticado
// - Comentários padronizados para facilitar manutenção
// ============================================================================

import express from "express";
import pool from "../db.js";

import {
  salvarModulacao,           // LEGADO: mantido p/ compatibilidade do frontend
  listarModulacaoPorTurno,   // Lista por turno (filtro no controller)
  upsertModulacao,           // NOVO: UPSERT em lote
} from "../controllers/modulacaoController.js";

const router = express.Router();

// ----------------------------------------------------------------------------
// Middleware local: exige escola_id no usuário autenticado
// (O server.js já aplica autenticação; aqui garantimos o escola_id.)
// ----------------------------------------------------------------------------
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

// ----------------------------------------------------------------------------
// GET /api/modulacao?turno=Matutino
// Lista a grade (turmas do turno + alocações).
// ----------------------------------------------------------------------------
router.get("/", verificarEscola, (req, res) => {
  listarModulacaoPorTurno(req, res, req.user.escola_id);
});

// ----------------------------------------------------------------------------
// POST /api/modulacao  (LEGADO - compatibilidade)
// ----------------------------------------------------------------------------
router.post("/", verificarEscola, (req, res) => {
  salvarModulacao(req, res, req.user.escola_id);
});

// ----------------------------------------------------------------------------
// POST /api/modulacao/upsert  (NOVO - bulk)
// ----------------------------------------------------------------------------
router.post("/upsert", verificarEscola, (req, res) => {
  upsertModulacao(req, res, req.user.escola_id);
});

// ============================================================================
// POST /api/modulacao/remover  → remoção em lote (batch)
// Body:
// {
//   "turno": "Matutino",         // opcional (quando enviado, valida via JOIN turmas)
//   "itens": [
//     { "professor_id": 1, "turma_id": 10, "disciplina_id": 5 },
//     ...
//   ]
// }
// ============================================================================








// POST /api/modulacao/remover  → remoção em lote (compatível)
router.post("/remover", verificarEscola, async (req, res) => {
  const escola_id = req.user.escola_id;
  const { turno, itens } = req.body || {};

  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ message: "Nada para remover." });
  }

  // Triples: [[prof, turma, disc], ...]
  const triples = itens.map((it) => [
    Number(it.professor_id),
    Number(it.turma_id),
    Number(it.disciplina_id),
  ]);

  // (m.professor_id=? AND m.turma_id=? AND m.disciplina_id=?) OR ...
  const cond = triples.map(() =>
    "(m.professor_id=? AND m.turma_id=? AND m.disciplina_id=?)"
  ).join(" OR ");
  const params = triples.flat();

  try {
    if (turno) {
      // Com filtro de turno, validamos com JOIN em turmas
      const sql = `
        DELETE m
          FROM modulacao m
          JOIN turmas t ON t.id = m.turma_id
         WHERE m.escola_id = ?
           AND t.turno = ?
           AND (${cond})
      `;
      const [result] = await pool.query(sql, [escola_id, turno, ...params]);
      return res.json({ ok: true, removidos: result.affectedRows || 0 });
    } else {
      // Sem turno: remove direto da modulacao
      const sql = `
        DELETE FROM modulacao m
         WHERE m.escola_id = ?
           AND (${cond})
      `;
      const [result] = await pool.query(sql, [escola_id, ...params]);
      return res.json({ ok: true, removidos: result.affectedRows || 0 });
    }
  } catch (err) {
    console.error("Erro no remover (batch):", err);
    return res.status(500).json({ message: "Erro ao remover alocações." });
  }
});







// ============================================================================
// DELETE /api/modulacao/:prof/:turma/:disc  → fallback 1-a-1
// Aceita ?turno=... opcional p/ validar via JOIN turmas.
// ============================================================================
router.delete("/:prof/:turma/:disc", verificarEscola, async (req, res) => {
  const escola_id = req.user.escola_id;
  const p = Number(req.params.prof);
  const t = Number(req.params.turma);
  const d = Number(req.params.disc);
  const turno = req.query.turno;

  try {
    if (turno) {
      // Com filtro de turno, validamos com JOIN em turmas
      const sql = `
        DELETE m
          FROM modulacao m
          JOIN turmas t2 ON t2.id = m.turma_id
         WHERE m.escola_id = ?
           AND t2.turno = ?
           AND m.professor_id = ?
           AND m.turma_id = ?
           AND m.disciplina_id = ?
      `;
      await pool.query(sql, [escola_id, turno, p, t, d]);
      return res.status(204).end();
    }

    // Sem turno: remove direto da modulacao
    const sql = `
      DELETE FROM modulacao
       WHERE escola_id = ?
         AND professor_id = ?
         AND turma_id = ?
         AND disciplina_id = ?
    `;
    await pool.query(sql, [escola_id, p, t, d]);
    return res.status(204).end();
  } catch (err) {
    console.error("Erro no remover (1-a-1):", err);
    return res.status(500).json({ message: "Erro ao remover alocação." });
  }
});


export default router;
