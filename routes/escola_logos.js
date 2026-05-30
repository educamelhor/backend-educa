// routes/escola_logos.js
// =========================================================================
// LOGOS INSTITUCIONAIS — Gerenciadas pelo Diretor/Vice-Diretor da escola
// Tabela `escola_logos` (por escola, variantes header/thumb/original)
// =========================================================================
import express from "express";
import multer from "multer";
import sharp from "sharp";
import crypto from "crypto";
import { uploadFileBufferToSpaces, deleteObjectFromSpaces } from "../storage/spacesUpload.js";

const router = express.Router();

// ── Constantes ──
const SPACES_PUBLIC_BASE = (process.env.SPACES_PUBLIC_BASE || "https://educa-melhor-uploads.nyc3.cdn.digitaloceanspaces.com/").replace(/\/$/, "");

const ALLOWED_MIMES = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml"];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// ── Multer: memoryStorage ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype}. Use PNG, JPEG ou SVG.`));
    }
  },
});

// ── Guard: perfil deve ser diretor ou vice_diretor ──
// Lê de req.user.perfil (JWT decodificado pelo autenticarToken) com fallback ao header x-perfil
function guardDiretor(req, res, next) {
  const perfilJwt = String(req.user?.perfil || "").toLowerCase().trim();
  const perfilHeader = String(req.headers["x-perfil"] || "").toLowerCase().trim();
  const perfil = perfilJwt || perfilHeader;

  const PERFIS_PERMITIDOS = ["diretor", "vice_diretor", "vice-diretor", "vicediretor", "admin", "ceo"];
  if (PERFIS_PERMITIDOS.includes(perfil)) return next();

  console.warn(`[ESCOLA_LOGOS][GUARD] Acesso negado: perfil="${perfil}" (user_id=${req.user?.id})`);
  return res.status(403).json({ ok: false, message: "Acesso restrito a Diretor e Vice-Diretor." });
}


// ── Helper: monta URL pública a partir da object key ──
function publicUrl(objectKey) {
  return `${SPACES_PUBLIC_BASE}/${objectKey}`;
}

// ── Helper: gera slug único para o logo ──
function gerarSlug(label) {
  const base = String(label || "logo")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 40);
  const rand = crypto.randomBytes(4).toString("hex");
  const ts = Date.now().toString(36);
  return `${base}_${ts}_${rand}`;
}

// ── OPTIONS preflight ──
router.options("/{*any}", (req, res) => res.status(204).end());
router.options("/", (req, res) => res.status(204).end());

