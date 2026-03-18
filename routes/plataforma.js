// routes/plataforma.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { randomInt } from "crypto";

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

// Helper: enviar OTP por e-mail
async function enviarCodigoEmail(email, codigo) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.error("[PLATAFORMA] SMTP não configurado — OTP não enviado.");
    throw new Error("SMTP_NAO_CONFIGURADO");
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT),
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"Educa.Melhor" <${SMTP_USER}>`,
    to: email,
    subject: "Código de Verificação — Educa.Melhor",
    text: `Seu código de verificação é: ${codigo}\n\nEste código expira em 5 minutos.`,
    html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px">
      <h2 style="color:#1e40af;margin-bottom:8px">Educa.Melhor</h2>
      <p style="color:#475569">Seu código de verificação é:</p>
      <div style="font-size:32px;font-weight:900;letter-spacing:6px;color:#0f172a;text-align:center;padding:16px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;margin:12px 0">${codigo}</div>
      <p style="color:#94a3b8;font-size:12px">Este código expira em 5 minutos.</p>
    </div>`,
  });
}


// ======================================================
// ⚠️ LEGADO REMOVIDO (autenticação própria /login + token type:"platform")
// A partir de agora, o acesso à plataforma é feito via:
//   POST /api/auth-plataforma/login
//   POST /api/auth-plataforma/confirmar  -> JWT com scope:"plataforma"
// E o guard é aplicado no server.js:
//   autenticarToken + exigirEscopo("plataforma")
// ======================================================
// 1.5) LISTAR ESCOLAS (CEO)
// GET /api/plataforma/escolas
// Retorna lista completa para o painel global
// ======================================================
router.get("/escolas", async (req, res) => {
  const db = req.db;

  try {
    const [rows] = await db.query(
      `
      SELECT
        e.id,
        e.nome,
        e.apelido,
        e.cnpj,
        e.endereco,
        e.cidade,
        e.estado,
        e.tipo,
        e.origem,
        e.status,
        e.telefone,
        e.created_at,
        (SELECT dir.nome FROM usuarios dir
         WHERE dir.escola_id = e.id AND dir.perfil = 'diretor' AND dir.ativo = 1
         LIMIT 1) AS diretor,
        (SELECT cmd.nome FROM usuarios cmd
         WHERE cmd.escola_id = e.id AND cmd.perfil = 'militar' AND cmd.ativo = 1
         LIMIT 1) AS comandante
      FROM escolas e
      ORDER BY e.id DESC
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
// 2) CRIAR ESCOLA (CEO)
// POST /api/plataforma/escolas
// body: { nome, apelido, cidade, estado, tipo, origem, cnpj }
// tipo: JSON array  ex: ["Anos Finais", "CCMDF"]
// origem: "publica" | "particular"
// Retorna: { ok, escola_id }
// Nota: Diretor é vinculado separadamente via
//       POST /api/plataforma/escolas/:escolaId/diretor
// ======================================================
router.post("/escolas", async (req, res) => {
  const db = req.db;
  const body = req.body || {};

  const nome = String(body.nome || "").trim();
  if (!nome) {
    return res.status(400).json({ ok: false, message: "Nome da escola é obrigatório." });
  }

  const apelido  = String(body.apelido || nome).trim();
  const cnpj     = body.cnpj ? String(body.cnpj).trim() : null;
  const cidade   = body.cidade ? String(body.cidade).trim() : null;
  const estado   = body.estado ? String(body.estado).trim().toUpperCase().slice(0, 2) : null;
  const endereco = body.endereco ? String(body.endereco).trim() : null;
  const origem   = body.origem ? String(body.origem).trim().toLowerCase() : null;

  // tipo: array de strings → salva como JSON
  let tipoJson = null;
  if (Array.isArray(body.tipo) && body.tipo.length > 0) {
    tipoJson = JSON.stringify(body.tipo.map((t) => String(t).trim()).filter(Boolean));
  }

  try {
    const [result] = await db.query(
      `
      INSERT INTO escolas (nome, apelido, cnpj, endereco, cidade, estado, tipo, origem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [nome, apelido, cnpj, endereco, cidade, estado, tipoJson, origem]
    );

    return res.status(201).json({
      ok: true,
      escola_id: result.insertId,
      message: "Escola criada com sucesso.",
    });
  } catch (err) {
    console.error("[PLATAFORMA][CRIAR ESCOLA] erro:", err);

    // Verifica duplicidade de CNPJ
    if (err?.code === "ER_DUP_ENTRY" && String(err?.message || "").includes("cnpj")) {
      return res.status(409).json({ ok: false, message: "Já existe uma escola com este CNPJ." });
    }

    return res.status(500).json({ ok: false, message: "Erro ao criar escola.", detail: err?.message });
  }
});

// ======================================================
// 2.1) EDITAR ESCOLA (CEO)
// PUT /api/plataforma/escolas/:id
// body: { nome, apelido, cidade, estado, tipo, origem, cnpj }
// ======================================================
router.put("/escolas/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const body = req.body || {};

  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ ok: false, message: "ID inválido." });
  }

  try {
    // Verifica se existe
    const [exists] = await db.query("SELECT id FROM escolas WHERE id = ? LIMIT 1", [id]);
    if (!exists.length) {
      return res.status(404).json({ ok: false, message: "Escola não encontrada." });
    }

    const sets = [];
    const vals = [];

    if (body.nome !== undefined) {
      const nome = String(body.nome).trim();
      if (!nome) return res.status(400).json({ ok: false, message: "Nome não pode ser vazio." });
      sets.push("nome = ?"); vals.push(nome);
    }
    if (body.apelido !== undefined) { sets.push("apelido = ?"); vals.push(String(body.apelido).trim() || null); }
    if (body.endereco !== undefined) { sets.push("endereco = ?"); vals.push(body.endereco ? String(body.endereco).trim() : null); }
    if (body.cidade !== undefined)  { sets.push("cidade = ?");  vals.push(body.cidade ? String(body.cidade).trim() : null); }
    if (body.estado !== undefined)  { sets.push("estado = ?");  vals.push(body.estado ? String(body.estado).trim().toUpperCase().slice(0,2) : null); }
    if (body.cnpj !== undefined)    { sets.push("cnpj = ?");    vals.push(body.cnpj ? String(body.cnpj).trim() : null); }
    if (body.origem !== undefined)  { sets.push("origem = ?");  vals.push(body.origem ? String(body.origem).trim().toLowerCase() : null); }
    if (body.tipo !== undefined) {
      let tipoJson = null;
      if (Array.isArray(body.tipo) && body.tipo.length > 0) {
        tipoJson = JSON.stringify(body.tipo.map(t => String(t).trim()).filter(Boolean));
      }
      sets.push("tipo = ?"); vals.push(tipoJson);
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, message: "Nenhum campo para atualizar." });
    }

    vals.push(id);
    await db.query(`UPDATE escolas SET ${sets.join(", ")} WHERE id = ?`, vals);

    return res.json({ ok: true, message: "Escola atualizada com sucesso." });
  } catch (err) {
    console.error("[PLATAFORMA][EDITAR ESCOLA] erro:", err);
    if (err?.code === "ER_DUP_ENTRY" && String(err?.message || "").includes("cnpj")) {
      return res.status(409).json({ ok: false, message: "Já existe uma escola com este CNPJ." });
    }
    return res.status(500).json({ ok: false, message: "Erro ao editar escola.", detail: err?.message });
  }
});

