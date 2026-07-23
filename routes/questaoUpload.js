// routes/questaoUpload.js — Upload de imagens de questões para DO Spaces
import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import sharp from 'sharp';
import { uploadFileBufferToSpaces } from '../storage/spacesUpload.js';
import { autenticarToken } from '../middleware/autenticarToken.js'; // Note: path in task was ../middleware/auth.js, but I see server.js uses ./middleware/autenticarToken.js

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/jpg','image/png','image/webp'];
    allowed.includes(file.mimetype) ? cb(null,true) : cb(new Error('Tipo não permitido. Use JPEG, PNG ou WebP.'));
  },
});

// POST /api/questoes/upload-imagem
router.post('/upload-imagem', autenticarToken, upload.single('imagem'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Nenhum arquivo enviado.' });
    const processed = await sharp(req.file.buffer)
      .rotate()
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const objectKey = `uploads/questoes/${ts}_${rand}.jpg`;
    const { publicUrl } = await uploadFileBufferToSpaces({
      buffer: processed,
      contentType: 'image/jpeg',
      objectKey,
      cacheControl: 'public, max-age=31536000',
    });
    res.json({ url: publicUrl, objectKey });
  } catch (err) {
    console.error('[questaoUpload]', err);
    res.status(500).json({ message: err.message || 'Erro no upload.' });
  }
});

export default router;