// ═══════════════════════════════════════════════════════════════
// GET / — Lista logos ativos da escola
// ═══════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  if (!escolaId) return res.status(400).json({ ok: false, message: "escola_id inválido." });

  try {
    const [rows] = await db.query(
      `SELECT id, label, posicao, usos, url_header, url_thumb, ordem, criado_em, atualizado_em
       FROM escola_logos
       WHERE escola_id = ? AND ativo = 1
       ORDER BY ordem ASC, criado_em ASC`,
      [escolaId]
    );

    const logos = rows.map((r) => ({
      ...r,
      usos: r.usos ? (typeof r.usos === "string" ? JSON.parse(r.usos) : r.usos) : [],
    }));

    return res.json({ ok: true, logos });
  } catch (err) {
    console.error("[ESCOLA_LOGOS][LISTAR]", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar logos." });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /para-documentos — Retorna logos esquerda/direita para uso em documentos
// ═══════════════════════════════════════════════════════════════
router.get("/para-documentos", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  if (!escolaId) return res.status(400).json({ ok: false, message: "escola_id inválido." });

  try {
    const [rows] = await db.query(
      `SELECT id, label, posicao, url_header
       FROM escola_logos
       WHERE escola_id = ? AND ativo = 1 AND posicao IN ('esquerda', 'direita')
       LIMIT 2`,
      [escolaId]
    );

    let esquerda = null;
    let direita = null;

    for (const r of rows) {
      const obj = { id: r.id, label: r.label, url_header: r.url_header };
      if (r.posicao === "esquerda") esquerda = obj;
      else if (r.posicao === "direita") direita = obj;
    }

    return res.json({ ok: true, esquerda, direita });
  } catch (err) {
    console.error("[ESCOLA_LOGOS][PARA-DOCUMENTOS]", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar logos para documentos." });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /upload — Faz upload de um novo logo com sharp (3 variantes)
// ═══════════════════════════════════════════════════════════════
router.post(
  "/upload",
  guardDiretor,
  (req, res, next) => {
    upload.single("foto")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ ok: false, message: "Arquivo excede 5MB." });
        }
        return res.status(400).json({ ok: false, message: err.message || "Erro no upload." });
      }
      next();
    });
  },
  async (req, res) => {
    const db = req.db;
    const escolaId = Number(req.user?.escola_id);
    if (!escolaId) return res.status(400).json({ ok: false, message: "escola_id inválido." });

    if (!req.file) return res.status(400).json({ ok: false, message: "Arquivo 'foto' é obrigatório." });

    const { label = "Logo" } = req.body;
    if (!label || String(label).trim().length === 0) {
      return res.status(400).json({ ok: false, message: "label é obrigatório." });
    }

    const fileBuffer = req.file.buffer;
    const slug = gerarSlug(label);

    try {
      // ── Processar variantes com sharp ──

      // header: 400x120 PNG, fit contain, fundo branco transparente
      const headerBuf = await sharp(fileBuffer)
        .resize(400, 120, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .png()
        .toBuffer();

      // thumb: 120x80 WebP
      const thumbBuf = await sharp(fileBuffer)
        .resize(120, 80, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .webp({ quality: 80 })
        .toBuffer();

      // original: convertido para PNG (compatibilidade jsPDF + rasteriza SVG)
      const origBuf = await sharp(fileBuffer).png().toBuffer();

      // ── Fazer upload das 3 variantes no Spaces ──
      const keyHeader   = `uploads/logos/escola_${escolaId}/${slug}/header.png`;
      const keyThumb    = `uploads/logos/escola_${escolaId}/${slug}/thumb.webp`;
      const keyOriginal = `uploads/logos/escola_${escolaId}/${slug}/original.png`;

      await Promise.all([
        uploadFileBufferToSpaces({ buffer: headerBuf,   contentType: "image/png",  objectKey: keyHeader }),
        uploadFileBufferToSpaces({ buffer: thumbBuf,    contentType: "image/webp", objectKey: keyThumb }),
        uploadFileBufferToSpaces({ buffer: origBuf,     contentType: "image/png",  objectKey: keyOriginal }),
      ]);

      const urlHeader = publicUrl(keyHeader);
      const urlThumb  = publicUrl(keyThumb);

      // ── Inserir no banco ──
      const [result] = await db.query(
        `INSERT INTO escola_logos
          (escola_id, label, posicao, usos, key_original, key_header, key_thumb, url_header, url_thumb, ordem, ativo)
         VALUES (?, ?, 'nenhuma', '[]', ?, ?, ?, ?, ?, 0, 1)`,
        [escolaId, String(label).trim(), keyOriginal, keyHeader, keyThumb, urlHeader, urlThumb]
      );

      const insertId = result.insertId;

      return res.status(201).json({
        ok: true,
        message: "Logo enviado com sucesso.",
        logo: {
          id: insertId,
          label: String(label).trim(),
          posicao: "nenhuma",
          usos: [],
          url_header: urlHeader,
          url_thumb: urlThumb,
        },
      });
    } catch (err) {
      console.error("[ESCOLA_LOGOS][UPLOAD]", err);
      return res.status(500).json({ ok: false, message: "Erro ao processar e enviar o logo." });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// PATCH /:id/posicao — Atualiza posição (esquerda/direita/nenhuma)
// Suporta ?forcar=1 para resolver conflito
// ═══════════════════════════════════════════════════════════════
router.patch("/:id/posicao", guardDiretor, async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  const id = Number(req.params.id);
  const { posicao } = req.body;
  const forcar = req.query.forcar === "1";

  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });

  const posicoesValidas = ["esquerda", "direita", "nenhuma"];
  if (!posicoesValidas.includes(posicao)) {
    return res.status(400).json({ ok: false, message: "posicao deve ser: esquerda, direita ou nenhuma." });
  }

  try {
    // Verifica que o logo pertence à escola
    const [[logo]] = await db.query(
      "SELECT id FROM escola_logos WHERE id = ? AND escola_id = ? AND ativo = 1 LIMIT 1",
      [id, escolaId]
    );
    if (!logo) return res.status(404).json({ ok: false, message: "Logo não encontrado." });

    // Verificar conflito (apenas para esquerda/direita)
    if (posicao === "esquerda" || posicao === "direita") {
      const [[conflito]] = await db.query(
        "SELECT id, label FROM escola_logos WHERE escola_id=? AND posicao=? AND id!=? AND ativo=1 LIMIT 1",
        [escolaId, posicao, id]
      );

      if (conflito && !forcar) {
        return res.status(409).json({
          ok: false,
          conflito: true,
          logo_conflito: { id: conflito.id, label: conflito.label },
        });
      }

      if (conflito && forcar) {
        await db.query('UPDATE escola_logos SET posicao="nenhuma" WHERE id=?', [conflito.id]);
      }
    }

    await db.query("UPDATE escola_logos SET posicao = ? WHERE id = ?", [posicao, id]);

    return res.json({ ok: true, message: "Posição atualizada." });
  } catch (err) {
    console.error("[ESCOLA_LOGOS][POSICAO]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar posição." });
  }
});

