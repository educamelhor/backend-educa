// routes/plataforma.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const router = express.Router();

// ======================================================
// Secrets (separar plataforma do tenant é o ideal)
// - PLATFORM_JWT_SECRET: token do CEO (plataforma)
// - JWT_SECRET: já existe no seu projeto, usado no restante
// ======================================================
const PLATFORM_JWT_SECRET = process.env.PLATFORM_JWT_SECRET || process.env.JWT_SECRET;

// ======================================================
// Helpers
// ======================================================
function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function nowPlusHours(hours) {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}



// ======================================================
// ⚠️ LEGADO REMOVIDO (autenticação própria /login + token type:"platform")
// A partir de agora, o acesso à plataforma é feito via:
//   POST /api/auth-plataforma/login
//   POST /api/auth-plataforma/confirmar  -> JWT com scope:"plataforma"
// E o guard é aplicado no server.js:
//   autenticarToken + exigirEscopo("plataforma")
// ======================================================


// ======================================================
// 1.5) LISTAR ESCOLAS (CEO)
// GET /api/plataforma/escolas
// Retorna lista simples para o painel global
// ======================================================
router.get("/escolas", async (req, res) => {
  const db = req.db;

  try {
    const [rows] = await db.query(
      `
      SELECT id, nome
      FROM escolas
      ORDER BY id DESC
      LIMIT 200
      `
    );

    return res.json({ ok: true, escolas: rows || [] });
  } catch (err) {
    console.error("[PLATAFORMA][LISTAR ESCOLAS] erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar escolas." });
  }
});

