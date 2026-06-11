// routes/provaLatexPdf.js
import express from 'express';
import { exportarPdfLatex } from '../controllers/provaLatexController.js';

const router = express.Router();

// GET /api/provas/:id/pdf-latex[?gabarito=1]
router.get('/:id/pdf-latex', exportarPdfLatex);

export default router;
