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

router.get("/", listarQuestoes);
router.get("/:id", obterQuestao);
router.post("/", criarQuestao);
router.post(
    "/por-texto",
    express.json(),            // garante parsing de JSON
    criarQuestoesPorTexto
  );
router.put("/:id", atualizarQuestao);
router.delete("/:id", excluirQuestao);

// POST /api/questoes/por-texto — cria várias questões a partir de texto
router.post(
  "/por-texto",
  express.json(),           // garante parsing de JSON no body
  criarQuestoesPorTexto
);





export default router;
