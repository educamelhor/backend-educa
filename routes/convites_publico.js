/**
 * routes/convites_publico.js
 *
 * ⚠️  ROTAS PÚBLICAS — sem autenticação
 * Usadas pelo fluxo de ativação de conta de novos diretores:
 *   POST /api/convites-ativacao/:token/validar
 *   POST /api/convites-ativacao/:token/enviar-codigo
 *   POST /api/convites-ativacao/:token/ativar
 *
 * Motivo: /api/plataforma/* exige autenticarToken (escopo "plataforma"),
 * mas o novo diretor ainda não tem conta — ele não pode ter um token.
 * Estas 3 rotas precisam ser acessíveis SEM autenticação.
 */
import express from "express";
import bcrypt from "bcryptjs";
import crypto, { randomInt } from "crypto";
import nodemailer from "nodemailer";

const router = express.Router();

// ── Helper: SHA-256 (mesmo algoritmo do plataforma.js) ─────────────────────
function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

// ── Helper: envio de e-mail com OTP ─────────────────────────────────────────
async function enviarCodigoEmail(email, codigo) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.error("[CONVITES-PUBLIC] SMTP não configurado.");
    throw new Error("SMTP_NAO_CONFIGURADO");
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"Educa.Melhor" <${SMTP_USER}>`,
    to: email,
    subject: "Código de Verificação — Educa.Melhor",
    text: `Seu código de verificação é: ${codigo}\n\nEste código expira em 5 minutos.`,
    html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px">
      <h2 style="color:#1e40af;margin-bottom:8px">Educa.Melhor</h2>
      <p style="color:#475569">Seu código de verificação de ativação de conta é:</p>
      <div style="font-size:32px;font-weight:900;letter-spacing:6px;color:#0f172a;text-align:center;padding:16px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;margin:12px 0">${codigo}</div>
      <p style="color:#94a3b8;font-size:12px">Este código expira em 5 minutos.</p>
    </div>`,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 1) VALIDAR CONVITE
