// api/routes/usuarios.js
import express from "express";
import pool from "../db.js";
import bcrypt from "bcryptjs";
import multer from "multer";
import fs from "fs";
import path from "path";
import { dirname as _dirname } from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { autenticarToken } from "../middleware/autenticarToken.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);

const router = express.Router();

// ────────────────────────────────────────────────
// DigitalOcean Spaces (reutiliza env do professores.js)
// ────────────────────────────────────────────────
const SPACES_BUCKET = process.env.SPACES_BUCKET || process.env.DO_SPACES_BUCKET;
const SPACES_REGION = process.env.SPACES_REGION || process.env.DO_SPACES_REGION || "nyc3";
const rawSpacesEndpoint =
  process.env.SPACES_ENDPOINT ||
  process.env.DO_SPACES_ENDPOINT ||
  "https://nyc3.digitaloceanspaces.com";

function normalizeSpacesEndpoint(endpoint, bucket, region) {
  try {
    const url = new URL(endpoint);
    const host = url.host;
    if (host === `${region}.digitaloceanspaces.com`) return url.toString();
    if (bucket && host === `${bucket}.${region}.digitaloceanspaces.com`) {
      url.host = `${region}.digitaloceanspaces.com`;
      return url.toString();
    }
    if (bucket && host.startsWith(`${bucket}.`)) {
      url.host = host.replace(`${bucket}.`, "");
      return url.toString();
    }
    return url.toString();
  } catch {
    return `https://${region}.digitaloceanspaces.com`;
  }
}

const SPACES_ENDPOINT = normalizeSpacesEndpoint(rawSpacesEndpoint, SPACES_BUCKET, SPACES_REGION);
const SPACES_KEY = process.env.SPACES_KEY || process.env.DO_SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET || process.env.DO_SPACES_SECRET;

const s3 =
  SPACES_BUCKET && SPACES_KEY && SPACES_SECRET
    ? new S3Client({
        region: SPACES_REGION,
        endpoint: SPACES_ENDPOINT,
        credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET },
        forcePathStyle: false,
      })
    : null;

async function uploadToSpaces({ key, body, contentType }) {
  if (!s3) return;
  await s3.send(
    new PutObjectCommand({
      Bucket: SPACES_BUCKET,
      Key: key,
      Body: body,
      ACL: "public-read",
      ContentType: contentType,
      CacheControl: "public, max-age=31536000",
    })
  );
}

// ────────────────────────────────────────────────
// Multer storage genérico para foto de qualquer usuário
// Salva em: /uploads/<APELIDO_ESCOLA>/usuarios/<usuario_id>.<ext>
// ────────────────────────────────────────────────
const getExtFromMime = (mime) => {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
};

const userStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const escolaId =
      req.escola_id ||
      req.user?.escola_id ||
      (req.headers?.["x-escola-id"] ? Number(req.headers["x-escola-id"]) : null);

    if (!escolaId || Number.isNaN(Number(escolaId)) || Number(escolaId) <= 0) {
      return cb(new Error("Acesso negado: escola não definida."), null);
    }

    if (req.user && !req.user.escola_id) req.user.escola_id = Number(escolaId);

    pool
      .query("SELECT apelido FROM escolas WHERE id = ? LIMIT 1", [Number(escolaId)])
      .then(([rows]) => {
        const apelidoRaw = rows?.[0]?.apelido ? String(rows[0].apelido) : `escola_${escolaId}`;
        const apelido = apelidoRaw
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-zA-Z0-9_-]+/g, "_")
          .replace(/_+/g, "_")
          .replace(/^_|_$/g, "");

        const dir = path.resolve(__dirname, `../uploads/${apelido}/usuarios`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        req.__upload_escola_apelido = apelido;
        cb(null, dir);
      })
      .catch((err) => cb(err, null));
  },

  filename: async (req, file, cb) => {
    try {
      const userId =
        req.user?.id ||
        req.user?.usuario_id ||
        req.user?.userId ||
        req.user?.sub;

      if (!userId) {
        return cb(new Error("Usuário não identificado."), null);
      }

      const ext = getExtFromMime(file.mimetype);
      req.__upload_user_id = userId;
      req.__upload_ext = ext;

      cb(null, `${userId}.${ext}`);
    } catch (err) {
      cb(err, null);
    }
  },
});

const userFileFilter = (_req, file, cb) => {
  const permitidos = ["image/jpeg", "image/png", "image/webp"];
  cb(null, permitidos.includes(file.mimetype));
};

const userUpload = multer({
  storage: userStorage,
  fileFilter: userFileFilter,
  limits: { fileSize: 3 * 1024 * 1024 },
});

// ✅ Rotas públicas (sem token) — usadas no fluxo de cadastro
// Importante: ainda exigimos escola via middleware verificarEscola (server.js)
// e usamos req.escola_id para filtrar no banco.
export const publicRouter = express.Router();


