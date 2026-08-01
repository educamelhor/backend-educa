// routes/comunicados.js
import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import sharp from 'sharp';
import { uploadFileBufferToSpaces } from '../storage/spacesUpload.js';
import { autenticarToken } from '../middleware/autenticarToken.js';
import pool from '../db.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo não permitido. Use JPEG, PNG ou PDF.'));
    }
  },
});

// Middleware auxiliar para verificar se o usuário é direção/coordenação
// Em produção, isso pode vir do token ou req.user.perfil
// No educa-backend, o token injeta req.user.
const requireManagePermission = (req, res, next) => {
  const perfil = req.user?.perfil || '';
  const allowedProfiles = ['diretor', 'vice_diretor', 'coordenador', 'supervisor'];
  
  // Se for sysadmin ou master, pode gerenciar
  if (req.user?.role === 'sysadmin' || allowedProfiles.includes(perfil)) {
    return next();
  }
  
  return res.status(403).json({ message: 'Acesso negado: Perfil sem permissão para gerenciar comunicados.' });
};

// GET /api/comunicados/:escolaId
// Retorna todos os comunicados (noticias) da escola, do mais novo para o mais antigo.
router.get('/:escolaId', autenticarToken, async (req, res) => {
  const escolaId = Number(req.params.escolaId);
  if (!escolaId || isNaN(escolaId)) return res.status(400).json({ message: 'escolaId inválido' });

  try {
    const [rows] = await pool.query(
      `SELECT id, titulo, descricao, imagem_url, ativo, criado_em 
       FROM noticias 
       WHERE escola_id = ? 
       ORDER BY criado_em DESC`,
      [escolaId]
    );
    res.json({ ok: true, comunicados: rows });
  } catch (err) {
    console.error('[comunicados] GET erro:', err);
    res.status(500).json({ message: 'Erro ao buscar comunicados.' });
  }
});

// POST /api/comunicados/:escolaId
// Cria um novo comunicado. Requer multipart/form-data.
router.post('/:escolaId', autenticarToken, requireManagePermission, upload.single('arquivo'), async (req, res) => {
  const escolaId = Number(req.params.escolaId);
  const { titulo, ativo } = req.body;
  const isAtivo = ativo === 'true' || ativo === '1' ? 1 : 0;

  if (!titulo) return res.status(400).json({ message: 'Título é obrigatório.' });

  try {
    let publicUrl = '';

    if (req.file) {
      const ts = Date.now();
      const rand = crypto.randomBytes(4).toString('hex');
      let buffer = req.file.buffer;
      let contentType = req.file.mimetype;
      let ext = contentType === 'application/pdf' ? 'pdf' : 'jpg';

      if (contentType.startsWith('image/')) {
        buffer = await sharp(req.file.buffer)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
        contentType = 'image/jpeg';
      }

      const objectKey = `uploads/comunicados/${ts}_${rand}.${ext}`;
      
      const uploadResult = await uploadFileBufferToSpaces({
        buffer,
        contentType,
        objectKey,
        cacheControl: 'public, max-age=31536000',
      });
      publicUrl = uploadResult.publicUrl;
    }

    const [result] = await pool.query(
      `INSERT INTO noticias (escola_id, titulo, descricao, imagem_url, ativo, criado_em)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [escolaId, titulo, '', publicUrl, isAtivo]
    );

    res.json({ ok: true, id: result.insertId, message: 'Comunicado criado com sucesso.' });
  } catch (err) {
    console.error('[comunicados] POST erro:', err);
    res.status(500).json({ message: err.message || 'Erro ao criar comunicado.' });
  }
});

// PUT /api/comunicados/:escolaId/:id
// Atualiza um comunicado (pode ou não atualizar o arquivo)
router.put('/:escolaId/:id', autenticarToken, requireManagePermission, upload.single('arquivo'), async (req, res) => {
  const escolaId = Number(req.params.escolaId);
  const comunicadoId = Number(req.params.id);
  const { titulo, ativo } = req.body;
  const isAtivo = ativo === 'true' || ativo === '1' || ativo === true ? 1 : 0;

  if (!titulo) return res.status(400).json({ message: 'Título é obrigatório.' });

  try {
    const [existing] = await pool.query('SELECT id, imagem_url FROM noticias WHERE id = ? AND escola_id = ?', [comunicadoId, escolaId]);
    if (!existing || existing.length === 0) return res.status(404).json({ message: 'Comunicado não encontrado.' });

    let publicUrl = existing[0].imagem_url;

    if (req.file) {
      const ts = Date.now();
      const rand = crypto.randomBytes(4).toString('hex');
      let buffer = req.file.buffer;
      let contentType = req.file.mimetype;
      let ext = contentType === 'application/pdf' ? 'pdf' : 'jpg';

      if (contentType.startsWith('image/')) {
        buffer = await sharp(req.file.buffer)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
        contentType = 'image/jpeg';
      }

      const objectKey = `uploads/comunicados/${ts}_${rand}.${ext}`;
      
      const uploadResult = await uploadFileBufferToSpaces({
        buffer,
        contentType,
        objectKey,
        cacheControl: 'public, max-age=31536000',
      });
      publicUrl = uploadResult.publicUrl;
    }

    await pool.query(
      `UPDATE noticias SET titulo = ?, imagem_url = ?, ativo = ? WHERE id = ? AND escola_id = ?`,
      [titulo, publicUrl, isAtivo, comunicadoId, escolaId]
    );

    res.json({ ok: true, message: 'Comunicado atualizado.' });
  } catch (err) {
    console.error('[comunicados] PUT erro:', err);
    res.status(500).json({ message: err.message || 'Erro ao atualizar.' });
  }
});

// DELETE /api/comunicados/:escolaId/:id
router.delete('/:escolaId/:id', autenticarToken, requireManagePermission, async (req, res) => {
  const escolaId = Number(req.params.escolaId);
  const comunicadoId = Number(req.params.id);

  try {
    await pool.query('DELETE FROM noticias WHERE id = ? AND escola_id = ?', [comunicadoId, escolaId]);
    res.json({ ok: true, message: 'Comunicado excluído.' });
  } catch (err) {
    console.error('[comunicados] DELETE erro:', err);
    res.status(500).json({ message: 'Erro ao excluir comunicado.' });
  }
});

export default router;
