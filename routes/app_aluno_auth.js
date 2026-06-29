// routes/app_aluno_auth.js
// Router público para autenticação do aluno — sem middleware de auth
// Montado em /api/app-aluno diretamente no server.js

import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import pool from "../db.js";

const router = express.Router();

const APP_PAIS_JWT_SECRET =
  process.env.APP_PAIS_JWT_SECRET || "DEV_ONLY__app_pais_jwt_secret_2025";

function normalizarCpf(cpf) {
  return String(cpf || "").replace(/\D/g, "").trim();
}

function maskPhone(tel) {
  const t = String(tel || "").replace(/\D/g, "");
  if (t.length < 8) return "(**) *****-????";
  return `(**) *****-${t.slice(-4)}`;
}

async function enviarCodigoPorSms(telefone, codigo) {
  // Integração SMS via Resend/Twilio — placeholder para implementação futura
  // Por enquanto apenas loga (em dev) ou chama serviço externo (em prod)
  console.log(`[APP_ALUNO] SMS para ${maskPhone(telefone)}: código ${codigo}`);
}

// ─────────────────────────────────────────────────────────────
// POST /solicitar-codigo
// ─────────────────────────────────────────────────────────────
router.post("/solicitar-codigo", async (req, res) => {
  try {
    const cpf = normalizarCpf(req.body?.cpf);
    if (!cpf) return res.status(400).json({ message: "CPF é obrigatório." });

    const [[aluno]] = await pool.query(
      `SELECT id, estudante, telefone, escola_id, data_nascimento
       FROM alunos WHERE cpf = ? AND status = 'ativo' LIMIT 1`,
      [cpf]
    );

    if (!aluno)
      return res.status(404).json({ ok: false, code: "ALUNO_NAO_ENCONTRADO", message: "CPF não encontrado." });

    if (aluno.telefone) {
      const codigo = Math.floor(100000 + Math.random() * 900000).toString();
      await pool.query(
        `INSERT INTO app_aluno_codigos (aluno_id, codigo, destino, expiracao)
         VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
        [aluno.id, codigo, aluno.telefone]
      );
      await enviarCodigoPorSms(aluno.telefone, codigo);
      return res.json({ ok: true, tem_telefone: true, telefone_mascara: maskPhone(aluno.telefone) });
    } else {
      return res.json({ ok: true, tem_telefone: false, requer_verificacao: true });
    }
  } catch (e) {
    console.error("[APP_ALUNO/SOLICITAR-CODIGO]", e);
    return res.status(500).json({ message: "Erro interno." });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /verificar-data-nascimento
// ─────────────────────────────────────────────────────────────
router.post("/verificar-data-nascimento", async (req, res) => {
  try {
    const cpf = normalizarCpf(req.body?.cpf);
    const dataNasc = String(req.body?.data_nascimento || "");
    if (!cpf || !dataNasc)
      return res.status(400).json({ message: "CPF e data_nascimento são obrigatórios." });

    const [[aluno]] = await pool.query(
      `SELECT id, data_nascimento FROM alunos WHERE cpf = ? AND status = 'ativo' LIMIT 1`,
      [cpf]
    );
    if (!aluno) return res.status(404).json({ message: "Aluno não encontrado." });

    const normalize = (d) => {
      const s = String(d).replace(/\D/g, "");
      if (s.length !== 8) return null;
      const maybeYear = parseInt(s.slice(0, 4));
      if (maybeYear > 1900 && maybeYear < 2100)
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
      return `${s.slice(4, 8)}-${s.slice(2, 4)}-${s.slice(0, 2)}`;
    };

    const dbDate = aluno.data_nascimento ? String(aluno.data_nascimento).slice(0, 10) : null;
    const inputDate = normalize(dataNasc);
    if (!dbDate || !inputDate || dbDate !== inputDate)
      return res.status(403).json({ message: "Data de nascimento incorreta." });

    const tokenTemp = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO app_aluno_codigos
       (aluno_id, codigo, destino, expiracao, token_data_nasc, token_data_nasc_exp)
       VALUES (?, '', '', DATE_ADD(NOW(), INTERVAL 1 MINUTE), ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))`,
      [aluno.id, tokenTemp]
    );
    return res.json({ ok: true, token_temp: tokenTemp });
  } catch (e) {
    console.error("[APP_ALUNO/VERIFICAR-DATA-NASCIMENTO]", e);
    return res.status(500).json({ message: "Erro interno." });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /cadastrar-telefone
// ─────────────────────────────────────────────────────────────
router.post("/cadastrar-telefone", async (req, res) => {
  try {
    const cpf = normalizarCpf(req.body?.cpf);
    const telefone = String(req.body?.telefone || "").replace(/\D/g, "");
    const tokenTemp = String(req.body?.token_temp || "");
    if (!cpf || !telefone || !tokenTemp)
      return res.status(400).json({ message: "Dados incompletos." });

    const [[aluno]] = await pool.query(
      `SELECT id FROM alunos WHERE cpf = ? AND status = 'ativo' LIMIT 1`,
      [cpf]
    );
    if (!aluno) return res.status(404).json({ message: "Aluno não encontrado." });

    const [[tokenRow]] = await pool.query(
      `SELECT id FROM app_aluno_codigos
       WHERE aluno_id = ? AND token_data_nasc = ? AND token_data_nasc_exp > NOW() LIMIT 1`,
      [aluno.id, tokenTemp]
    );
    if (!tokenRow) return res.status(403).json({ message: "Token expirado. Tente novamente." });

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query(
      `INSERT INTO app_aluno_codigos (aluno_id, codigo, destino, expiracao)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
      [aluno.id, codigo, telefone]
    );
    await enviarCodigoPorSms(telefone, codigo);
    return res.json({ ok: true, telefone_mascara: maskPhone(telefone) });
  } catch (e) {
    console.error("[APP_ALUNO/CADASTRAR-TELEFONE]", e);
    return res.status(500).json({ message: "Erro interno." });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /verificar-codigo
// ─────────────────────────────────────────────────────────────
router.post("/verificar-codigo", async (req, res) => {
  try {
    const cpf = normalizarCpf(req.body?.cpf);
    const codigo = String(req.body?.codigo || "").trim();
    if (!cpf || !codigo)
      return res.status(400).json({ message: "CPF e código são obrigatórios." });

    const [[aluno]] = await pool.query(
      `SELECT id, estudante, escola_id, telefone, cpf
       FROM alunos WHERE cpf = ? AND status = 'ativo' LIMIT 1`,
      [cpf]
    );
    if (!aluno) return res.status(404).json({ message: "Aluno não encontrado." });

    const [[otpRow]] = await pool.query(
      `SELECT id, destino FROM app_aluno_codigos
       WHERE aluno_id = ? AND codigo = ? AND usado_em IS NULL
         AND expiracao > NOW() AND destino != ''
       ORDER BY id DESC LIMIT 1`,
      [aluno.id, codigo]
    );
    if (!otpRow) return res.status(401).json({ message: "Código inválido ou expirado." });

    await pool.query(`UPDATE app_aluno_codigos SET usado_em = NOW() WHERE id = ?`, [otpRow.id]);

    if (!aluno.telefone) {
      await pool.query(`UPDATE alunos SET telefone = ? WHERE id = ?`, [otpRow.destino, aluno.id]);
    }

    const token = jwt.sign(
      { tipo: "ALUNO", aluno_id: aluno.id, cpf: aluno.cpf, escola_id: aluno.escola_id },
      APP_PAIS_JWT_SECRET,
      { expiresIn: "30d" }
    );
    return res.json({
      ok: true,
      token,
      aluno: { id: aluno.id, nome: aluno.estudante, escola_id: aluno.escola_id },
    });
  } catch (e) {
    console.error("[APP_ALUNO/VERIFICAR-CODIGO]", e);
    return res.status(500).json({ message: "Erro interno." });
  }
});

export default router;