// ======================================================
// 2.2) ALTERAR STATUS DA ESCOLA (CEO)
// PATCH /api/plataforma/escolas/:id/status
// body: { status: "ativa" | "bloqueada" | "cancelada" }
// ======================================================
router.patch("/escolas/:id/status", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const novoStatus = String(req.body?.status || "").trim().toLowerCase();

  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ ok: false, message: "ID inválido." });
  }

  const statusValidos = ["ativa", "bloqueada", "cancelada"];
  if (!statusValidos.includes(novoStatus)) {
    return res.status(400).json({ ok: false, message: `Status inválido. Use: ${statusValidos.join(", ")}` });
  }

  try {
    const [rows] = await db.query("SELECT id, status FROM escolas WHERE id = ? LIMIT 1", [id]);
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: "Escola não encontrada." });
    }

    const atual = rows[0].status;

    if (atual === novoStatus) {
      return res.json({ ok: true, message: `A escola já está com status '${novoStatus}'.` });
    }

    // Cancelada não pode ser reativada
    if (atual === "cancelada") {
      return res.status(400).json({ ok: false, message: "Escola cancelada não pode ser reativada. Crie uma nova escola." });
    }

    // Para cancelar, nenhum diretor pode estar vinculado (ativo)
    if (novoStatus === "cancelada") {
      const [diretores] = await db.query(
        `SELECT id, nome, perfil FROM usuarios
         WHERE escola_id = ? AND perfil IN ('diretor','militar') AND ativo = 1`,
        [id]
      );
      if (diretores.length > 0) {
        const nomes = diretores.map(d => d.nome).join(", ");
        return res.status(409).json({
          ok: false,
          message: `Não é possível cancelar esta escola. Ainda há ${diretores.length} diretor(es) vinculado(s): ${nomes}. Cancele ou desvincule os diretores primeiro (menu Diretores).`,
        });
      }
    }

    await db.query("UPDATE escolas SET status = ? WHERE id = ?", [novoStatus, id]);

    return res.json({ ok: true, message: `Status alterado para '${novoStatus}'.` });
  } catch (err) {
    console.error("[PLATAFORMA][STATUS ESCOLA] erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao alterar status.", detail: err?.message });
  }
});

