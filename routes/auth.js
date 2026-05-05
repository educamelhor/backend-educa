// api/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";;
import jwt from "jsonwebtoken";
import pool from "../db.js";
import nodemailer from "nodemailer";
import { randomInt, createHash, randomBytes } from "crypto";
import { getPermissoesPorPerfil } from "../routes/rbacMatrix.js";

import multer from "multer";
import fs from "fs";
import { registrarAcesso } from "../middleware/logAccess.js";
import path from "path";


const router = express.Router();
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("❌ JWT_SECRET não configurado no ambiente.");
    throw new Error("JWT_SECRET não configurado.");
  }
  return secret;
}

// ──────────────────────────────────────────────────────────────
// Upload de foto (professores) — seguro e simples (salva caminho no MySQL)
// ──────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const UPLOADS_PROF_DIR = path.join(UPLOADS_DIR, "professores");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(UPLOADS_PROF_DIR)) fs.mkdirSync(UPLOADS_PROF_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_PROF_DIR),
  filename: (req, file, cb) => {
    const cpf = String(req.body?.cpf || "").replace(/\D/g, "");
    const escolaId = String(req.body?.escola_id || "");
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const stamp = Date.now();
    cb(null, `prof_${cpf}_${escolaId}_${stamp}${ext}`);
  },
});

const uploadFoto = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/.test(file.mimetype);
    if (!ok) return cb(new Error("TIPO_ARQUIVO_INVALIDO"));
    cb(null, true);
  },
});


/**
 * Função utilitária para envio de e-mail com código OTP
 */
async function enviarCodigoEmail(email, codigo) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  // ✅ Diagnóstico explícito (evita 500 "mudo")
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.error("[AUTH/enviarCodigoEmail] SMTP não configurado:", {
      SMTP_HOST: !!SMTP_HOST,
      SMTP_PORT: !!SMTP_PORT,
      SMTP_USER: !!SMTP_USER,
      SMTP_PASS: !!SMTP_PASS,
    });
    throw new Error("SMTP_NAO_CONFIGURADO");
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  try {
    await transporter.sendMail({
      from: `"Sistema Educacional" <${SMTP_USER}>`,
      to: email,
      subject: "Código de Confirmação",
      text: `Seu código de verificação é: ${codigo}`,
    });
  } catch (err) {
    console.error("[AUTH/enviarCodigoEmail] Falha ao enviar e-mail:", {
      email,
      smtpHost: SMTP_HOST,
      smtpPort: SMTP_PORT,
      message: err?.message,
    });
    throw err;
  }
}

/**
 * Carrega RBAC do usuário na escola:
 * - perfis: ['professor', 'diretor', ...]
 * - permissoes: ['conteudos.editar', ...]
 *
 * Obs: sem FK por enquanto (compatível com escola_id INT do usuarios).
 */
async function carregarRbac(usuarioId, escolaId) {
  const uid = Number(usuarioId);
  const eid = Number(escolaId);

  if (!uid || !eid) {
    return { perfis: [], permissoes: [] };
  }

  // 0) Perfil base do usuario (coluna usuarios.perfil) → permissoes estáticas da matriz
  const [[usuarioBase]] = await pool.query(
    "SELECT perfil FROM usuarios WHERE id = ? LIMIT 1",
    [uid]
  ).catch(() => [[null]]);

  const perfilBase = usuarioBase?.perfil || null;
  const permsMatriz = perfilBase ? getPermissoesPorPerfil(perfilBase) : [];

  // 1) Perfis do usuário na escola (tabelas RBAC dinâmicas)
  const [rowsPerfis] = await pool.query(
    `
    SELECT DISTINCT p.codigo
    FROM rbac_usuario_perfis up
    JOIN rbac_perfis p ON p.id = up.perfil_id
    WHERE up.usuario_id = ?
      AND p.escola_id = ?
      AND p.ativo = 1
    ORDER BY p.codigo
    `,
    [uid, eid]
  );

  const perfis = (rowsPerfis || []).map((r) => r.codigo).filter(Boolean);

  // 2) Permissões vindas dos perfis dinâmicos do banco
  const [rowsPermsBase] = await pool.query(
    `
    SELECT DISTINCT perm.chave
    FROM rbac_usuario_perfis up
    JOIN rbac_perfis p ON p.id = up.perfil_id
    JOIN rbac_perfil_permissoes pp ON pp.perfil_id = p.id
    JOIN rbac_permissoes perm ON perm.id = pp.permissao_id
    WHERE up.usuario_id = ?
      AND p.escola_id = ?
      AND p.ativo = 1
    ORDER BY perm.chave
    `,
    [uid, eid]
  );

  // Mescla: matriz estática (perfilBase) + permissões dinâmicas do banco
  let permissoes = new Set([
    ...permsMatriz,
    ...(rowsPermsBase || []).map((r) => r.chave).filter(Boolean),
  ]);

  // 3) Overrides por usuário (nega tem prioridade máxima)
  const [rowsOverrides] = await pool.query(
    `
    SELECT perm.chave, upm.permitido
    FROM rbac_usuario_permissoes upm
    JOIN rbac_permissoes perm ON perm.id = upm.permissao_id
    WHERE upm.usuario_id = ?
    `,
    [uid]
  );

  for (const row of rowsOverrides || []) {
    const chave = row?.chave;
    const permitido = Number(row?.permitido) === 1;
    if (!chave) continue;

    if (permitido) permissoes.add(chave);
    else permissoes.delete(chave); // nega tem prioridade
  }

  return { perfis, permissoes: Array.from(permissoes) };
}




/**
 * Busca a foto de perfil do usuário e retorna URL pública completa (Spaces CDN).
 * Usa p.foto (professores) → u.foto (usuarios).
 */
async function buscarFotoUsuario(usuarioId, escolaId) {
  try {
    const [[row]] = await pool.query(
      `SELECT COALESCE(p.foto, u.foto, '') AS foto_url
       FROM usuarios u
       LEFT JOIN professores p
         ON REPLACE(REPLACE(p.cpf,'.',''),'-','') = REPLACE(REPLACE(u.cpf,'.',''),'-','')
        AND p.escola_id = u.escola_id
       WHERE u.id = ?
       LIMIT 1`,
      [Number(usuarioId)]
    );

    let fotoUrl = row?.foto_url || '';

    // Converte path relativo (/uploads/...) → URL pública do Spaces CDN
    // Disco local é efêmero no DigitalOcean — fotos ficam SEMPRE no Spaces
    if (fotoUrl && !fotoUrl.startsWith('http')) {
      const bucket = process.env.DO_SPACES_BUCKET || process.env.SPACES_BUCKET || 'educa-melhor-uploads';
      const region = process.env.DO_SPACES_REGION || process.env.SPACES_REGION || 'nyc3';
      const key = fotoUrl.replace(/^\/+/, '');
      fotoUrl = `https://${bucket}.${region}.digitaloceanspaces.com/${key}`;
    }

    return fotoUrl;
  } catch {
    return '';
  }
}

/**
 * Helpers — Convite do Diretor (hash) + emissão de JWT escolar
 */
function hashConviteToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return "";
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

