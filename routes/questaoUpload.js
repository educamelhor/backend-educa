// routes/questaoUpload.js — Upload e Processamento Inteligente de Mídia (DO Spaces CDN)
import express from 'express';
import multer from 'multer';
import { autenticarToken } from '../middleware/autenticarToken.js';
import { processarMidiaQuestao, baixarImagemSegura } from '../modules/questoes-ai/smartMediaEngine.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Tipo não permitido. Use JPEG, PNG ou WebP.'));
  },
});

// POST /api/questoes/upload-imagem — Upload padrão já integrado ao Smart Media Engine
router.post('/upload-imagem', autenticarToken, upload.single('imagem'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Nenhum arquivo enviado.' });

    const scannerClean = req.body?.scanner_clean === '1' || req.body?.scanner_clean === 'true';
    const keepOriginal = req.body?.keep_original !== '0';

    const result = await processarMidiaQuestao(req.file.buffer, {
      autoTrim: true,
      scannerClean,
      keepOriginal,
      posicao: req.body?.posicao || 'entre_enunciado_e_comando',
      legenda: req.body?.legenda || '',
      credito: req.body?.credito || '',
    });

    res.json(result); // { url, objectKey, midia }
  } catch (err) {
    console.error('[questaoUpload] upload-imagem:', err);
    res.status(500).json({ message: err.message || 'Erro no upload.' });
  }
});

// POST /api/questoes/processar-midia — Re-crop interativo [ymin, xmin, ymax, xmax] ou Scanner Clean sobre source_url
router.post('/processar-midia', autenticarToken, upload.single('imagem'), async (req, res) => {
  try {
    let buffer = req.file?.buffer || null;
    const sourceUrl = req.body?.source_url || null;

    if (!buffer && sourceUrl) {
      buffer = await baixarImagemSegura(sourceUrl);
    }
    if (!buffer) {
      return res.status(400).json({ message: 'Envie uma imagem ou informe source_url.' });
    }

    let bbox = null;
    if (req.body?.bbox) {
      try {
        const parsed = typeof req.body.bbox === 'string' ? JSON.parse(req.body.bbox) : req.body.bbox;
        if (Array.isArray(parsed) && parsed.length === 4) bbox = parsed.map(Number);
      } catch { bbox = null; }
    }

    const scannerClean = req.body?.scanner_clean === true || req.body?.scanner_clean === '1' || req.body?.scanner_clean === 'true';

    const result = await processarMidiaQuestao(buffer, {
      bbox,
      autoTrim: req.body?.auto_trim !== false && req.body?.auto_trim !== '0',
      scannerClean,
      keepOriginal: Boolean(!sourceUrl),
      existingOriginalUrl: sourceUrl || null,
      posicao: req.body?.posicao || 'entre_enunciado_e_comando',
      presetOverride: req.body?.preset || null,
      alinhamento: req.body?.alinhamento || 'center',
      legenda: req.body?.legenda || '',
      credito: req.body?.credito || '',
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[questaoUpload] processar-midia:', err);
    res.status(500).json({ ok: false, message: err.message || 'Erro ao processar mídia.' });
  }
});

export default router;