// ======================================================
// 2.5) CRIAR DIRETOR(ES) + CONVITE (CEO)
// POST /api/plataforma/escolas/:escolaId/diretor
//
// body: { nome, cpf, email, papel }
//   papel: "diretor" (padrão, escola normal)
//          "diretor_pedagogico" (CCMDF)
//          "diretor_disciplinar" (CCMDF — Comandante)
//
// Regras:
//   • Escola normal → aceita 1 diretor com papel "diretor"
//   • Escola CCMDF  → aceita 2 diretores:
//       "diretor_pedagogico" + "diretor_disciplinar"
// ======================================================
router.post("/escolas/:escolaId/diretor", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const { nome, email, cpf, papel } = req.body || {};

  const cpfLimpo = String(cpf || "").replace(/\D/g, "");
  const emailNorm = email ? String(email).trim().toLowerCase() : null;

  if (!escolaId || Number.isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: "escolaId inválido." });
  }
  if (!nome || !cpfLimpo || cpfLimpo.length !== 11) {
    return res.status(400).json({ ok: false, message: "Informe nome e CPF válido (11 dígitos)." });
  }

  // papel padrão = "diretor"
  const papelNorm = String(papel || "diretor").trim().toLowerCase();
  const papeisValidos = ["diretor", "diretor_pedagogico", "diretor_disciplinar"];
  if (!papeisValidos.includes(papelNorm)) {
    return res
      .status(400)
      .json({ ok: false, message: `Papel inválido. Use: ${papeisValidos.join(", ")}` });
  }

  try {
    // 1) Busca dados da escola (incluindo tipo)
    const [escolaRows] = await db.query(
      "SELECT id, nome, tipo FROM escolas WHERE id = ? LIMIT 1",
      [escolaId]
    );
    if (!escolaRows.length) {
      return res.status(404).json({ ok: false, message: "Escola não encontrada." });
    }

    const escola = escolaRows[0];

    // Detecta se a escola é CCMDF
    let tiposArr = [];
    if (escola.tipo) {
      try {
        tiposArr = typeof escola.tipo === "string" ? JSON.parse(escola.tipo) : escola.tipo;
      } catch {
        tiposArr = [];
      }
    }
    const isCCMDF = Array.isArray(tiposArr) && tiposArr.includes("CCMDF");

    // 2) Validação do papel vs tipo de escola
    if (!isCCMDF) {
      // Escola normal → só aceita "diretor"
      if (papelNorm !== "diretor") {
        return res.status(400).json({
          ok: false,
          message:
            "Esta escola não é CCMDF. Use papel = 'diretor' para escolas normais.",
        });
      }

      // Verifica se já tem diretor
      const [existentes] = await db.query(
        `SELECT id, nome FROM usuarios
         WHERE escola_id = ? AND perfil = 'diretor' AND ativo = 1
         LIMIT 1`,
        [escolaId]
      );
      if (existentes.length) {
        return res.status(409).json({
          ok: false,
          message: `Esta escola já possui um diretor vinculado: ${existentes[0].nome}.`,
        });
      }
    } else {
      // Escola CCMDF → aceita "diretor_pedagogico" ou "diretor_disciplinar"
      if (papelNorm === "diretor") {
        return res.status(400).json({
          ok: false,
          message:
            "Escola CCMDF exige papel específico: 'diretor_pedagogico' ou 'diretor_disciplinar'.",
        });
      }

      // Perfil no banco: diretor_pedagogico → 'diretor', diretor_disciplinar → 'militar'
      const perfilBanco = papelNorm === "diretor_pedagogico" ? "diretor" : "militar";

      // Verifica se já existe alguém nesse papel
      const [existentes] = await db.query(
        `SELECT id, nome FROM usuarios
         WHERE escola_id = ? AND perfil = ? AND ativo = 1
         LIMIT 1`,
        [escolaId, perfilBanco]
      );
      if (existentes.length) {
        const label = papelNorm === "diretor_pedagogico" ? "Diretor Pedagógico" : "Diretor Disciplinar (Comandante)";
        return res.status(409).json({
          ok: false,
          message: `Já existe ${label} nesta escola: ${existentes[0].nome}.`,
        });
      }
    }

    // 3) Cria o usuário + convite
    const conviteToken = crypto.randomBytes(32).toString("hex");
    const conviteHash = sha256(conviteToken);
    const expiraEm = nowPlusHours(72);
    const senhaProvisoriaHash = await bcrypt.hash(crypto.randomUUID(), 10);

    // Determina o perfil a salvar no banco
    let perfilSalvo = "diretor";
    if (papelNorm === "diretor_disciplinar") {
      perfilSalvo = "militar"; // Re-usa enum existente para Comandante
    }

    await db.query("START TRANSACTION");

    const [userIns] = await db.query(
      `
      INSERT INTO usuarios (cpf, nome, email, senha_hash, ativo, perfil, escola_id)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      `,
      [
        cpfLimpo,
        String(nome).trim().toUpperCase(),
        emailNorm,
        senhaProvisoriaHash,
        perfilSalvo,
        escolaId,
      ]
    );

    const usuarioId = userIns.insertId;

    await db.query(
      `
      INSERT INTO usuarios_convites (usuario_id, token_hash, expira_em)
      VALUES (?, ?, ?)
      `,
      [usuarioId, conviteHash, expiraEm]
    );

    await db.query("COMMIT");

    const labelPapel =
      papelNorm === "diretor_pedagogico"
        ? "Diretor Pedagógico"
        : papelNorm === "diretor_disciplinar"
        ? "Diretor Disciplinar (Comandante)"
        : "Diretor";

    return res.status(201).json({
      ok: true,
      usuario_id: usuarioId,
      escola_id: escolaId,
      papel: papelNorm,
      papel_label: labelPapel,
      convite_token: conviteToken,
      expira_em: expiraEm,
    });
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {}
    console.error("[PLATAFORMA][CRIAR DIRETOR]", err);

    if (err?.code === "ER_DUP_ENTRY") {
      if (String(err.message).includes("cpf")) {
        return res.status(409).json({ ok: false, message: "CPF já cadastrado no sistema." });
      }
      if (String(err.message).includes("email")) {
        return res.status(409).json({ ok: false, message: "E-mail já cadastrado no sistema." });
      }
    }

    return res.status(500).json({
      ok: false,
      message: "Erro ao criar diretor.",
      detail: err.message,
    });
  }
});