async function emitirJwtEscolar({ usuarioId, escolaId, perfil }) {
  const [[escolaRow]] = await pool.query(
    `SELECT apelido FROM escolas WHERE id = ? LIMIT 1`,
    [Number(escolaId)]
  );

  const { perfis, permissoes } = await carregarRbac(Number(usuarioId), Number(escolaId));

  const payload = {
    scope: "escola",
    usuario_id: Number(usuarioId), // ✅ contrato novo
    usuarioId: Number(usuarioId),  // ✅ compatibilidade com front atual
    escola_id: Number(escolaId),
    nome_escola: escolaRow?.apelido || null,
    perfil: perfil || "diretor",
    perfis,
    permissoes,
  };

  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: "8h" });

  return {
    token,
    escola_id: Number(escolaId),
    nome_escola: escolaRow?.apelido || "Escola não definida",
    perfil: perfil || "diretor",
    perfis,
    permissoes,
  };
}

/**
 * 0.1) Validar Convite (pré-check) — Diretor
 * POST /api/auth/convite/validar
 */
router.post("/convite/validar", async (req, res) => {
  const convite_token = String(req.body?.convite_token || "").trim();

  if (!convite_token) {
    return res.status(400).json({ ok: false, message: "convite_token é obrigatório." });
  }

  try {
    const tokenHash = hashConviteToken(convite_token);

    const [[row]] = await pool.query(
      `
      SELECT
        uc.id         AS convite_id,
        uc.usuario_id AS usuario_id,
        uc.expira_em  AS expira_em,
        uc.usado_em   AS usado_em,
        u.id          AS id,
        u.nome        AS nome,
        u.perfil      AS perfil,
        u.escola_id   AS escola_id
      FROM usuarios_convites uc
      JOIN usuarios u ON u.id = uc.usuario_id
      WHERE uc.token_hash = ?
        AND uc.expira_em > NOW()
        AND uc.usado_em IS NULL
        AND u.perfil = 'diretor'
      LIMIT 1
      `,
      [tokenHash]
    );

    if (!row?.id) {
      return res.status(400).json({ ok: false, message: "Convite inválido, expirado ou já utilizado." });
    }

    return res.json({
      ok: true,
      usuario: {
        id: row.id,
        nome: row.nome,
        perfil: row.perfil,
        escola_id: row.escola_id,
      },
    });
  } catch (err) {
    console.error("Erro ao validar convite:", err);
    return res.status(500).json({ ok: false, message: "Erro no servidor." });
  }
});

/**
 * 0.2) Ativar Conta (criar senha) — Diretor
 * POST /api/auth/convite/ativar
 */
router.post("/convite/ativar", async (req, res) => {
  const convite_token = String(req.body?.convite_token || "").trim();
  const senha = String(req.body?.senha || "");

  // ✅ validação forte mínima (mesmo padrão usado em /cadastrar-senha)
  const senhaValida =
    typeof senha === "string" &&
    senha.length >= 6 &&
    /[A-Za-z]/.test(senha) &&
    /\d/.test(senha) &&
    /[$#@*_]/.test(senha);

  if (!convite_token) {
    return res.status(400).json({ ok: false, message: "convite_token é obrigatório." });
  }
  if (!senhaValida) {
    return res.status(400).json({
      ok: false,
      message: "Senha fraca. Use no mínimo 6 caracteres com letras, números e pelo menos 1 destes: $#@*_",
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const tokenHash = hashConviteToken(convite_token);

    // trava o convite (one-time) para evitar corrida
    const [[row]] = await conn.query(
      `
      SELECT
        uc.id         AS convite_id,
        uc.usuario_id AS usuario_id,
        uc.expira_em  AS expira_em,
        uc.usado_em   AS usado_em,
        u.perfil      AS perfil
      FROM usuarios_convites uc
      JOIN usuarios u ON u.id = uc.usuario_id
      WHERE uc.token_hash = ?
      LIMIT 1
      FOR UPDATE
      `,
      [tokenHash]
    );

    if (!row?.convite_id) {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: "Convite inválido." });
    }

    if (row.usado_em) {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: "Convite já utilizado." });
    }

    // expiração (garantida pelo próprio MySQL)
    const [[expOk]] = await conn.query(
      `SELECT 1 AS ok FROM usuarios_convites WHERE id = ? AND expira_em > NOW() LIMIT 1`,
      [row.convite_id]
    );
    if (!expOk?.ok) {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: "Convite expirado." });
    }

    if (String(row.perfil || "") !== "diretor") {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: "Convite não pertence a um diretor." });
    }

    const senha_hash = await bcrypt.hash(senha, 10);

    await conn.query(
      `UPDATE usuarios SET senha_hash = ?, ativo = 1 WHERE id = ? LIMIT 1`,
      [senha_hash, row.usuario_id]
    );

    await conn.query(
      `UPDATE usuarios_convites SET usado_em = NOW() WHERE id = ? LIMIT 1`,
      [row.convite_id]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error("Erro ao ativar convite:", err);
    return res.status(500).json({ ok: false, message: "Erro no servidor." });
  } finally {
    conn.release();
  }
});


/**
 * 1) Login – envia código de confirmação (OTP) OU login escolar (CPF+senha)
 */
