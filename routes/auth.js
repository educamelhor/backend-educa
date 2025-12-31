// api/routes/auth.js
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import nodemailer from "nodemailer";
import { randomInt } from "crypto";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "superseguro";

/**
 * Função utilitária para envio de e-mail com código OTP
 */
async function enviarCodigoEmail(email, codigo) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await transporter.sendMail({
    from: `"Sistema Educacional" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Código de Confirmação",
    text: `Seu código de verificação é: ${codigo}`
  });
}

/**
 * 1) Login – envia código de confirmação
 */
router.post("/login", async (req, res) => {
  const { emailOuCelular, senha } = req.body;
  try {
    const [[usuario]] = await pool.query(
      "SELECT * FROM usuarios WHERE email = ? OR celular = ?",
      [emailOuCelular, emailOuCelular]
    );
    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });

    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaOk) return res.status(401).json({ message: "Senha incorreta." });

    const codigo = String(randomInt(100000, 999999));
    const expira = new Date(Date.now() + 5 * 60000);

    await pool.query(
      "INSERT INTO otp_codes (usuario_id, codigo, expira_em) VALUES (?, ?, ?)",
      [usuario.id, codigo, expira]
    );

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
  const { usuarioId, codigo } = req.body;
  try {
    const [[otp]] = await pool.query(
      "SELECT * FROM otp_codes WHERE usuario_id = ? AND codigo = ? AND expira_em > NOW()",
      [usuarioId, codigo]
    );
    if (!otp) return res.status(400).json({ message: "Código inválido ou expirado." });

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [otp.id]);

    const [[usuario]] = await pool.query(
      `SELECT u.nome, u.escola_id, u.perfil, e.nome AS nome_escola
       FROM usuarios u
       LEFT JOIN escolas e ON e.id = u.escola_id
       WHERE u.id = ?`,
      [usuarioId]
    );

    // 🔹 Token agora inclui escola_id e nome_escola
    const token = jwt.sign(
      {
        usuarioId,
        escola_id: usuario?.escola_id || null,
        nome_escola: usuario?.nome_escola || null,
        perfil: usuario?.perfil || "aluno"
      },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({
      token,
      nome: usuario?.nome || "Usuário",
      escola_id: usuario?.escola_id || null,
      nome_escola: usuario?.nome_escola || "Escola não definida",
      perfil: usuario?.perfil || "aluno",
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
  const { email } = req.body;
  try {
    const codigo = String(randomInt(100000, 999999));
    const expira = new Date(Date.now() + 10 * 60000);

    await pool.query(
      "INSERT INTO otp_codes (usuario_id, email, codigo, expira_em) VALUES (NULL, ?, ?, ?)",
      [email, codigo, expira]
    );
    await enviarCodigoEmail(email, codigo);

    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao enviar código de cadastro:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});

/**
 * 4) Confirmar código para cadastro novo
 */
router.post("/confirmar-codigo-cadastro", async (req, res) => {
  const { email, codigo } = req.body;
  try {
    const [[otp]] = await pool.query(
      "SELECT * FROM otp_codes WHERE email=? AND codigo=? AND expira_em > NOW()",
      [email, codigo]
    );
    if (!otp) return res.status(400).json({ message: "Código inválido ou expirado." });

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [otp.id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao confirmar código de cadastro:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});

/**
 * 5) Validar pré-cadastro do professor
 */
router.post("/validar-professor", async (req, res) => {
  const { cpf } = req.body;
  try {
    const [[usuario]] = await pool.query(
      "SELECT id, nome, escola_id FROM usuarios WHERE perfil = 'professor' AND cpf = ?",
      [cpf]
    );
    if (!usuario) {
      return res.json({ preCadastroValido: false });
    }
    const [[escola]] = await pool.query(
      "SELECT id, nome FROM escolas WHERE id = ?",
      [usuario.escola_id]
    );
    return res.json({
      preCadastroValido: true,
      escolas: escola ? [escola] : [],
    });
  } catch (err) {
    console.error("Erro ao validar pré-cadastro:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});

/**
 * 6) Complementar dados do professor
 */
router.post("/complementar-professor", async (req, res) => {
  const { id, cpf, nome, data_nascimento, sexo, email, celular, escola_id, perfil } = req.body;
  const perfilFinal = perfil || 'professor';

  if ((!id && !cpf) || !nome || !data_nascimento || !sexo) {
    return res.status(400).json({ message: "Campos obrigatórios." });
  }

  try {
    let escolaIdFinal = escola_id;
    if (!escola_id && cpf) {
      const [[usuarioExistente]] = await pool.query(
        "SELECT escola_id FROM usuarios WHERE cpf = ? AND perfil = ?",
        [cpf, perfilFinal]
      );
      escolaIdFinal = usuarioExistente?.escola_id || null;
    }

    if (id) {
      await pool.query(
        "UPDATE usuarios SET nome = ?, email = ?, celular = ?, escola_id = ? WHERE id = ? AND perfil = ?",
        [nome, email || null, celular || null, escolaIdFinal, id, perfilFinal]
      );
      await pool.query(
        "UPDATE professores SET nome = ?, data_nascimento = ?, sexo = ? WHERE cpf = ?",
        [nome, data_nascimento, sexo, cpf]
      );
    } else {
      await pool.query(
        "UPDATE usuarios SET nome = ?, email = ?, celular = ?, escola_id = ? WHERE cpf = ? AND perfil = ?",
        [nome, email || null, celular || null, escolaIdFinal, cpf, perfilFinal]
      );
      await pool.query(
        "UPDATE professores SET nome = ?, data_nascimento = ?, sexo = ? WHERE cpf = ?",
        [nome, data_nascimento, sexo, cpf]
      );
    }

    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao complementar dados:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});

/**
 * 7) Cadastrar senha
 */
router.post("/cadastrar-senha", async (req, res) => {
  const { cpf, senha, perfil, email, celular } = req.body;
  const perfilFinal = perfil || 'professor';
  try {
    const senha_hash = await bcrypt.hash(senha, 10);
    await pool.query(
      "UPDATE usuarios SET senha_hash = ?, ativo = 1, email = COALESCE(?, email), celular = COALESCE(?, celular) WHERE cpf = ? AND perfil = ?",
      [senha_hash, email || null, celular || null, cpf, perfilFinal]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao cadastrar senha:", err);
    res.status(500).json({ message: "Erro no servidor." });
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

    const codigo = String(randomInt(100000, 999999));
    const expira = new Date(Date.now() + 10 * 60000);

    await pool.query(
      "INSERT INTO otp_codes (usuario_id, codigo, expira_em) VALUES (?, ?, ?)",
      [usuario.id, codigo, expira]
    );
    await enviarCodigoEmail(usuario.email, codigo);

    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao enviar código:", err);
    res.status(500).json({ message: "Erro no servidor." });
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

    const [[otp]] = await pool.query(
      "SELECT * FROM otp_codes WHERE usuario_id=? AND codigo=? AND expira_em > NOW()",
      [usuario.id, codigo]
    );
    if (!otp) return res.status(400).json({ message: "Código inválido ou expirado." });

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [otp.id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao confirmar código:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});

export default router;