// ======================================================
// 2.6) LISTAR DIRETORES (CEO)
// GET /api/plataforma/diretores
// Retorna todos os diretores (perfil in ('diretor','militar'))
// ======================================================
router.get("/diretores", async (req, res) => {
  const db = req.db;
  try {
    const [rows] = await db.query(`
      SELECT
        u.id,
        u.nome,
        u.cpf,
        u.email,
        u.ativo,
        u.perfil,
        u.escola_id,
        e.nome  AS escola_nome,
        e.cidade,
        e.estado,
        e.tipo  AS escola_tipo,
        CASE
          WHEN u.perfil = 'militar' THEN 'diretor_disciplinar'
          WHEN u.perfil = 'diretor' AND e.tipo LIKE '%CCMDF%' THEN 'diretor_pedagogico'
          ELSE 'diretor'
        END AS papel,
        c.usado_em   AS convite_usado_em,
        c.expira_em  AS convite_expira_em
      FROM usuarios u
      LEFT JOIN escolas e ON e.id = u.escola_id
      LEFT JOIN (
        SELECT uc.usuario_id, uc.usado_em, uc.expira_em
        FROM usuarios_convites uc
        INNER JOIN (
          SELECT usuario_id, MAX(id) AS max_id
          FROM usuarios_convites
          GROUP BY usuario_id
        ) latest ON uc.id = latest.max_id
      ) c ON c.usuario_id = u.id
      WHERE u.perfil IN ('diretor', 'militar')
      ORDER BY COALESCE(u.escola_id, 999999) DESC, u.perfil ASC
      LIMIT 500
    `);
    return res.json({ ok: true, diretores: rows });
  } catch (err) {
    console.error("[PLATAFORMA][LISTAR DIRETORES] erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar diretores." });
  }
});