// ======================================================
// 2) CRIAR ESCOLA + DIRETOR + CONVITE (CEO)
// POST /api/plataforma/escolas
// header: Authorization: Bearer <platform_token>
// body:
// {
//   escola: { nome, cnpj, cidade, uf, status },
//   diretor: { nome, email, cpf }
// }
// Retorna: { escola_id, diretor_id, convite_token }
// ======================================================
router.post("/escolas", async (req, res) => {
  const conn = req.db;
  const payload = req.body || {};
  const escola = payload.escola || {};
  const diretor = payload.diretor || {};

  if (!escola?.nome) return res.status(400).json({ ok: false, message: "Informe escola.nome" });
  if (!diretor?.nome || !diretor?.email) {
    return res.status(400).json({ ok: false, message: "Informe diretor.nome e diretor.email" });
  }

  // token “cru” (vai para o link); guardamos apenas hash no banco
  const conviteToken = crypto.randomBytes(32).toString("hex");
  const conviteHash = sha256(conviteToken);
  const expiraEm = nowPlusHours(72); // 72h (ajustável)

  try {
    // Transação
    await conn.query("START TRANSACTION");

    // 2.1) Insert escola (robusto: tenta usar colunas que existirem)
    //     (não presume o schema exato da sua tabela `escolas`)
    const [colsRows] = await conn.query(
      `SELECT COLUMN_NAME 
         FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'escolas'`
    );
    const existingCols = new Set((colsRows || []).map((r) => r.COLUMN_NAME));

    const escolaCandidate = {
      nome: escola.nome,
      apelido: escola.apelido || String(escola.nome).trim(),
      cnpj: escola.cnpj,
      cidade: escola.cidade,
      uf: escola.uf,
      status: escola.status || "EM_ONBOARDING",
      ativo: 1,
    };

    // só mantém chaves que existam na tabela `escolas`
    const escolaData = {};
    for (const [k, v] of Object.entries(escolaCandidate)) {
      if (existingCols.has(k) && v !== undefined && v !== null && String(v).trim() !== "") {
        escolaData[k] = v;
      }
    }

    // fallback mínimo
    if (!Object.keys(escolaData).length) {
      // se a tabela `escolas` não tiver nenhuma dessas colunas, falha explícita
      throw new Error("Não foi possível mapear colunas da tabela `escolas` (schema inesperado).");
    }

    const escolaCols = Object.keys(escolaData);
    const escolaVals = escolaCols.map((k) => escolaData[k]);

    const [escolaIns] = await conn.query(
      `INSERT INTO escolas (${escolaCols.map((c) => `\`${c}\``).join(", ")})
       VALUES (${escolaCols.map(() => "?").join(", ")})`,
      escolaVals
    );

    const escolaId = escolaIns.insertId;

    // 2.2) Criar usuário DIRETOR (sem senha ainda)
    const [dirIns] = await conn.query(
      `INSERT INTO escola_usuarios (escola_id, nome, email, cpf, role, status)
       VALUES (?, ?, ?, ?, 'DIRETOR', 'PENDENTE_ATIVACAO')`,
      [
        escolaId,
        String(diretor.nome).trim(),
        String(diretor.email).trim().toLowerCase(),
        diretor.cpf ? String(diretor.cpf).trim() : null,
      ]
    );

    const diretorId = dirIns.insertId;

    // 2.3) Criar convite de ativação
    await conn.query(
      `INSERT INTO escola_convites (escola_id, escola_usuario_id, token_hash, expira_em)
       VALUES (?, ?, ?, ?)`,
      [escolaId, diretorId, conviteHash, expiraEm]
    );

    await conn.query("COMMIT");

    // IMPORTANTE:
    // Aqui você enviaria o convite por e-mail (futuro).
    // Por enquanto retornamos o token (para teste via Postman).
    return res.status(201).json({
      ok: true,
      escola_id: escolaId,
      diretor_id: diretorId,
      convite_token: conviteToken,
      expira_em: expiraEm,
    });
  } catch (err) {
    try {
      await conn.query("ROLLBACK");
    } catch {}
    console.error("[PLATAFORMA][CRIAR ESCOLA] erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao criar escola/diretor.", detail: err?.message });
  }
});

// ======================================================
// 3) ATIVAR CONVITE (Diretor define senha)
// POST /api/plataforma/convites/:token/ativar
// body: { senha }
// Retorna ok e dados do diretor (sem logar automaticamente)
// ======================================================
// ======================================================
// 2.5) CRIAR DIRETOR + CONVITE para ESCOLA EXISTENTE (CEO)
// POST /api/plataforma/escolas/:escolaId/diretor
// header: Authorization: Bearer <platform_token>
// body: { nome, email, cpf }
// ======================================================

// ======================================================
// 2.5) CRIAR DIRETOR (USUÁRIOS) + CONVITE (CEO)
// POST /api/plataforma/escolas/:escolaId/diretor
// ======================================================
router.post("/escolas/:escolaId/diretor", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const { nome, email, cpf } = req.body || {};

  const cpfLimpo = String(cpf || "").replace(/\D/g, "");
  const emailNorm = email ? String(email).trim().toLowerCase() : null;

  if (!escolaId || Number.isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: "escolaId inválido." });
  }
  if (!nome || !cpfLimpo || cpfLimpo.length !== 11) {
    return res.status(400).json({ ok: false, message: "Informe nome e CPF válido (11 dígitos)." });
  }

  const conviteToken = crypto.randomBytes(32).toString("hex");
  const conviteHash = sha256(conviteToken);
  const expiraEm = nowPlusHours(72);

  try {
    await db.query("START TRANSACTION");

    // garante que a escola existe
    const [escolaRows] = await db.query(
      "SELECT id FROM escolas WHERE id = ? LIMIT 1",
      [escolaId]
    );
    if (!escolaRows.length) {
      await db.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Escola não encontrada." });
    }

    // cria usuário DIRETOR (senha provisória)
    const senhaProvisoriaHash = await bcrypt.hash(crypto.randomUUID(), 10);

    const [userIns] = await db.query(
      `
      INSERT INTO usuarios (cpf, nome, email, senha_hash, ativo, perfil, escola_id)
      VALUES (?, ?, ?, ?, 1, 'diretor', ?)
      `,
      [
        cpfLimpo,
        String(nome).trim(),
        emailNorm,
        senhaProvisoriaHash,
        escolaId,
      ]
    );

    const usuarioId = userIns.insertId;

    // cria convite
    await db.query(
      `
      INSERT INTO usuarios_convites (usuario_id, token_hash, expira_em)
      VALUES (?, ?, ?)
      `,
      [usuarioId, conviteHash, expiraEm]
    );

    await db.query("COMMIT");

    return res.status(201).json({
      ok: true,
      usuario_id: usuarioId,
      escola_id: escolaId,
      convite_token: conviteToken,
      expira_em: expiraEm,
    });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {}
    console.error("[PLATAFORMA][CRIAR DIRETOR]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao criar diretor.",
      detail: err.message,
    });
  }
});


// ======================================================
// 3) ATIVAR CONVITE (Diretor define senha)
// POST /api/plataforma/convites/:token/ativar
// body: { senha }
// ======================================================
// ======================================================
// 3) ATIVAR CONVITE (USUÁRIOS)
// POST /api/plataforma/convites/:token/ativar
// ======================================================
router.post("/convites/:token/ativar", async (req, res) => {
  const db = req.db;
  const { token } = req.params;
  const { senha } = req.body || {};

  if (!senha || senha.length < 6) {
    return res.status(400).json({ ok: false, message: "Senha inválida." });
  }

  try {
    const tokenHash = sha256(token);

    const [rows] = await db.query(
      `
      SELECT c.id AS convite_id, c.usuario_id, c.expira_em, c.usado_em
      FROM usuarios_convites c
      WHERE c.token_hash = ?
      LIMIT 1
      `,
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, message: "Convite inválido." });
    }

    const convite = rows[0];

    if (convite.usado_em) {
      return res.status(409).json({ ok: false, message: "Convite já utilizado." });
    }

    if (new Date(convite.expira_em) < new Date()) {
      return res.status(410).json({ ok: false, message: "Convite expirado." });
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    await db.query("START TRANSACTION");

    await db.query(
      `
      UPDATE usuarios
      SET senha_hash = ?, ativo = 1
      WHERE id = ?
      `,
      [senhaHash, convite.usuario_id]
    );

    await db.query(
      `
      UPDATE usuarios_convites
      SET usado_em = NOW()
      WHERE id = ?
      `,
      [convite.convite_id]
    );

    await db.query("COMMIT");

    return res.json({
      ok: true,
      message: "Usuário ativado com sucesso. Já pode realizar login.",
    });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {}
    console.error("[PLATAFORMA][ATIVAR CONVITE]", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao ativar convite.",
      detail: err.message,
    });
  }
});


export default router;