// POST /api/convites-ativacao/:token/validar
// Retorna dados do diretor para exibir na tela (nome, e-mail, escola)
// ══════════════════════════════════════════════════════════════════════════════
router.post("/:token/validar", async (req, res) => {
  const db = req.db;
  const tokenHash = sha256(req.params.token);
  try {
    const [rows] = await db.query(`
      SELECT c.id AS convite_id, c.usuario_id, c.expira_em, c.usado_em,
             u.nome, u.email, u.perfil, u.escola_id,
             e.nome AS escola_nome,
             CASE
               WHEN u.perfil = 'militar' THEN 'Comandante (Disciplinar)'
               WHEN u.perfil = 'diretor' AND e.tipo LIKE '%CCMDF%' THEN 'Diretor Pedagógico'
               ELSE 'Diretor'
             END AS papel_label
      FROM usuarios_convites c
      JOIN usuarios u ON u.id = c.usuario_id
      LEFT JOIN escolas e ON e.id = u.escola_id
      WHERE c.token_hash = ? LIMIT 1
    `, [tokenHash]);

    if (!rows.length) return res.status(404).json({ ok: false, message: "Convite inválido ou não encontrado." });
    const c = rows[0];
    if (c.usado_em) return res.status(409).json({ ok: false, message: "Este convite já foi utilizado. Faça login normalmente." });
    if (new Date(c.expira_em) < new Date()) return res.status(410).json({ ok: false, message: "Convite expirado. Solicite um novo código ao administrador." });

    return res.json({
      ok: true,
      usuario: {
        nome: c.nome,
        email: c.email,
        perfil: c.perfil,
        papel_label: c.papel_label,
        escola_nome: c.escola_nome,
      },
    });
  } catch (err) {
    console.error("[CONVITES-PUBLIC][VALIDAR]", err);
    return res.status(500).json({ ok: false, message: "Erro ao validar convite." });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 2) ENVIAR CÓDIGO OTP PARA E-MAIL
// POST /api/convites-ativacao/:token/enviar-codigo
// body: { email }
// ══════════════════════════════════════════════════════════════════════════════
router.post("/:token/enviar-codigo", async (req, res) => {
  const db = req.db;
  const tokenHash = sha256(req.params.token);
  const emailInformado = String(req.body?.email || "").trim().toLowerCase();

  if (!emailInformado || !emailInformado.includes("@")) {
    return res.status(400).json({ ok: false, message: "E-mail inválido." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id, usuario_id, usado_em, expira_em FROM usuarios_convites WHERE token_hash = ? LIMIT 1",
      [tokenHash]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "Convite inválido." });
    const c = rows[0];
    if (c.usado_em) return res.status(409).json({ ok: false, message: "Convite já utilizado." });
    if (new Date(c.expira_em) < new Date()) return res.status(410).json({ ok: false, message: "Convite expirado." });

    const codigo = String(randomInt(100000, 999999));

    await db.query("DELETE FROM otp_codes WHERE usuario_id = ?", [c.usuario_id]);
    await db.query(
      "INSERT INTO otp_codes (usuario_id, email, codigo, expira_em) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [c.usuario_id, emailInformado, codigo]
    );

    try {
      await enviarCodigoEmail(emailInformado, codigo);
    } catch (smtpErr) {
      console.error("[CONVITES-PUBLIC][ENVIAR OTP] SMTP falhou:", smtpErr.message);
      if (process.env.NODE_ENV === "development") {
        return res.json({ ok: true, message: `Código enviado (dev): ${codigo}`, _dev_codigo: codigo });
      }
      return res.status(500).json({ ok: false, message: "Erro ao enviar e-mail. Verifique o endereço informado." });
    }

    return res.json({ ok: true, message: "Código de verificação enviado para o e-mail informado." });
  } catch (err) {
    console.error("[CONVITES-PUBLIC][ENVIAR CÓDIGO]", err);
    return res.status(500).json({ ok: false, message: "Erro ao enviar código." });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 3) ATIVAR CONTA COM OTP
// POST /api/convites-ativacao/:token/ativar
// body: { codigo, email, senha }
// ══════════════════════════════════════════════════════════════════════════════
router.post("/:token/ativar", async (req, res) => {
  const db = req.db;
  const tokenHash = sha256(req.params.token);
  const { codigo, email, senha } = req.body || {};

  if (!senha || senha.length < 6) return res.status(400).json({ ok: false, message: "Senha inválida (mínimo 6 caracteres)." });
  if (!codigo) return res.status(400).json({ ok: false, message: "Código de verificação é obrigatório." });
  if (!email) return res.status(400).json({ ok: false, message: "E-mail é obrigatório." });

  try {
    // 1) Valida convite
    const [rows] = await db.query(
      "SELECT id AS convite_id, usuario_id, usado_em, expira_em FROM usuarios_convites WHERE token_hash = ? LIMIT 1",
      [tokenHash]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "Convite inválido." });
    const convite = rows[0];
    if (convite.usado_em) return res.status(409).json({ ok: false, message: "Convite já utilizado." });
    if (new Date(convite.expira_em) < new Date()) return res.status(410).json({ ok: false, message: "Convite expirado." });

    // 2) Valida OTP
    const [otpRows] = await db.query(
      "SELECT id, codigo, expira_em FROM otp_codes WHERE usuario_id = ? AND email = ? ORDER BY id DESC LIMIT 1",
      [convite.usuario_id, email.trim().toLowerCase()]
    );
    if (!otpRows.length) return res.status(400).json({ ok: false, message: "Código de verificação não encontrado. Envie um novo código." });
    const otp = otpRows[0];
    if (String(otp.codigo) !== String(codigo)) return res.status(400).json({ ok: false, message: "Código incorreto." });
    if (new Date(otp.expira_em) < new Date()) return res.status(410).json({ ok: false, message: "Código expirado. Envie um novo." });

    // 3) Ativa conta em transação
    const senhaHash = await bcrypt.hash(senha, 10);

    await db.query("START TRANSACTION");
    await db.query(
      "UPDATE usuarios SET senha_hash = ?, email = ?, ativo = 1 WHERE id = ?",
      [senhaHash, email.trim().toLowerCase(), convite.usuario_id]
    );
    await db.query("UPDATE usuarios_convites SET usado_em = NOW() WHERE id = ?", [convite.convite_id]);
    await db.query("DELETE FROM otp_codes WHERE usuario_id = ?", [convite.usuario_id]);
    await db.query("COMMIT");

    return res.json({ ok: true, message: "Conta ativada com sucesso! Faça login com seu e-mail e senha." });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("[CONVITES-PUBLIC][ATIVAR]", err);
    return res.status(500).json({ ok: false, message: "Erro ao ativar convite." });
  }
});

export default router;
