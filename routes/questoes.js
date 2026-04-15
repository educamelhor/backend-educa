import express from "express";
import {
  listarQuestoes,
  obterQuestao,
  criarQuestao,
  atualizarQuestao,
  excluirQuestao,
  criarQuestoesPorTexto,
  statsQuestoes,
  duplicarQuestao,
  historicoQuestao,
} from "../controllers/questoesController.js";

const router = express.Router();

function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id)
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  next();
}

// ── Estatísticas do banco ──────────────────────────────────────────────────
router.get("/stats", verificarEscola, statsQuestoes);

// ── CRUD principal ─────────────────────────────────────────────────────────
router.get("/",       verificarEscola, listarQuestoes);
router.get("/:id",    verificarEscola, obterQuestao);
router.post("/",      verificarEscola, criarQuestao);
router.put("/:id",    verificarEscola, atualizarQuestao);
router.delete("/:id", verificarEscola, excluirQuestao);  // ?hard=1 para hard delete

// ── Sprint 5: Duplicar + Histórico ────────────────────────────────────────
router.post("/:id/duplicar",  verificarEscola, duplicarQuestao);
router.get("/:id/historico",  verificarEscola, historicoQuestao);

// ── Parsing de texto/PDF (legado) ─────────────────────────────────────────
router.post("/por-texto", verificarEscola, criarQuestoesPorTexto);

export default router;