// ======================================================
// 2.6.1) REGENERAR CÓDIGO DE ACESSO (CEO)
// POST /api/plataforma/diretores/:id/regenerar-codigo
// Gera um novo token de convite (72h), invalida anteriores
// ======================================================
router.post("/diretores/:id/regenerar-codigo", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);

  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ ok: false, message: "ID inválido." });
  }

  try {
    // Verifica se é diretor
    const [uRows] = await db.query(
      "SELECT id, nome, perfil, ativo FROM usuarios WHERE id = ? AND perfil IN ('diretor','militar') LIMIT 1",
      [id]
    );
    if (!uRows.length) {
      return res.status(404).json({ ok: false, message: "Diretor não encontrado." });
    }

    // Verifica se já ativou (existe convite com usado_em preenchido)
    const [convUsado] = await db.query(
      "SELECT id FROM usuarios_convites WHERE usuario_id = ? AND usado_em IS NOT NULL LIMIT 1",
      [id]
    );
    if (convUsado.length) {
      return res.status(409).json({
        ok: false,
        message: "Este diretor já finalizou o cadastro. Não é possível gerar novo código.",
      });
    }

    // Invalida convites antigos não-usados (marca como expirado)
    await db.query(
      "UPDATE usuarios_convites SET expira_em = NOW() WHERE usuario_id = ? AND usado_em IS NULL AND expira_em > NOW()",
      [id]
    );

    // Gera novo convite
    const conviteToken = crypto.randomBytes(32).toString("hex");
    const conviteHash = sha256(conviteToken);
    const expiraEm = nowPlusHours(72);

    await db.query(
      "INSERT INTO usuarios_convites (usuario_id, token_hash, expira_em) VALUES (?, ?, ?)",
      [id, conviteHash, expiraEm]
    );

    return res.status(201).json({
      ok: true,
      message: "Novo código de acesso gerado com sucesso.",
      convite_token: conviteToken,
      expira_em: expiraEm,
      diretor_nome: uRows[0].nome,
    });
  } catch (err) {
    console.error("[PLATAFORMA][REGENERAR CÓDIGO] erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao regenerar código.", detail: err?.message });
  }
});

// ======================================================
// 2.7) EDITAR DIRETOR (CEO)
// PUT /api/plataforma/diretores/:id
// body: { nome, email }
// ======================================================
router.put("/diretores/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const body = req.body || {};

  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ ok: false, message: "ID inválido." });
  }

  try {
    const [exists] = await db.query(
      "SELECT id, perfil FROM usuarios WHERE id = ? AND perfil IN ('diretor','militar') LIMIT 1",
      [id]
    );
    if (!exists.length) {
      return res.status(404).json({ ok: false, message: "Diretor não encontrado." });
    }

    const sets = [];
    const vals = [];

    if (body.nome !== undefined) {
      const nome = String(body.nome).trim();
      if (!nome) return res.status(400).json({ ok: false, message: "Nome não pode ser vazio." });
      sets.push("nome = ?"); vals.push(nome.toUpperCase());
    }
    if (body.email !== undefined) {
      sets.push("email = ?");
      vals.push(body.email ? String(body.email).trim().toLowerCase() : null);
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, message: "Nenhum campo para atualizar." });
    }

    vals.push(id);
    await db.query(`UPDATE usuarios SET ${sets.join(", ")} WHERE id = ?`, vals);

    return res.json({ ok: true, message: "Diretor atualizado com sucesso." });
  } catch (err) {
    console.error("[PLATAFORMA][EDITAR DIRETOR] erro:", err);
    if (err?.code === "ER_DUP_ENTRY" && String(err.message).includes("email")) {
      return res.status(409).json({ ok: false, message: "E-mail já cadastrado." });
    }
    return res.status(500).json({ ok: false, message: "Erro ao editar diretor.", detail: err?.message });
  }
});

