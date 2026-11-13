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
  extrairQuestaoImagem,
  extrairListaImagem,
  extrairListaTexto,
  copilotoQuestao,
  uploadImagem,
  iniciarJobQuestoes,
  enviarPaginaJobQuestoes,
  iniciarJobPrintUnicoController,
  obterStatusJobQuestoes,
  cancelarJobQuestoes,
  // ── Banco Global ────────────────────────────────────────────────────────────
  publicarQuestao,
  buscarBancoGlobal,
  getQuestaoGlobal,
  registrarUsoGlobal,
  getBancoEscola,
  statsGlobal,
  excluirQuestaoGlobal,
} from "../controllers/questoesController.js";

const router = express.Router();

function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id)
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  next();
}

// ── Estatísticas do banco da escola ──────────────────────────────────────────
router.get("/stats", verificarEscola, statsQuestoes);

// ── Banco Global — rotas estáticas ANTES dos dinâmicos (:id) ─────────────────
router.get("/global/stats",        verificarEscola, statsGlobal);
router.get("/global/banco-escola", verificarEscola, getBancoEscola);
router.get("/global",              verificarEscola, buscarBancoGlobal);
router.get("/global/:id",          verificarEscola, getQuestaoGlobal);
router.post("/global/:id/usar",    verificarEscola, registrarUsoGlobal);
router.delete("/global/:id",       verificarEscola, excluirQuestaoGlobal); // ?hard=1 para exclusão permanente

// ── EDUCA.STUDIO AI — Jobs Assíncronos em Background (Zero Timeout + Telemetria) ──
// Declarados ANTES de `/:id` para evitar colisão com rotas dinâmicas
router.post("/jobs",                 verificarEscola, iniciarJobQuestoes);
router.post("/jobs/print-unico",     uploadImagem, verificarEscola, iniciarJobPrintUnicoController);
router.post("/jobs/:jobId/pagina",   uploadImagem, verificarEscola, enviarPaginaJobQuestoes);
router.get("/jobs/:jobId",           verificarEscola, obterStatusJobQuestoes);
router.post("/jobs/:jobId/cancelar", verificarEscola, cancelarJobQuestoes);

// ── CRUD principal ─────────────────────────────────────────────────────────
router.get("/",       verificarEscola, listarQuestoes);
router.get("/:id",    verificarEscola, obterQuestao);
router.post("/",      verificarEscola, criarQuestao);
router.put("/:id",    verificarEscola, atualizarQuestao);
router.delete("/:id", verificarEscola, excluirQuestao);  // ?hard=1 para hard delete

// ── Publicar no Banco Global ──────────────────────────────────────────────────
router.post("/:id/publicar",  verificarEscola, publicarQuestao);

// ── Sprint 5: Duplicar + Histórico ────────────────────────────────────────
router.post("/:id/duplicar",  verificarEscola, duplicarQuestao);
router.get("/:id/historico",  verificarEscola, historicoQuestao);

// ── Parsing de texto/PDF (legado) ─────────────────────────────────────────
router.post("/por-texto", verificarEscola, criarQuestoesPorTexto);

// ── Gemini Vision & Copiloto Pedagógico (EDUCA.STUDIO AI) ─────────────────
// uploadImagem (multer) processa o multipart ANTES de verificarEscola
router.post("/extrair-imagem", uploadImagem, verificarEscola, extrairQuestaoImagem);
router.post("/extrair-lista", uploadImagem, verificarEscola, extrairListaImagem);
router.post("/extrair-lista-texto", verificarEscola, extrairListaTexto);
router.post("/copiloto-ia", verificarEscola, copilotoQuestao);

export default router;
