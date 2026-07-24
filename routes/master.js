import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import sharp from 'sharp';
import { autenticarToken } from '../middleware/autenticarToken.js';
import { uploadFileBufferToSpaces } from '../storage/spacesUpload.js';
import {
  listarMaster, obterMaster, criarMasterQuestao,
  editarMaster, publicarMaster, excluirMaster,
  buscarMaster, importarLoteMaster
} from '../controllers/masterController.js';

const router = express.Router();

// ── Upload de imagem premium para DO Spaces (sem verificarEscola) ────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Use JPEG, PNG ou WebP.'));
  },
});

router.post('/upload-imagem', autenticarToken, upload.single('imagem'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Nenhum arquivo enviado.' });
    const processed = await sharp(req.file.buffer)
      .rotate()
      .resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
    const ts   = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const objectKey = `uploads/master/${ts}_${rand}.jpg`;
    const { publicUrl } = await uploadFileBufferToSpaces({
      buffer: processed, contentType: 'image/jpeg',
      objectKey, cacheControl: 'public, max-age=31536000',
    });
    res.json({ url: publicUrl, objectKey });
  } catch (err) {
    console.error('[masterUpload]', err);
    res.status(500).json({ message: err.message || 'Erro no upload.' });
  }
});

// ── Rotas de questões ────────────────────────────────────────────────────────
router.get('/buscar',                           buscarMaster);                       // pública
router.get('/questoes',        autenticarToken, listarMaster);
router.get('/questoes/:id',    autenticarToken, obterMaster);
router.post('/questoes',       autenticarToken, criarMasterQuestao);
router.post('/importar-lote',  autenticarToken, importarLoteMaster);
router.patch('/questoes/:id/publicar', autenticarToken, publicarMaster);
router.patch('/questoes/:id',          autenticarToken, editarMaster);
router.delete('/questoes/:id',         autenticarToken, excluirMaster);

export default router;