// ======================================================
// 2.8) ALTERAR STATUS DO DIRETOR (CEO)
// PATCH /api/plataforma/diretores/:id/status
// body: { status: "ativo" | "bloqueado" | "cancelado" }
//   ativo     → ativo = 1
//   bloqueado → ativo = 0 (pode reativar)
//   cancelado → ativo = 0 + desvincula (escola_id = NULL)
// ======================================================
router.patch("/diretores/:id/status", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const novoStatus = String(req.body?.status || "").trim().toLowerCase();

  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ ok: false, message: "ID inválido." });
  }

  const statusValidos = ["ativo", "bloqueado", "cancelado"];
  if (!statusValidos.includes(novoStatus)) {
    return res.status(400).json({ ok: false, message: `Status inválido. Use: ${statusValidos.join(", ")}` });
  }

  try {
    const [rows] = await db.query(
      "SELECT id, ativo, perfil, escola_id FROM usuarios WHERE id = ? AND perfil IN ('diretor','militar') LIMIT 1",
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: "Diretor não encontrado." });
    }

    if (novoStatus === "ativo") {
      await db.query("UPDATE usuarios SET ativo = 1 WHERE id = ?", [id]);
      return res.json({ ok: true, message: "Diretor reativado." });
    }

    if (novoStatus === "bloqueado") {
      await db.query("UPDATE usuarios SET ativo = 0 WHERE id = ?", [id]);
      return res.json({ ok: true, message: "Diretor bloqueado." });
    }

    if (novoStatus === "cancelado") {
      // Desativa o diretor (escola_id é NOT NULL, mantém vínculo mas inativo)
      await db.query("UPDATE usuarios SET ativo = 0 WHERE id = ?", [id]);
      return res.json({ ok: true, message: "Diretor cancelado com sucesso." });
    }
  } catch (err) {
    console.error("[PLATAFORMA][STATUS DIRETOR] erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao alterar status.", detail: err?.message });
  }
});

// ======================================================
// 2.9) EXCLUIR DIRETOR (CEO)
// DELETE /api/plataforma/diretores/:id
// Só permite excluir diretores inativos (ativo = 0)
// Remove: otp_codes, usuarios_convites, usuarios
// ======================================================
router.delete("/diretores/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);

  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ ok: false, message: "ID inválido." });
  }

  try {
    // 1) Verifica se existe e é diretor/militar
    const [rows] = await db.query(
      "SELECT id, nome, ativo, perfil, escola_id FROM usuarios WHERE id = ? AND perfil IN ('diretor','militar') LIMIT 1",
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: "Diretor não encontrado." });
    }

    const diretor = rows[0];

    // 2) Só permite excluir se inativo
    if (Number(diretor.ativo) === 1) {
      return res.status(409).json({
        ok: false,
        message: "Não é possível excluir um diretor ativo. Desative-o primeiro.",
      });
    }

    // 3) Exclusão em transação
    await db.query("START TRANSACTION");

    // Remove OTPs
    await db.query("DELETE FROM otp_codes WHERE usuario_id = ?", [id]);

    // Remove convites
    await db.query("DELETE FROM usuarios_convites WHERE usuario_id = ?", [id]);

    // Remove o usuário
    await db.query("DELETE FROM usuarios WHERE id = ?", [id]);

    await db.query("COMMIT");

    return res.json({
      ok: true,
      message: `Diretor "${diretor.nome}" excluído permanentemente.`,
    });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("[PLATAFORMA][EXCLUIR DIRETOR] erro:", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao excluir diretor.",
      detail: err?.message,
    });
  }
});