// ═══════════════════════════════════════════════════════════════
// PATCH /:id/usos — Atualiza array JSON de usos do logo
// ═══════════════════════════════════════════════════════════════
router.patch("/:id/usos", guardDiretor, async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  const id = Number(req.params.id);
  const { usos } = req.body;

  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });
  if (!Array.isArray(usos)) {
    return res.status(400).json({ ok: false, message: "usos deve ser um array." });
  }

  try {
    const [[logo]] = await db.query(
      "SELECT id FROM escola_logos WHERE id = ? AND escola_id = ? AND ativo = 1 LIMIT 1",
      [id, escolaId]
    );
    if (!logo) return res.status(404).json({ ok: false, message: "Logo não encontrado." });

    await db.query("UPDATE escola_logos SET usos = ? WHERE id = ?", [JSON.stringify(usos), id]);

    return res.json({ ok: true, message: "Usos atualizados." });
  } catch (err) {
    console.error("[ESCOLA_LOGOS][USOS]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar usos." });
  }
});

// ═══════════════════════════════════════════════════════════════
// PATCH /:id/label — Atualiza label do logo
// ═══════════════════════════════════════════════════════════════
router.patch("/:id/label", guardDiretor, async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  const id = Number(req.params.id);
  const { label } = req.body;

  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });
  if (!label || String(label).trim().length === 0) {
    return res.status(400).json({ ok: false, message: "label é obrigatório." });
  }

  try {
    const [[logo]] = await db.query(
      "SELECT id FROM escola_logos WHERE id = ? AND escola_id = ? AND ativo = 1 LIMIT 1",
      [id, escolaId]
    );
    if (!logo) return res.status(404).json({ ok: false, message: "Logo não encontrado." });

    await db.query("UPDATE escola_logos SET label = ? WHERE id = ?", [String(label).trim(), id]);

    return res.json({ ok: true, message: "Label atualizado." });
  } catch (err) {
    console.error("[ESCOLA_LOGOS][LABEL]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar label." });
  }
});

// ═══════════════════════════════════════════════════════════════
// DELETE /:id — Remove logo do Spaces e do banco (soft-delete + purge Spaces)
// ═══════════════════════════════════════════════════════════════
router.delete("/:id", guardDiretor, async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.user?.escola_id);
  const id = Number(req.params.id);

  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });

  try {
    const [[logo]] = await db.query(
      "SELECT id, key_original, key_header, key_thumb FROM escola_logos WHERE id = ? AND escola_id = ? AND ativo = 1 LIMIT 1",
      [id, escolaId]
    );
    if (!logo) return res.status(404).json({ ok: false, message: "Logo não encontrado." });

    // ── Remover arquivos do Spaces (sem parar se falhar) ──
    const keysToDelete = [logo.key_header, logo.key_thumb, logo.key_original].filter(Boolean);
    await Promise.allSettled(keysToDelete.map((k) => deleteObjectFromSpaces(k)));

    // ── Remover do banco (hard delete — o Spaces já foi limpo) ──
    await db.query("DELETE FROM escola_logos WHERE id = ?", [id]);

    return res.json({ ok: true, message: "Logo removido com sucesso." });
  } catch (err) {
    console.error("[ESCOLA_LOGOS][DELETE]", err);
    return res.status(500).json({ ok: false, message: "Erro ao remover logo." });
  }
});

export default router;
