import express from "express";
import {
    listarQuestoes,
    obterQuestao,
    criarQuestao,
    atualizarQuestao,
    excluirQuestao,
    criarQuestoesPorTexto
} from "../controllers/questoesController.js";

const router = express.Router();

// Middleware para verificar escola
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

// GET /api/questoes - lista apenas questões da escola
router.get("/", verificarEscola, (req, res) => listarQuestoes(req, res, req.user.escola_id));

// GET /api/questoes/:id - obtém questão da escola
router.get("/:id", verificarEscola, (req, res) => obterQuestao(req, res, req.user.escola_id));

// POST /api/questoes - cria questão para a escola
router.post("/", verificarEscola, (req, res) => criarQuestao(req, res, req.user.escola_id));

// POST /api/questoes/por-texto - cria várias questões para a escola
router.post(
  "/por-texto",
  verificarEscola,
  express.json(),
  (req, res) => criarQuestoesPorTexto(req, res, req.user.escola_id)
);

// PUT /api/questoes/:id - atualiza questão da escola
router.put("/:id", verificarEscola, (req, res) => atualizarQuestao(req, res, req.user.escola_id));

// DELETE /api/questoes/:id - exclui questão da escola
router.delete("/:id", verificarEscola, (req, res) => excluirQuestao(req, res, req.user.escola_id));

export default router;