// ======================================================
// 3.1) VALIDAR CONVITE (público, sem auth)
// POST /api/plataforma/convites/:token/validar
// Retorna dados do diretor para exibir na tela
// ======================================================
router.post("/convites/:token/validar", async (req, res) => {
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

    if (!rows.length) return res.status(404).json({ ok: false, message: "Convite inválido." });
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
    console.error("[PLATAFORMA][VALIDAR CONVITE]", err);
    return res.status(500).json({ ok: false, message: "Erro ao validar convite." });
  }
});

// ======================================================
// 3.2) ENVIAR CÓDIGO OTP PARA E-MAIL (público)
// POST /api/plataforma/convites/:token/enviar-codigo
// body: { email } (pode ser diferente do cadastrado pelo CEO)
// ======================================================
router.post("/convites/:token/enviar-codigo", async (req, res) => {
  const db = req.db;
  const tokenHash = sha256(req.params.token);
  const emailInformado = String(req.body?.email || "").trim().toLowerCase();

  if (!emailInformado || !emailInformado.includes("@")) {
    return res.status(400).json({ ok: false, message: "E-mail inválido." });
  }

  try {
    // Valida convite
    const [rows] = await db.query(
      "SELECT id, usuario_id, usado_em, expira_em FROM usuarios_convites WHERE token_hash = ? LIMIT 1",
      [tokenHash]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "Convite inválido." });
    const c = rows[0];
    if (c.usado_em) return res.status(409).json({ ok: false, message: "Convite já utilizado." });
    if (new Date(c.expira_em) < new Date()) return res.status(410).json({ ok: false, message: "Convite expirado." });

    // Gera OTP
    const codigo = String(randomInt(100000, 999999));

    // Limpa OTPs anteriores para este usuário
    await db.query("DELETE FROM otp_codes WHERE usuario_id = ?", [c.usuario_id]);

    // Insere novo OTP
    await db.query(
      "INSERT INTO otp_codes (usuario_id, email, codigo, expira_em) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [c.usuario_id, emailInformado, codigo]
    );

    // Envia e-mail
    try {
      await enviarCodigoEmail(emailInformado, codigo);
    } catch (smtpErr) {
      console.error("[PLATAFORMA][ENVIAR OTP] SMTP falhou:", smtpErr.message);
      // Em dev, retorna o código para facilitar testes
      if (process.env.NODE_ENV === "development") {
        return res.json({ ok: true, message: `Código enviado (dev): ${codigo}`, _dev_codigo: codigo });
      }
      return res.status(500).json({ ok: false, message: "Erro ao enviar e-mail. Verifique o endereço." });
    }

    return res.json({ ok: true, message: "Código de verificação enviado para o e-mail informado." });
  } catch (err) {
    console.error("[PLATAFORMA][ENVIAR CÓDIGO]", err);
    return res.status(500).json({ ok: false, message: "Erro ao enviar código." });
  }
});

// ======================================================
// 3.3) ATIVAR CONVITE COM OTP (público)
// POST /api/plataforma/convites/:token/ativar
// body: { codigo, email, senha }
// ======================================================
router.post("/convites/:token/ativar", async (req, res) => {
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

    // 3) Ativa conta
    const senhaHash = await bcrypt.hash(senha, 10);

    await db.query("START TRANSACTION");

    // Atualiza senha, email verificado e ativa
    await db.query(
      "UPDATE usuarios SET senha_hash = ?, email = ?, ativo = 1 WHERE id = ?",
      [senhaHash, email.trim().toLowerCase(), convite.usuario_id]
    );

    // Marca convite como usado
    await db.query("UPDATE usuarios_convites SET usado_em = NOW() WHERE id = ?", [convite.convite_id]);

    // Limpa OTPs
    await db.query("DELETE FROM otp_codes WHERE usuario_id = ?", [convite.usuario_id]);

    await db.query("COMMIT");

    return res.json({ ok: true, message: "Conta ativada com sucesso! Faça login com seu e-mail e senha." });
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("[PLATAFORMA][ATIVAR CONVITE]", err);
    return res.status(500).json({ ok: false, message: "Erro ao ativar convite.", detail: err.message });
  }
});


export default router;
