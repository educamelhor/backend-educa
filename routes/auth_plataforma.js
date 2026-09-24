// routes/auth_plataforma.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import nodemailer from "nodemailer";
import { randomInt } from "crypto";

const router = express.Router();

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET não configurado.");
  return secret;
}

async function enviarCodigoEmail(email, codigo) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.error("[AUTH_PLATAFORMA] SMTP não configurado.");
    throw new Error("SMTP_NAO_CONFIGURADO");
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"EDUCA.MELHOR — Plataforma" <${SMTP_USER}>`,
    to: email,
    subject: "Código de Verificação — Plataforma CEO",
    text: `Seu código de confirmação da Plataforma CEO é: ${codigo}\n\nEste código expira em 5 minutos.`,
    html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px;background:#0f172a;border-radius:16px;border:1px solid rgba(99,102,241,0.3);color:#f8fafc">
      <div style="text-align:center;margin-bottom:16px">
        <h2 style="color:#818cf8;margin:0;font-size:22px;font-weight:800">EDUCA.MELHOR</h2>
        <p style="color:#94a3b8;font-size:12px;margin:4px 0 0 0;letter-spacing:1px;text-transform:uppercase">Painel de Gestão Global (CEO)</p>
      </div>
      <p style="color:#cbd5e1;font-size:14px;line-height:1.5">Seu código de verificação para acesso à <b>Plataforma CEO</b> é:</p>
      <div style="font-size:36px;font-weight:900;letter-spacing:8px;color:#38bdf8;text-align:center;padding:18px;background:rgba(255,255,255,0.05);border-radius:12px;border:1px solid rgba(56,189,248,0.25);margin:16px 0">${codigo}</div>
      <p style="color:#64748b;font-size:12px;text-align:center;margin:0">Este código é de uso único e expira em 5 minutos.</p>
    </div>`,
  });
}

async function carregarPermissoesPlataforma(usuarioId) {
  // Usa overrides por usuário (já existe no seu RBAC), filtrando por "plataforma.%"
  const [rows] = await pool.query(
    `
    SELECT DISTINCT perm.chave
    FROM rbac_usuario_permissoes upm
    JOIN rbac_permissoes perm ON perm.id = upm.permissao_id
    WHERE upm.usuario_id = ?
      AND upm.permitido = 1
      AND perm.chave LIKE 'plataforma.%'
    ORDER BY perm.chave
    `,
    [Number(usuarioId)]
  );

  return (rows || []).map((r) => r.chave).filter(Boolean);
}

/**
 * Login Plataforma (CEO)
 * - exige perfil SUPER_ADMIN ou ADMIN_GLOBAL
 * - exige escola_id IS NULL (não pode ser contexto escolar)
 * - senha OK -> envia OTP por e-mail
 */
router.post("/login", async (req, res) => {
  const body = req.body || {};
  const { email, senha } = body;

  const emailNorm = String(email || "").trim().toLowerCase();
  if (!emailNorm || !emailNorm.includes("@")) {
    return res.status(400).json({ message: "E-mail inválido." });
  }
  if (!senha) {
    return res.status(400).json({ message: "Senha é obrigatória." });
  }

  try {
    const [[usuario]] = await pool.query(
      `
      SELECT id, nome, email, senha_hash, ativo, perfil, escola_id
      FROM usuarios
      WHERE LOWER(email) = ?
        AND escola_id = 0
      LIMIT 1
      `,
      [emailNorm]
    );

    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });

    if (Number(usuario.ativo) !== 1) {
      return res.status(403).json({ message: "Usuário inativo." });
    }

    const perfil = String(usuario.perfil || "").toUpperCase();
    const permitido =
      perfil === "ADMIN" || perfil === "SUPER_ADMIN" || perfil === "ADMIN_GLOBAL";

    if (!permitido) {
      return res.status(403).json({ message: "Acesso restrito à Plataforma." });
    }

    // Blindagem: Plataforma usa escola_id = 0 (sentinela global)
    if (Number(usuario.escola_id) !== 0) {
      return res.status(403).json({ message: "Usuário não é global (escola_id inválido)." });
    }

    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaOk) return res.status(401).json({ message: "Senha incorreta." });

    const codigo = String(randomInt(100000, 999999));

    // reenviar invalida códigos anteriores (por usuário e por e-mail)
    await pool.query("DELETE FROM otp_codes WHERE usuario_id = ?", [usuario.id]);
    await pool.query("DELETE FROM otp_codes WHERE email = ?", [emailNorm]);

    await pool.query(
      "INSERT INTO otp_codes (usuario_id, email, codigo, expira_em) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [usuario.id, emailNorm, codigo]
    );

    await enviarCodigoEmail(emailNorm, codigo);

    return res.json({
      ok: true,
      message: "Código enviado para confirmação.",
      usuarioId: usuario.id,
    });
  } catch (err) {
    console.error("[AUTH_PLATAFORMA/login] erro:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});

/**
 * Confirmar OTP Plataforma -> emite JWT com scope: "plataforma"
 */
router.post("/confirmar", async (req, res) => {
  const body = req.body || {};
  const { usuarioId, codigo } = body;

  const uid = Number(usuarioId);
  const cod = String(codigo || "").trim();

  if (!uid || !cod) {
    return res.status(400).json({ message: "Usuário e código são obrigatórios." });
  }

  try {
    const [[otp]] = await pool.query(
      `
      SELECT id, usuario_id
      FROM otp_codes
      WHERE usuario_id = ?
        AND codigo = ?
        AND expira_em > NOW()
      LIMIT 1
      `,
      [uid, cod]
    );

    if (!otp) {
      return res.status(400).json({ message: "Código inválido ou expirado." });
    }

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [otp.id]);

    const [[usuario]] = await pool.query(
      `
      SELECT id, nome, email, ativo, perfil, escola_id
      FROM usuarios
      WHERE id = ?
      LIMIT 1
      `,
      [uid]
    );

    if (!usuario) return res.status(404).json({ message: "Usuário não localizado." });
    if (Number(usuario.ativo) !== 1) return res.status(403).json({ message: "Usuário inativo." });

    const perfil = String(usuario.perfil || "").toUpperCase();
    const permitido =
      perfil === "ADMIN" || perfil === "SUPER_ADMIN" || perfil === "ADMIN_GLOBAL";

    if (!permitido) {
      return res.status(403).json({ message: "Acesso restrito à Plataforma." });
    }

    if (Number(usuario.escola_id) !== 0) {
      return res.status(403).json({ message: "Usuário não é global (escola_id inválido)." });
    }

    const permissoes = await carregarPermissoesPlataforma(usuario.id);

    const token = jwt.sign(
      {
        usuarioId: usuario.id,
        perfil,
        scope: "plataforma",
        permissoes,
      },
      getJwtSecret(),
      { expiresIn: "8h" }
    );

    return res.json({
      ok: true,
      token,
      nome: usuario.nome || "Usuário",
      perfil,
      scope: "plataforma",
      permissoes,
    });
  } catch (err) {
    console.error("[AUTH_PLATAFORMA/confirmar] erro:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});

export default router;