// Middleware para garantir que a escola esteja definida no usuário logado
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

/**
 * GET /api/usuarios
 * Lista todos os usuários da escola logada com paginação
 * Query params:
 *   page  = número da página (padrão: 1)
 *   limit = quantidade de registros por página (padrão: 10)
 */
router.get("/", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    // Total de usuários na escola
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM usuarios WHERE escola_id = ?",
      [escola_id]
    );

    // Lista paginada
    const [usuarios] = await pool.query(
      `SELECT id, cpf, nome, email, celular, perfil, escola_id, ativo
       FROM usuarios
       WHERE escola_id = ?
       ORDER BY nome ASC
       LIMIT ? OFFSET ?`,
      [escola_id, limit, offset]
    );

    res.json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: usuarios
    });
  } catch (err) {
    console.error("Erro ao listar usuários:", err);
    res.status(500).json({ message: "Erro ao listar usuários." });
  }
});

/**
 * GET /api/usuarios/por-cpf/:cpf
 */
router.get("/por-cpf/:cpf", verificarEscola, async (req, res) => {
  const cpf = req.params.cpf.replace(/\D/g, "");
  const { escola_id } = req.user;
  try {
    const [[usuario]] = await pool.query(
      "SELECT id, cpf, nome, email, celular, perfil, escola_id FROM usuarios WHERE cpf = ? AND escola_id = ?",
      [cpf, escola_id]
    );
    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });
    res.json(usuario);
  } catch (err) {
    res.status(500).json({ message: "Erro ao buscar usuário por CPF." });
  }
});

/**
 * GET /api/usuarios/por-email/:email
 */






/**
 * ✅ GET (PÚBLICO) /api/usuarios/por-email/:email
 * - Usado no CadastroUsuario.jsx (antes do usuário ter token)
 * - Exige escola via req.escola_id (middleware verificarEscola do server.js)
 */
publicRouter.get("/por-email/:email", async (req, res) => {
  const email = req.params.email;
  const escola_id = Number(req.escola_id);

  try {
    const [[usuario]] = await pool.query(
      `SELECT id, cpf, nome, email, celular, perfil, escola_id,
        (senha_hash IS NOT NULL AND senha_hash <> '') AS tem_senha
      FROM usuarios
      WHERE email = ? AND escola_id = ?`,

      [email, escola_id]
    );

    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });
    return res.json(usuario);
  } catch (err) {
    return res.status(500).json({ message: "Erro ao buscar usuário por e-mail." });
  }
});

/**
 * 🔒 GET (PROTEGIDO) /api/usuarios/por-email/:email
 * - Mantido para fluxos autenticados (usa req.user.escola_id)
 */
router.get("/por-email/:email", verificarEscola, async (req, res) => {
  const email = req.params.email;
  const { escola_id } = req.user;

  try {
    const [[usuario]] = await pool.query(
      `SELECT id, cpf, nome, email, celular, perfil, escola_id,
        (senha_hash IS NOT NULL AND senha_hash <> '') AS tem_senha
      FROM usuarios
      WHERE email = ? AND escola_id = ?`,

      [email, escola_id]
    );

    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });
    return res.json(usuario);
  } catch (err) {
    return res.status(500).json({ message: "Erro ao buscar usuário por e-mail." });
  }
});









/**
 * POST /api/usuarios
 * Cria novo usuário vinculado à escola logada
 */
router.post("/", verificarEscola, async (req, res) => {
  const { cpf, nome, email, celular, perfil, senha } = req.body;
  const { escola_id, perfil: perfilCriador } = req.user;

  const cpfLimpo = String(cpf || "").replace(/\D/g, "");
  const emailNorm = email ? String(email).trim().toLowerCase() : null;

  if (!cpfLimpo || cpfLimpo.length !== 11 || !nome || !emailNorm || !celular || !perfil || !senha) {
    return res.status(400).json({ message: "Preencha todos os campos obrigatórios (CPF válido com 11 dígitos)." });
  }

  // Validação: apenas admin pode criar outro admin
  if (perfil.toLowerCase() === "admin" && perfilCriador.toLowerCase() !== "admin") {
    return res.status(403).json({ message: "Somente administradores podem criar outros administradores." });
  }

  try {
    const senha_hash = await bcrypt.hash(senha, 10);

    const [existe] = await pool.query(
      "SELECT id FROM usuarios WHERE (cpf = ? OR email = ?) AND escola_id = ?",
      [cpfLimpo, emailNorm, escola_id]
    );
    if (existe.length > 0) {
      return res.status(400).json({ message: "Usuário já cadastrado (CPF ou e-mail existente) na sua escola." });
    }

    await pool.query(
      "INSERT INTO usuarios (cpf, nome, email, celular, perfil, escola_id, senha_hash, ativo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
      [cpfLimpo, nome, emailNorm, celular, perfil, escola_id, senha_hash]
    );
    res.json({ success: true, message: "Usuário cadastrado com sucesso!" });
  } catch (err) {
    console.error("Erro ao criar usuário:", err);
    res.status(500).json({ message: "Erro ao criar usuário.", error: err.message });
  }
});