router.post("/login", async (req, res) => {
  const cpf = String(req.body?.cpf || "").trim();
  const senha = String(req.body?.senha || "");

  // ✅ MODO A: LOGIN ESCOLAR (Diretor) — cpf + senha => JWT (scope="escola")
  if (cpf) {
    try {
      const cpfLimpo = cpf.replace(/\D/g, "");
      if (!cpfLimpo || cpfLimpo.length !== 11) {
        return res.status(400).json({ ok: false, message: "CPF inválido." });
      }

      const [[usuario]] = await pool.query(
        `
        SELECT id, nome, cpf, escola_id, perfil, ativo, senha_hash
        FROM usuarios
        WHERE REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', '') = ?
          AND perfil = 'diretor'
          AND escola_id IS NOT NULL
        LIMIT 1
        `,
        [cpfLimpo]
      );

      if (!usuario?.id) {
        return res.status(404).json({ ok: false, message: "Diretor não encontrado." });
      }

      if (Number(usuario.ativo) !== 1) {
        return res.status(403).json({ ok: false, message: "Conta ainda não ativada." });
      }

      if (!usuario.senha_hash) {
        return res.status(403).json({ ok: false, message: "Conta sem senha cadastrada." });
      }

      const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
      if (!senhaOk) {
        return res.status(401).json({ ok: false, message: "Senha incorreta." });
      }

      const jwtEscolar = await emitirJwtEscolar({
        usuarioId: usuario.id,
        escolaId: usuario.escola_id,
        perfil: "diretor",
      });

      const fotoUrl = await buscarFotoUsuario(usuario.id, usuario.escola_id);

      // ✅ Registra acesso para Usage Insights (CEO)
      registrarAcesso(pool, {
        usuario_id: usuario.id,
        escola_id: usuario.escola_id,
        perfil: "diretor",
        ip: req.ip || req.headers["x-forwarded-for"],
        user_agent: req.headers["user-agent"],
        action: "login",
      });

      return res.json({
        ok: true,
        nome: usuario.nome || "Diretor",
        cpf: String(usuario.cpf || "").replace(/\D/g, ""),
        foto_url: fotoUrl,
        ...jwtEscolar,
      });
    } catch (err) {
      console.error("Erro no login escolar (diretor):", err);
      return res.status(500).json({ ok: false, message: "Erro no servidor." });
    }
  }

  // ✅ MODO B: LOGIN OTP (fluxo atual) — emailOuCelular + senha => envia código
  const emailOuCelular = String(req.body?.emailOuCelular || "");
  const rawLogin = String(emailOuCelular || "").trim();
  const emailNorm = rawLogin.includes("@") ? rawLogin.toLowerCase() : "";
  const celularNorm = rawLogin.replace(/\D/g, "");

  // ✅ Device token enviado pelo frontend (dispositivo confiado)
  const deviceTokenRaw = String(req.body?.device_token || "").trim();

  try {
    const [[usuario]] = await pool.query(
      `
      SELECT *
      FROM usuarios
      WHERE
        (email IS NOT NULL AND email <> '' AND LOWER(email) = ?)
        OR
        (
          celular IS NOT NULL AND celular <> ''
          AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(celular,'(',''),')',''),'-',''),' ',''),'+',''),'.','') = ?
        )
      LIMIT 1
      `,
      [emailNorm, celularNorm]
    );

    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });

    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaOk) return res.status(401).json({ message: "Senha incorreta." });

    // ✅ DISPOSITIVO CONFIADO: se o frontend enviou um device_token válido, pula o OTP
    if (deviceTokenRaw) {
      const deviceHash = createHash("sha256").update(deviceTokenRaw, "utf8").digest("hex");

      // ⚠️  IMPORTANTE: o device_token é salvo com usuario_ctx_id (linha específica do contexto),
      // não com usuario.id (linha base do login). Para multi-escola, são IDs diferentes.
      // Por isso buscamos pelo hash + CPF (via JOIN), não pelo usuario.id diretamente.
      const cpfBase = String(usuario.cpf || "").replace(/\D/g, "");
      const [[dispositivo]] = await pool.query(
        `SELECT dc.id, dc.usuario_id
         FROM dispositivos_confiados dc
         JOIN usuarios u2 ON u2.id = dc.usuario_id
         WHERE dc.token_hash = ?
           AND REPLACE(REPLACE(REPLACE(u2.cpf,'.',''),'-',''),'/','') = ?
           AND dc.expira_em > NOW()
         LIMIT 1`,
        [deviceHash, cpfBase]
      );

      if (dispositivo?.id) {
        // Atualiza último uso
        await pool.query(
          `UPDATE dispositivos_confiados SET ultimo_uso = NOW() WHERE id = ? LIMIT 1`,
          [dispositivo.id]
        );

        // Descobre contextos do usuário (igual ao fluxo /confirmar)
        const cpfLimpo = String(usuario.cpf || "").replace(/\D/g, "");
        const [escolasVinculadas] = await pool.query(
          `SELECT DISTINCT
             u.escola_id AS id,
             e.nome      AS nome,
             e.apelido   AS apelido,
             u.perfil    AS perfil,
             u.id        AS usuario_ctx_id
           FROM usuarios u
           LEFT JOIN escolas e ON e.id = u.escola_id
           WHERE REPLACE(REPLACE(REPLACE(u.cpf, '.', ''), '-', ''), '/', '') = ?
             AND u.ativo = 1
             AND u.escola_id IS NOT NULL
             AND (u.senha_hash IS NOT NULL AND u.senha_hash <> '')
             AND (
               (u.email IS NOT NULL AND u.email <> '' AND u.email = ?)
               OR
               (u.celular IS NOT NULL AND u.celular <> '' AND u.celular = ?)
             )
           ORDER BY e.nome ASC, u.perfil ASC`,
          [cpfLimpo, usuario.email || "", usuario.celular || ""]
        );

        // Multi-escola: ainda precisa escolher o contexto (frontend mostrará seleção de escola)
        if (Array.isArray(escolasVinculadas) && escolasVinculadas.length > 1) {
          return res.json({
            dispositivo_confiado: true,
            multi_escola: true,
            nome: usuario.nome || "Usuário",
            perfil: usuario.perfil || "aluno",
            escolas: escolasVinculadas,
            usuarioId: usuario.id,
          });
        }

        // Contexto único → emite JWT direto
        const ctx0 = escolasVinculadas?.[0] || null;
        const usuarioIdFinal = ctx0?.usuario_ctx_id ?? usuario.id;
        const escolaIdFinal  = ctx0?.id ?? usuario.escola_id ?? null;
        const perfilFinal    = ctx0?.perfil ?? usuario.perfil ?? "aluno";

        const [[escolaRow]] = await pool.query(
          `SELECT apelido FROM escolas WHERE id = ? LIMIT 1`,
          [escolaIdFinal]
        );
        const { perfis, permissoes } = await carregarRbac(usuarioIdFinal, escolaIdFinal);

        const token = jwt.sign(
          {
            scope: "escola",
            usuario_id: usuarioIdFinal,
            usuarioId: usuarioIdFinal,
            escola_id: escolaIdFinal,
            nome_escola: escolaRow?.apelido || null,
            perfil: perfilFinal,
            perfis,
            permissoes,
          },
          getJwtSecret(),
          { expiresIn: "8h" }
        );

        registrarAcesso(pool, {
          usuario_id: usuarioIdFinal,
          escola_id: escolaIdFinal,
          perfil: perfilFinal,
          ip: req.ip || req.headers["x-forwarded-for"],
          user_agent: req.headers["user-agent"],
          action: "login_dispositivo_confiado",
        });

        const fotoUrl = await buscarFotoUsuario(usuarioIdFinal, escolaIdFinal);
        const cpfLoginLimpo = String(usuario.cpf || "").replace(/\D/g, "");

        console.log(`[AUTH/login] Dispositivo confiado OK → usuário ${usuarioIdFinal}, pulou OTP`);

        return res.json({
          ok: true,
          dispositivo_confiado: true,
          token,
          nome: usuario.nome || "Usuário",
          cpf: cpfLoginLimpo,
          foto_url: fotoUrl,
          escola_id: escolaIdFinal,
          nome_escola: escolaRow?.apelido || "Escola não definida",
          perfil: perfilFinal,
          perfis,
          permissoes,
        });
      }
    }

    // ✅ Geração do código OTP (string)
    const codigo = String(randomInt(100000, 999999));

    // ✅ LOG diagnóstico (mantido)
    console.log("[AUTH/login] usuario.id =", usuario.id);
    console.log("[AUTH/login] codigo =", codigo);

    // ✅ IMPORTANTE: expiração calculada no MySQL (mesmo relógio do NOW())
    const [ins] = await pool.query(
      "INSERT INTO otp_codes (usuario_id, codigo, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [usuario.id, codigo]
    );

    console.log("[AUTH/login] otp insertId =", ins?.insertId);

    // ✅ Verifica o que ficou gravado no MySQL (principal)
    const [[rowOtp]] = await pool.query(
      "SELECT id, usuario_id, codigo, expira_em, NOW() AS now_db FROM otp_codes WHERE id = ?",
      [ins?.insertId]
    );

    console.log("[AUTH/login] otp gravado no DB =", rowOtp);

    if (usuario.email) await enviarCodigoEmail(usuario.email, codigo);

    return res.json({ message: "Código enviado para confirmação.", usuarioId: usuario.id });
  } catch (err) {
    console.error("Erro no login:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 2) Confirmar Código (login) – ajustado para incluir escola_id e nome_escola no token
 */
router.post("/confirmar", async (req, res) => {
  const { usuarioId, codigo, confiar_dispositivo } = req.body;
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 200);

  try {
    if (!usuarioId || !codigo) {
      return res.status(400).json({ message: "Usuário e código são obrigatórios." });
    }

    const [[otp]] = await pool.query(
      "SELECT id, usuario_id FROM otp_codes WHERE usuario_id = ? AND codigo = ? AND expira_em > NOW()",
      [usuarioId, codigo]
    );

    if (!otp) {
      return res.status(400).json({ message: "Código inválido ou expirado." });
    }

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [otp.id]);

    // 1) Carrega o usuário base (linha atual)
    const [[usuarioBase]] = await pool.query(
      `SELECT u.id, u.nome, u.cpf, u.email, u.celular, u.escola_id, u.perfil
       FROM usuarios u
       WHERE u.id = ?
       LIMIT 1`,
      [usuarioId]
    );

    if (!usuarioBase) {
      return res.status(404).json({ message: "Usuário não localizado para confirmação." });
    }

    const cpfLimpo = String(usuarioBase.cpf || "").replace(/\D/g, "");

    // 2) Descobre todos os CONTEXTOS ativos para o MESMO CPF (multi-escola e/ou multi-perfil)
    //    Retorna: escola_id + nome + perfil + usuario_ctx_id (id da linha em usuarios)
    const [escolasVinculadas] = await pool.query(
      `
      SELECT DISTINCT
        u.escola_id AS id,
        e.nome      AS nome,
        e.apelido   AS apelido,
        u.perfil    AS perfil,
        u.id        AS usuario_ctx_id
      FROM usuarios u
      LEFT JOIN escolas e ON e.id = u.escola_id
      WHERE REPLACE(REPLACE(REPLACE(u.cpf, '.', ''), '-', ''), '/', '') = ?
        AND u.ativo = 1
        AND u.escola_id IS NOT NULL
        AND (u.senha_hash IS NOT NULL AND u.senha_hash <> '')
        AND (
          (u.email IS NOT NULL AND u.email <> '' AND u.email = ?)
          OR
          (u.celular IS NOT NULL AND u.celular <> '' AND u.celular = ?)
        )
      ORDER BY e.nome ASC, u.perfil ASC
      `,
      [cpfLimpo, usuarioBase.email || "", usuarioBase.celular || ""]
    );

    // 3) Se houver mais de uma escola, NÃO emite token ainda — força escolha de contexto no frontend
    if (Array.isArray(escolasVinculadas) && escolasVinculadas.length > 1) {
      return res.json({
        multi_escola: true,
        nome: usuarioBase.nome || "Usuário",
        perfil: usuarioBase.perfil || "aluno",
        escolas: escolasVinculadas, // [{id, nome}, ...]
      });
    }

    // 4) Caso padrão: 1 contexto — emite token usando a linha correta em `usuarios`
    const ctx0 = escolasVinculadas?.[0] || null;

    const usuarioIdFinal = ctx0?.usuario_ctx_id ?? usuarioBase.id;
    const escolaIdFinal = ctx0?.id ?? usuarioBase.escola_id ?? null;
    const perfilFinal = ctx0?.perfil ?? usuarioBase.perfil ?? "aluno";

    const [[escolaRow]] = await pool.query(
      `SELECT apelido FROM escolas WHERE id = ? LIMIT 1`,
      [escolaIdFinal]
    );

    const { perfis, permissoes } = await carregarRbac(usuarioIdFinal, escolaIdFinal);

      const token = jwt.sign(
        {
          scope: "escola",
          usuario_id: usuarioIdFinal,
          usuarioId: usuarioIdFinal,
          escola_id: escolaIdFinal,
          nome_escola: escolaRow?.apelido || null,
          perfil: perfilFinal, // compatibilidade
          perfis,
          permissoes,
        },
        getJwtSecret(),
        { expiresIn: "8h" }
      );

      // ✅ Registra acesso para Usage Insights (CEO)
      registrarAcesso(pool, {
        usuario_id: usuarioIdFinal,
        escola_id: escolaIdFinal,
        perfil: perfilFinal,
        ip: req.ip || req.headers["x-forwarded-for"],
        user_agent: req.headers["user-agent"],
        action: "login",
      });

      const fotoUrlLogin = await buscarFotoUsuario(usuarioIdFinal, escolaIdFinal);
      const cpfLoginLimpo = String(usuarioBase.cpf || "").replace(/\D/g, "");

      // ✅ DISPOSITIVO CONFIADO: grava token se o usuário optou por confiar neste aparelho
      let deviceTokenNovo = null;
      if (confiar_dispositivo) {
        const rawToken = randomBytes(32).toString("hex"); // 64 chars hex
        const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
        try {
          await pool.query(
            `INSERT INTO dispositivos_confiados (usuario_id, token_hash, descricao, expira_em)
             VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 90 DAY))`,
            [usuarioIdFinal, tokenHash, userAgent]
          );
          deviceTokenNovo = rawToken;
          console.log(`[AUTH/confirmar] Dispositivo confiado registrado para usuário ${usuarioIdFinal}`);
        } catch (e) {
          console.error("[AUTH/confirmar] Falha ao registrar dispositivo confiado:", e.message);
        }
      }

      return res.json({
        token,
        nome: usuarioBase.nome || "Usuário",
        cpf: cpfLoginLimpo,
        foto_url: fotoUrlLogin,
        escola_id: escolaIdFinal,
        nome_escola: escolaRow?.apelido || "Escola não definida",
        perfil: perfilFinal, // compatibilidade
        perfis,
        permissoes,
        ...(deviceTokenNovo ? { device_token: deviceTokenNovo } : {}),
      });
  } catch (err) {
    console.error("Erro ao confirmar código:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});

/**
 * 3) Enviar código para cadastro novo
 */
router.post("/enviar-codigo-cadastro", async (req, res) => {
  const { email, cpf, escola_id } = req.body;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ message: "E-mail inválido." });
  }

  const cpfLimpo = String(cpf || "").replace(/\D/g, "");
  if (!cpfLimpo || cpfLimpo.length !== 11) {
    return res.status(400).json({ message: "CPF inválido." });
  }

  if (!escola_id) {
    return res.status(400).json({ message: "Escola é obrigatória." });
  }

  try {
    // ✅ Localiza o usuário pré-cadastrado (fonte: usuarios já criado no pré-cadastro)
    const [[usuario]] = await pool.query(
      `
      SELECT id
      FROM usuarios
      WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ?
        AND escola_id = ?
      LIMIT 1
      `,
      [cpfLimpo, Number(escola_id)]
    );


    if (!usuario?.id) {
      return res.status(404).json({
        message:
          "Usuário não localizado para este CPF e escola. Procure a direção/secretaria.",
      });
    }

    // ✅ Regra multi-escola:
    // - Permite mesmo e-mail se for do MESMO CPF (mesma pessoa em outra escola)
    // - Bloqueia se o e-mail já estiver ligado a OUTRO CPF
    const [[emailEmUso]] = await pool.query(
      "SELECT id, cpf FROM usuarios WHERE email = ? LIMIT 1",
      [email]
    );

    if (emailEmUso?.id && String(emailEmUso.cpf || "").replace(/\D/g, "") !== cpfLimpo) {
      return res.status(409).json({
        message: "Este e-mail já está em uso. Informe outro e-mail para continuar.",
      });
    }


    const codigo = String(randomInt(100000, 999999));

    // 🔁 Regra: reenviar invalida códigos anteriores (para este usuário e/ou e-mail)
    await pool.query("DELETE FROM otp_codes WHERE usuario_id = ?", [usuario.id]);
    await pool.query("DELETE FROM otp_codes WHERE email = ?", [email]);

    // ✅ Agora usuario_id NUNCA é NULL
    await pool.query(
      "INSERT INTO otp_codes (usuario_id, email, codigo, expira_em) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [usuario.id, email, codigo]
    );

    await enviarCodigoEmail(email, codigo);

    return res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao enviar código de cadastro:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});



/**
 * 4) Confirmar código para cadastro novo
 */
router.post("/confirmar-codigo-cadastro", async (req, res) => {
  const { email, codigo } = req.body;

  try {
    // ✅ Recupera usuario_id do OTP e puxa dados do pré-cadastro (professores OU equipe_escola)
    const [[row]] = await pool.query(
      `
      SELECT
        oc.id            AS otp_id,
        oc.usuario_id    AS usuario_id,
        u.cpf            AS cpf,
        u.escola_id      AS escola_id,
        u.perfil         AS perfil_usuario,
        u.nome           AS nome_usuario,
        p.nome           AS nome_professor,
        p.perfil         AS perfil_professor,
        eq.nome          AS nome_equipe
      FROM otp_codes oc
      JOIN usuarios u
        ON u.id = oc.usuario_id
      LEFT JOIN professores p
        ON REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = REPLACE(REPLACE(u.cpf, '.', ''), '-', '')
       AND p.escola_id = u.escola_id
      LEFT JOIN equipe_escola eq
        ON eq.cpf = REPLACE(REPLACE(u.cpf, '.', ''), '-', '')
       AND eq.escola_id = u.escola_id
      WHERE oc.email = ?
        AND oc.codigo = ?
        AND oc.expira_em > NOW()
      LIMIT 1
      `,
      [email, codigo]
    );

    if (!row) {
      return res.status(400).json({ message: "Código inválido ou expirado." });
    }

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [row.otp_id]);

    // Cascata de nome: professor → equipe_escola → usuarios
    const nomeFinal = row.nome_professor || row.nome_equipe || row.nome_usuario || "";
    // Cascata de perfil: professor → usuarios
    const perfilFinal = row.perfil_professor || row.perfil_usuario || "professor";

    return res.json({
      sucesso: true,
      usuario_id: row.usuario_id,
      cpf: row.cpf,
      escola_id: row.escola_id,
      nome: nomeFinal,
      perfil: perfilFinal,
    });
  } catch (err) {
    console.error("Erro ao confirmar código de cadastro:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 5) Pré-cadastros por e-mail (PÚBLICO)
 * - Retorna as escolas onde existe pré-cadastro PENDENTE para o e-mail informado.
 * - Critério de "pendente": senha_hash ainda não definida (ajustável depois).
 */
router.get("/pre-cadastros/por-email/:email", async (req, res) => {
  const email = String(req.params?.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, message: "E-mail inválido." });
  }

  try {
    const [rows] = await pool.query(
      `
      SELECT DISTINCT
        u.escola_id AS id,
        e.nome      AS nome
      FROM usuarios u
      LEFT JOIN escolas e ON e.id = u.escola_id
      WHERE u.email = ?
        AND u.perfil = 'professor'
        AND (u.senha_hash IS NULL OR u.senha_hash = '')
        AND u.escola_id IS NOT NULL
      ORDER BY e.nome ASC
      `,
      [email]
    );

    if (rows.length > 0) {
      return res.json({
        ok: true,
        preCadastroValido: true,
        escolas: rows,
        message: "Pré-cadastro localizado.",
      });
    }

    // ✅ Caso 2: e-mail existe, mas já concluiu cadastro (não é pré-cadastro pendente)
    const [[jaCadastrado]] = await pool.query(
      `
      SELECT id, perfil
      FROM usuarios
      WHERE email = ?
        AND (senha_hash IS NOT NULL AND senha_hash <> '')
      LIMIT 1
      `,
      [email]
    );

    if (jaCadastrado) {
      return res.json({
        ok: true,
        preCadastroValido: false,
        escolas: [],
        jaCadastrado: true,
        message: "Cadastro já concluído para este e-mail. Faça login.",
      });
    }

    // ✅ Caso 3: nada encontrado (nem pendente, nem cadastrado)
    return res.json({
      ok: true,
      preCadastroValido: false,
      escolas: [],
      message: "Não foi possível prosseguir. Procure a direção da escola.",
    });
  } catch (err) {
    console.error("Erro ao buscar pré-cadastros por e-mail:", err);
    return res.status(500).json({ ok: false, message: "Erro no servidor." });
  }
});

/**
 * 6) Validar pré-cadastro do professor (por CPF) — mantido
 * - Agora também retorna múltiplas escolas pendentes, se existirem.
 */
router.post("/validar-professor", async (req, res) => {
  const cpf = String(req.body?.cpf || "").trim();

  if (!cpf) {
    return res.status(400).json({ ok: false, message: "CPF é obrigatório." });
  }

  try {
    const cpfLimpo = String(cpf || "").replace(/\D/g, "");
    if (!cpfLimpo || cpfLimpo.length !== 11) {
      return res.status(400).json({ ok: false, message: "CPF inválido." });
    }

    // ── Busca pré-cadastros pendentes (todos os perfis de membros da escola) ──
    const [rows] = await pool.query(
      `
      SELECT DISTINCT
        u.escola_id AS id,
        e.nome      AS nome,
        COALESCE(p.perfil, u.perfil) AS perfil,
        COALESCE(p.nome, u.nome)     AS nome_pre_cadastrado
      FROM usuarios u
      LEFT JOIN escolas e
        ON e.id = u.escola_id
      LEFT JOIN professores p
        ON REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = REPLACE(REPLACE(u.cpf, '.', ''), '-', '')
       AND p.escola_id = u.escola_id
      WHERE REPLACE(REPLACE(u.cpf, '.', ''), '-', '') = ?
        AND u.perfil NOT IN ('diretor', 'militar', 'aluno', 'responsavel')
        AND u.escola_id IS NOT NULL
        AND (u.senha_hash IS NULL OR u.senha_hash = '')
      ORDER BY e.nome ASC
      `,
      [cpfLimpo]
    );

    // ✅ Se encontrou pré-cadastro pendente
    if (rows.length > 0) {
      return res.json({
        ok: true,
        preCadastroValido: true,
        escolas: rows,
        jaCadastrado: false,
        message: "Pré-cadastro localizado.",
      });
    }

    // ✅ Caso 2: CPF existe, mas já concluiu cadastro (senha_hash preenchida)
    const [[jaCadastrado]] = await pool.query(
      `
      SELECT id, perfil
      FROM usuarios
      WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ?
        AND perfil NOT IN ('diretor', 'militar', 'aluno', 'responsavel')
        AND (senha_hash IS NOT NULL AND senha_hash <> '')
      LIMIT 1
      `,
      [cpfLimpo]
    );

    if (jaCadastrado) {
      return res.json({
        ok: true,
        preCadastroValido: false,
        escolas: [],
        jaCadastrado: true,
        message: "Cadastro já concluído para este CPF. Faça login.",
      });
    }

    // ✅ Caso 3: nada encontrado
    return res.json({
      ok: true,
      preCadastroValido: false,
      escolas: [],
      jaCadastrado: false,
      message: "CPF não localizado no pré-cadastro. Procure a direção da escola.",
    });

  } catch (err) {
    console.error("Erro ao validar pré-cadastro:", err);
    res.status(500).json({ ok: false, message: "Erro no servidor." });
  }
});


/**
 * 6) Complementar dados do professor
 */
router.post("/complementar-professor", async (req, res) => {
  const { id, cpf, nome, data_nascimento, sexo, email, celular, escola_id, perfil } = req.body;
  const perfilFinal = perfil || "professor";

  if ((!id && !cpf) || !nome || !data_nascimento || !sexo) {
    return res.status(400).json({ message: "Campos obrigatórios." });
  }

  try {
    let escolaIdFinal = escola_id;

    if (!escola_id && cpf) {
      const cpfLimpoQuery = String(cpf || "").replace(/\D/g, "");
      const [[usuarioExistente]] = await pool.query(
        "SELECT escola_id FROM usuarios WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND perfil = ?",
        [cpfLimpoQuery, perfilFinal]
      );
      escolaIdFinal = usuarioExistente?.escola_id || null;
    }

    // ✅ Descobre o usuarioId alvo (necessário para validar e-mail duplicado)
    let usuarioIdAlvo = id || null;

    if (!usuarioIdAlvo) {
      const cpfLimpo = String(cpf || "").replace(/\D/g, "");
      const [[u]] = await pool.query(
        "SELECT id FROM usuarios WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND escola_id = ? AND perfil = ? LIMIT 1",
        [cpfLimpo, escolaIdFinal, perfilFinal]
      );
      usuarioIdAlvo = u?.id || null;
    }

    if (!usuarioIdAlvo) {
      return res.status(404).json({ message: "Usuário não localizado para complementar." });
    }

    // ✅ Regra multi-escola:
    // - Permite mesmo e-mail se for do MESMO CPF
    // - Bloqueia se o e-mail já estiver ligado a OUTRO CPF
    if (email && typeof email === "string" && email.includes("@")) {
      const cpfLimpoReq = String(cpf || "").replace(/\D/g, "");

      const [[emailEmUso]] = await pool.query(
        "SELECT id, cpf FROM usuarios WHERE email = ? LIMIT 1",
        [email]
      );

      if (emailEmUso?.id && String(emailEmUso.cpf || "").replace(/\D/g, "") !== cpfLimpoReq) {
        return res.status(409).json({
          message: "Este e-mail já está em uso. Informe outro e-mail para continuar.",
        });
      }
    }

    // ✅ Regra multi-escola (CELULAR):
    // - Permite mesmo celular se for do MESMO CPF (mesma pessoa em outra escola)
    // - Bloqueia se o celular já estiver ligado a OUTRO CPF
    if (celular && typeof celular === "string") {
      const cpfLimpoReq = String(cpf || "").replace(/\D/g, "");
      const celLimpoReq = String(celular || "").replace(/\D/g, "");

      // validação básica (aceita 10 ou 11 dígitos)
      if (celLimpoReq.length < 10 || celLimpoReq.length > 11) {
        return res.status(400).json({ message: "Celular inválido." });
      }

      const [rowsCel] = await pool.query(
        "SELECT id, cpf FROM usuarios WHERE celular = ?",
        [celLimpoReq]
      );

      // ✅ Só bloqueia se existir ALGUMA linha com celular igual e CPF diferente
      const existeOutroCpf = Array.isArray(rowsCel) && rowsCel.some((r) => {
        const cpfRow = String(r?.cpf || "").replace(/\D/g, "");
        return cpfRow && cpfRow !== cpfLimpoReq;
      });

      if (existeOutroCpf) {
        return res.status(409).json({
          message: "Este celular já está em uso. Informe outro celular para continuar.",
        });
      }
    }

    // ✅ Atualiza usuários e professores/equipe_disciplinar

    const celularFinal = celular ? String(celular).replace(/\D/g, "") : null;

    await pool.query(
      "UPDATE usuarios SET nome = ?, email = ?, celular = ?, escola_id = ? WHERE id = ? AND perfil = ?",
      [nome, email || null, celularFinal, escolaIdFinal, usuarioIdAlvo, perfilFinal]
    );

    const cpfLimpoFinal = String(cpf || "").replace(/\D/g, "");

    if (perfilFinal === "professor") {
      // Atualiza professores
      await pool.query(
        "UPDATE professores SET nome = ?, data_nascimento = ?, sexo = ? WHERE cpf = ? AND escola_id = ?",
        [nome, data_nascimento, sexo, cpfLimpoFinal, escolaIdFinal]
      );
    } else if (perfilFinal === "disciplinar") {
      // Atualiza equipe_escola
      await pool.query(
        "UPDATE equipe_escola SET nome = ?, email = ? WHERE cpf = ? AND escola_id = ?",
        [nome, email || null, cpfLimpoFinal, escolaIdFinal]
      );
    } else {
      // Demais perfis (coordenador, vice_diretor, supervisor, etc.) → cadastro_membros_escola
      await pool.query(
        "UPDATE cadastro_membros_escola SET nome = ? WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND escola_id = ?",
        [nome, cpfLimpoFinal, escolaIdFinal]
      );
    }

    return res.json({ sucesso: true });
  } catch (err) {
    // ✅ Fallback: se ainda ocorrer duplicidade por corrida/concorrência
    if (err?.code === "ER_DUP_ENTRY" && String(err?.sqlMessage || "").includes("usuarios.email")) {
      return res.status(409).json({
        message: "Este e-mail já está em uso. Informe outro e-mail para continuar.",
      });
    }

    console.error("Erro ao complementar dados:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 7) Cadastrar senha
 */
router.post("/cadastrar-senha", async (req, res) => {
  const { cpf, senha, perfil, email, celular } = req.body;
  const perfilFinal = perfil || "professor";

  // ✅ Validação forte (mesmas regras do front)
  const senhaValida =
    typeof senha === "string" &&
    senha.length >= 6 &&
    /[A-Za-z]/.test(senha) &&
    /\d/.test(senha) &&
    /[$#@*_]/.test(senha);

  if (!cpf || String(cpf).replace(/\D/g, "").length !== 11) {
    return res.status(400).json({ message: "CPF inválido." });
  }

  if (!senhaValida) {
    return res.status(400).json({
      message:
        "Senha fraca. Use no mínimo 6 caracteres com letras, números e pelo menos 1 destes: $#@*_",
    });
  }

  try {
    const senha_hash = await bcrypt.hash(senha, 10);

    // ✅ Fallback de segurança (CELULAR):
    // - Permite mesmo celular se for do MESMO CPF
    // - Bloqueia se o celular já estiver ligado a OUTRO CPF
    if (celular && typeof celular === "string") {
      const cpfLimpoReq = String(cpf || "").replace(/\D/g, "");
      const celLimpoReq = String(celular || "").replace(/\D/g, "");

      if (celLimpoReq.length < 10 || celLimpoReq.length > 11) {
        return res.status(400).json({ message: "Celular inválido." });
      }

      const [[celEmUso]] = await pool.query(
        "SELECT id, cpf FROM usuarios WHERE celular = ? LIMIT 1",
        [celLimpoReq]
      );

      if (celEmUso?.id && String(celEmUso.cpf || "").replace(/\D/g, "") !== cpfLimpoReq) {
        return res.status(409).json({
          message: "Este celular já está em uso. Informe outro celular para continuar.",
        });
      }
    }

    const cpfLimpoQuery = String(cpf || "").replace(/\D/g, "");
    await pool.query(
      "UPDATE usuarios SET senha_hash = ?, ativo = 1, email = COALESCE(?, email), celular = COALESCE(?, celular) WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND perfil = ?",
      [senha_hash, email || null, celular ? String(celular).replace(/\D/g, "") : null, cpfLimpoQuery, perfilFinal]
    );


    return res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao cadastrar senha:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 8) Enviar código para usuários já cadastrados
 */
router.post("/enviar-codigo", async (req, res) => {
  const { email } = req.body;
  try {
    const [[usuario]] = await pool.query(
      "SELECT id, email FROM usuarios WHERE email=?",
      [email]
    );
    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });

    // ── DEMO BYPASS ──────────────────────────────────────────────────────────
    // Conta de demonstração para revisão da Apple/Google:
    // Usa código fixo 123456, sem envio de e-mail (e-mail não existe).
    // O revisor usa o código informado nas Review Notes da App Store.
    const DEMO_EMAILS = ["demo@educamelhor.com.br"];
    const isDemoAccount = DEMO_EMAILS.includes(String(email || "").toLowerCase().trim());

    if (isDemoAccount) {
      const DEMO_CODE = "123456";
      await pool.query("DELETE FROM otp_codes WHERE usuario_id = ?", [usuario.id]);
      await pool.query(
        "INSERT INTO otp_codes (usuario_id, codigo, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))",
        [usuario.id, DEMO_CODE]
      );
      console.log(`[AUTH] Demo account OTP bypass: email=${email}, code=${DEMO_CODE}`);
      return res.json({ sucesso: true, _demo: true });
    }
    // ── FIM DEMO BYPASS ──────────────────────────────────────────────────────

    const codigo = String(randomInt(100000, 999999));

    // 🔁 Regra: reenviar invalida códigos anteriores (para este usuário)
    await pool.query("DELETE FROM otp_codes WHERE usuario_id = ?", [usuario.id]);

    // ✅ Expiração calculada no MySQL (5 minutos)
    await pool.query(
      "INSERT INTO otp_codes (usuario_id, codigo, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [usuario.id, codigo]
    );
    await enviarCodigoEmail(usuario.email, codigo);

    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao enviar código:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});



/**
 * RESET DE SENHA (usuário já cadastrado)
 * Fluxo:
 * 1) /reset-senha/enviar-codigo  -> envia OTP
 * 2) /reset-senha/confirmar-codigo -> valida OTP (não consome ainda)
 * 3) /reset-senha/alterar -> valida OTP + senha forte, atualiza senha e consome OTP
 */
router.post("/reset-senha/enviar-codigo", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "E-mail inválido." });
  }

  try {
    const [[usuario]] = await pool.query(
      `
      SELECT id, email
      FROM usuarios
      WHERE email = ?
        AND (senha_hash IS NOT NULL AND senha_hash <> '')
      LIMIT 1
      `,
      [email]
    );

    if (!usuario?.id) {
      return res.status(404).json({ message: "Usuário não encontrado." });
    }

    const codigo = String(randomInt(100000, 999999));

    // 🔁 Reenviar invalida códigos anteriores (por usuário e por e-mail)
    await pool.query("DELETE FROM otp_codes WHERE usuario_id = ?", [usuario.id]);
    await pool.query("DELETE FROM otp_codes WHERE email = ?", [email]);

    await pool.query(
      "INSERT INTO otp_codes (usuario_id, email, codigo, expira_em) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [usuario.id, email, codigo]
    );

    await enviarCodigoEmail(usuario.email, codigo);

    return res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao enviar código de reset de senha:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});

router.post("/reset-senha/confirmar-codigo", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const codigo = String(req.body?.codigo || "").trim();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "E-mail inválido." });
  }
  if (!codigo || codigo.length !== 6) {
    return res.status(400).json({ message: "Código inválido." });
  }

  try {
    const [[row]] = await pool.query(
      `
      SELECT id
      FROM otp_codes
      WHERE email = ?
        AND codigo = ?
        AND expira_em > NOW()
      LIMIT 1
      `,
      [email, codigo]
    );

    if (!row?.id) {
      return res.status(400).json({ message: "Código inválido ou expirado." });
    }

    // ✅ Não consome aqui — consumimos na alteração de senha (para manter o fluxo simples no front)
    return res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao confirmar código de reset de senha:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});

router.post("/reset-senha/alterar", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const codigo = String(req.body?.codigo || "").trim();
  const senha = String(req.body?.senha || "");

  // ✅ Mesmas regras do front/cadastrar-senha
  const senhaValida =
    typeof senha === "string" &&
    senha.length >= 6 &&
    /[A-Za-z]/.test(senha) &&
    /\d/.test(senha) &&
    /[$#@*_]/.test(senha);

  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "E-mail inválido." });
  }
  if (!codigo || codigo.length !== 6) {
    return res.status(400).json({ message: "Código inválido." });
  }
  if (!senhaValida) {
    return res.status(400).json({
      message:
        "Senha fraca. Use no mínimo 6 caracteres com letras, números e pelo menos 1 destes: $#@*_",
    });
  }

  try {
    // 1) valida OTP (e-mail + código + expiração)
    const [[otp]] = await pool.query(
      `
      SELECT id, usuario_id
      FROM otp_codes
      WHERE email = ?
        AND codigo = ?
        AND expira_em > NOW()
      LIMIT 1
      `,
      [email, codigo]
    );

    if (!otp?.id) {
      return res.status(400).json({ message: "Código inválido ou expirado." });
    }

    // 2) valida se usuário existe (e tem senha cadastrada)
    const [[usuario]] = await pool.query(
      `
      SELECT id
      FROM usuarios
      WHERE email = ?
      LIMIT 1
      `,
      [email]
    );

    if (!usuario?.id) {
      return res.status(404).json({ message: "Usuário não encontrado." });
    }

    // 3) atualiza senha (para TODAS as linhas com o mesmo e-mail — cobre multi-escola)
    const senha_hash = await bcrypt.hash(senha, 10);

    await pool.query(
      `
      UPDATE usuarios
      SET senha_hash = ?, ativo = 1
      WHERE email = ?
      `,
      [senha_hash, email]
    );

    // 4) consome OTP
    await pool.query("DELETE FROM otp_codes WHERE id = ?", [otp.id]);

    return res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao alterar senha (reset):", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});

/**
 * 9) Confirmar código para usuário já existente
 */
router.post("/confirmar-cadastro", async (req, res) => {
  const { email, codigo } = req.body;
  try {
    const [[usuario]] = await pool.query(
      "SELECT id FROM usuarios WHERE email=?",
      [email]
    );
    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });

    // ── DEMO BYPASS ──────────────────────────────────────────────────────────
    // Conta demo para revisao Apple/Google: aceita codigo fixo sem consultar banco.
    const DEMO_EMAILS_CONFIRMAR = ["demo@educamelhor.com.br"];
    const DEMO_CODE_CONFIRMAR   = "123456";
    if (DEMO_EMAILS_CONFIRMAR.includes(String(email || "").toLowerCase().trim()) &&
        String(codigo || "").trim() === DEMO_CODE_CONFIRMAR) {
      console.log(`[AUTH] Demo bypass /confirmar-cadastro: email=${email}`);
      return res.json({ sucesso: true });
    }
    // ── FIM DEMO BYPASS ──────────────────────────────────────────────────────

    const [[otp]] = await pool.query(
      "SELECT * FROM otp_codes WHERE usuario_id=? AND codigo=? AND expira_em > NOW()",
      [usuario.id, codigo]
    );
    if (!otp) return res.status(400).json({ message: "C\u00f3digo inv\u00e1lido ou expirado." });

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [otp.id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao confirmar código:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 2.1) Confirmar Escola (multi-escola) — emite token com escola_id correto
 */
router.post("/confirmar-escola", async (req, res) => {
  const { usuarioId, escola_id, usuario_ctx_id } = req.body;

  try {
    const escolaId = Number(escola_id);
    if (!usuarioId || !escolaId) {
      return res.status(400).json({ message: "usuarioId e escola_id são obrigatórios." });
    }

    const [[usuarioBase]] = await pool.query(
      `SELECT id, nome, cpf, email, celular, perfil
       FROM usuarios
       WHERE id = ?
       LIMIT 1`,
      [usuarioId]
    );

    if (!usuarioBase) {
      return res.status(404).json({ message: "Usuário não localizado." });
    }

    // ✅ Valida vínculo por CONTEXTO (usuario_ctx_id) — obrigatório para multi-perfil
    const ctxId = Number(usuario_ctx_id);

    if (!ctxId) {
      return res.status(400).json({ message: "usuario_ctx_id é obrigatório para confirmar a escola." });
    }

    const cpfBaseNorm = String(usuarioBase.cpf || "").replace(/\D/g, "");
    const [[usuarioEscola]] = await pool.query(
      `
      SELECT u.id, u.escola_id, u.perfil, e.apelido AS nome_escola
      FROM usuarios u
      LEFT JOIN escolas e ON e.id = u.escola_id
      WHERE u.id = ?
        AND REPLACE(REPLACE(REPLACE(u.cpf, '.', ''), '-', ''), '/', '') = ?
        AND u.ativo = 1
        AND u.escola_id = ?
        AND (u.senha_hash IS NOT NULL AND u.senha_hash <> '')
      LIMIT 1
      `,
      [ctxId, cpfBaseNorm, escolaId]
    );

    if (!usuarioEscola) {
      return res.status(403).json({ message: "Você não possui vínculo válido com esta escola." });
    }

    const { perfis, permissoes } = await carregarRbac(usuarioEscola.id, usuarioEscola.escola_id);

    const token = jwt.sign(
      {
        scope: "escola",

        // ✅ compatibilidade (front antigo pode ler usuarioId; novo pode ler usuario_id)
        usuario_id: usuarioEscola.id,
        usuarioId: usuarioEscola.id, // ✅ id do contexto escolhido

        escola_id: usuarioEscola.escola_id,
        nome_escola: usuarioEscola.nome_escola || null,
        perfil: usuarioEscola.perfil || "aluno", // ✅ perfil REAL do contexto
        perfis,
        permissoes,
      },
      getJwtSecret(),
      { expiresIn: "8h" }
    );

    const fotoUrlEscola = await buscarFotoUsuario(usuarioEscola.id, usuarioEscola.escola_id);
    const cpfEscolaLimpo = String(usuarioBase.cpf || "").replace(/\D/g, "");

    return res.json({
      token,
      nome: usuarioBase.nome || "Usuário",
      cpf: cpfEscolaLimpo,
      foto_url: fotoUrlEscola,
      escola_id: usuarioEscola.escola_id,
      nome_escola: usuarioEscola.nome_escola || "Escola não definida",
      perfil: usuarioEscola.perfil || "aluno",
      perfis,
      permissoes,
    });
  } catch (err) {
    console.error("Erro ao confirmar escola:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 10) Upload de foto do professor (opcional)
 * - Salva arquivo em /uploads/professores
 * - Persiste o caminho em professores.foto (cpf + escola_id)
 */

router.post("/upload-foto-professor", (req, res) => {
  uploadFoto.single("foto")(req, res, async (err) => {
    try {
      // ✅ Erros do multer (tamanho/tipo/etc.)
      if (err) {
        if (err?.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ message: "Arquivo muito grande. Limite: 2MB." });
        }

        if (err?.message === "TIPO_ARQUIVO_INVALIDO") {
          return res.status(400).json({ message: "Formato inválido. Envie JPEG, PNG ou WEBP." });
        }

        console.error("Erro no multer (upload foto):", err);
        return res.status(400).json({ message: "Falha no upload da foto." });
      }

      const cpfLimpo = String(req.body?.cpf || "").replace(/\D/g, "");
      const escolaId = Number(req.body?.escola_id);

      if (!cpfLimpo || cpfLimpo.length !== 11) {
        return res.status(400).json({ message: "CPF inválido." });
      }
      if (!escolaId) {
        return res.status(400).json({ message: "Escola é obrigatória." });
      }
      if (!req.file) {
        return res.status(400).json({ message: "Arquivo não enviado." });
      }

      // Caminho relativo salvo no banco (compatível com VARCHAR/TEXT)
      const fotoPath = `/uploads/professores/${req.file.filename}`;

      await pool.query(
        "UPDATE professores SET foto = ? WHERE cpf = ? AND escola_id = ?",
        [fotoPath, cpfLimpo, escolaId]
      );

      return res.json({ sucesso: true, foto: fotoPath });
    } catch (e) {
      console.error("Erro ao fazer upload da foto:", e);
      return res.status(500).json({ message: "Erro no servidor." });
    }
  });
});


export default router;

