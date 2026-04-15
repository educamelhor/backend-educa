import express from 'express';
import { previewHtml, gerarPdf } from '../controllers/provaHtmlController.js';

const router = express.Router();

// GET  /api/provas/:id/html      — preview HTML (abre no browser)
// GET  /api/provas/:id/html?gabarito=1  — com gabarito
router.get('/:id/html', previewHtml);

// POST /api/provas/:id/pdf       — gera e faz download do PDF
// GET  /api/provas/:id/pdf       — alternativa GET para link direto
// ?gabarito=1 inclui gabarito separado | ?escola=Nome da Escola
router.get('/:id/pdf',  gerarPdf);
router.post('/:id/pdf', gerarPdf);

export default router;