// ────────────────────────────────────────────────
// POST /api/usuarios/me/foto
// Upload de foto do perfil do usuário logado (QUALQUER perfil)
// Salva em: /uploads/<APELIDO>/usuarios/<id>.<ext>
// Atualiza: usuarios.foto (e professores.foto se for professor)
// ────────────────────────────────────────────────
router.post(
  "/me/foto",
  autenticarToken,
  verificarEscola,
  userUpload.single("foto"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Nenhuma foto enviada." });

    try {
      const apelido = req.__upload_escola_apelido || `escola_${req.user.escola_id}`;
      const userId = req.__upload_user_id;
      const ext = req.__upload_ext || "jpg";

      if (!userId) {
        return res.status(400).json({ message: "Falha ao identificar usuário logado." });
      }

      const fotoUrl = `/uploads/${apelido}/usuarios/${userId}.${ext}`;

      // 1) Upload para Spaces (produção)
      const key = fotoUrl.replace(/^\/+/, "");
      const buffer = await fs.promises.readFile(req.file.path);
      await uploadToSpaces({ key, body: buffer, contentType: req.file.mimetype });

      // 2) Atualiza tabela usuarios
      await pool.query(
        "UPDATE usuarios SET foto = ? WHERE id = ?",
        [fotoUrl, userId]
      );

      // 3) Retrocompatibilidade: se for professor, atualiza professores.foto_url e professores.foto
      const [userRows] = await pool.query(
        "SELECT cpf, perfil, escola_id FROM usuarios WHERE id = ? LIMIT 1",
        [userId]
      );
      const user = userRows?.[0];
      if (user && (user.perfil === "professor")) {
        const cleanCpf = String(user.cpf).replace(/\D/g, "");
        await pool.query(
          "UPDATE professores SET foto_url = ?, foto = ? WHERE cpf = ? AND escola_id = ?",
          [fotoUrl, fotoUrl, cleanCpf, user.escola_id]
        ).catch(() => {}); // não bloqueia se falhar
      }

      return res.json({ foto_url: fotoUrl });
    } catch (err) {
      console.error("Erro ao atualizar foto (usuarios/me/foto):", err);
      return res.status(500).json({
        message: "Erro ao atualizar foto do perfil.",
        debug: { name: err?.name, message: err?.message },
      });
    }
  }
);

// ────────────────────────────────────────────────
// GET /api/usuarios/me/foto
// Retorna a foto do perfil do usuário logado
// ────────────────────────────────────────────────
router.get("/me/foto", autenticarToken, verificarEscola, async (req, res) => {
  try {
    const userId =
      req.user?.id ||
      req.user?.usuario_id ||
      req.user?.userId ||
      req.user?.sub;

    if (!userId) {
      return res.status(400).json({ ok: false, message: "Usuário não identificado." });
    }

    // Ordem de prioridade: p.foto (professores) → u.foto (usuarios)
    // NOTA: usa p.foto (não p.foto_url) — coluna garantida no schema de produção
    const [rows] = await pool.query(
      `SELECT COALESCE(p.foto, u.foto, '') AS foto_url
       FROM usuarios u
       LEFT JOIN professores p
         ON REPLACE(REPLACE(p.cpf,'.',''),'-','') = REPLACE(REPLACE(u.cpf,'.',''),'-','')
        AND p.escola_id = u.escola_id
       WHERE u.id = ?
       LIMIT 1`,
      [userId]
    );

    let fotoUrl = rows?.[0]?.foto_url ? String(rows[0].foto_url) : "";

    // Converte path relativo (/uploads/...) → URL pública do Spaces CDN
    // Disco local é efêmero no DigitalOcean — fotos ficam SEMPRE no Spaces
    if (fotoUrl && !fotoUrl.startsWith("http")) {
      const bucket = process.env.DO_SPACES_BUCKET || process.env.SPACES_BUCKET || "educa-melhor-uploads";
      const region = process.env.DO_SPACES_REGION || process.env.SPACES_REGION || "nyc3";
      const key = fotoUrl.replace(/^\/+/, "");
      fotoUrl = `https://${bucket}.${region}.digitaloceanspaces.com/${key}`;
    }

    return res.json({ foto_url: fotoUrl });
  } catch (err) {
    console.error("Erro ao buscar foto (usuarios/me/foto):", err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar foto do perfil." });
  }
});

export default router;
