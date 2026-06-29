// routes/app_pais.js â€” v4 (2026-04-24: Resend HTTP API, sem SMTP)
import express from "express";
import PDFDocument from "pdfkit";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import { getSignedGetObjectUrl } from "../storage/spacesUpload.js";

const APP_PAIS_VERSION = "v4-resend-2026-04-24";
console.log("[APP_PAIS] MÃ³dulo carregado:", APP_PAIS_VERSION);


const router = express.Router();

// ============================================================================
// CONFIG â€” JWT APP PAIS
// ============================================================================
const APP_PAIS_JWT_SECRET =
  process.env.APP_PAIS_JWT_SECRET || "DEV_ONLY__CHANGE_ME_APP_PAIS_JWT_SECRET";

const APP_PAIS_JWT_EXPIRES_IN = process.env.APP_PAIS_JWT_EXPIRES_IN || "7d"; // 7 dias
const APP_PAIS_JWT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7; // 7 dias (para o frontend)

if (!process.env.APP_PAIS_JWT_SECRET) {
  console.warn(
    "[APP_PAIS][JWT] APP_PAIS_JWT_SECRET nÃ£o definido no .env. Usando fallback DEV_ONLY__... (NÃƒO usar em produÃ§Ã£o)."
  );
}

// ------------------------- Helpers ---------------------------------

function gerarCodigo() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizarCpf(cpf) {
  if (cpf == null) return "";
  return String(cpf).replace(/\D/g, "").trim();
}

function normalizarCodigo(codigo) {
  if (codigo == null) return "";
  return String(codigo).trim();
}

function gerarTokenSessaoResponsavel(responsavel) {
  const payload = {
    tipo: "RESPONSAVEL",
    responsavel_id: responsavel.id,
    cpf: responsavel.cpf,
  };

  return jwt.sign(payload, APP_PAIS_JWT_SECRET, {
    expiresIn: APP_PAIS_JWT_EXPIRES_IN,
  });
}


function normalizarFotoAlunoParaUploadsPath(dbFoto) {
  if (!dbFoto) return null;

  const s = String(dbFoto).trim();
  if (!s) return null;

  // Se jÃ¡ vier absoluto (http/https) ou jÃ¡ vier com /uploads, respeita.
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/uploads/")) return s;

  // Se vier com barra inicial (ex.: "/CEF04_PLAN/alunos/12586.jpg"), prefixa /uploads
  if (s.startsWith("/")) return `/uploads${s}`;

  // Se vier como "CEF04_PLAN/alunos/12586.jpg" ou "alunos/12586.jpg"
  // padroniza para /uploads/<valor>
  return `/uploads/${s}`;
}

function extrairObjectKeyDeFoto(dbFoto) {
  if (!dbFoto) return null;

  const s = String(dbFoto).trim();
  if (!s) return null;

  // Caso 1: URL absoluta do Spaces (ou CDN) contendo "/uploads/..."
  const idx = s.indexOf("/uploads/");
  if (idx >= 0) {
    // remove a barra inicial para ficar "uploads/..."
    return s.slice(idx + 1);
  }

  // Caso 2: jÃ¡ vem como "/uploads/..."
  if (s.startsWith("/uploads/")) return s.slice(1);

  // Caso 3: jÃ¡ vem como "uploads/..."
  if (s.startsWith("uploads/")) return s;

  return null;
}

function authAppPais(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const parts = auth.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "Token ausente ou invÃ¡lido." });
    }

    const token = parts[1];
    const decoded = jwt.verify(token, APP_PAIS_JWT_SECRET);
    req.appPaisAuth = decoded;

    return next();
  } catch (err) {
    return res.status(401).json({ message: "Token invÃ¡lido ou expirado." });
  }
}

function authAluno(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const parts = auth.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer')
      return res.status(401).json({ message: 'Token ausente ou inválido.' });
    const decoded = jwt.verify(parts[1], APP_PAIS_JWT_SECRET);
    if (decoded.tipo !== 'ALUNO')
      return res.status(403).json({ message: 'Acesso restrito a alunos.' });
    req.alunoAuth = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Token inválido ou expirado.' });
  }
}

function maskPhone(tel) {
  const t = String(tel || '').replace(/\D/g, '');
  if (t.length < 8) return '(**) *****-????';
  return `(**) *****-${t.slice(-4)}`;
}

// ============================================================================
// PASSO 2.3.1 â€” Helpers de Credenciais (master)
// ============================================================================

async function exigirMasterNoContexto(db, responsavel_id, escola_id, aluno_id) {
  const [[master]] = await db.query(
    `
    SELECT 1
    FROM responsaveis_alunos
    WHERE responsavel_id = ?
      AND escola_id = ?
      AND aluno_id = ?
      AND ativo = 1
      AND principal = 1
      AND pode_autorizar_terceiros = 1
    LIMIT 1
    `,
    [responsavel_id, escola_id, aluno_id]
  );

  if (!master) {
    const err = new Error("Acesso negado: vocÃª nÃ£o Ã© master neste estudante.");
    err.status = 403;
    err.code = "NAO_MASTER_NO_CONTEXTO";
    throw err;
  }
}

// ============================================================================
// E-MAIL VIA RESEND API (HTTP, sem SMTP â€” funciona em qualquer cloud)
// Env vars: RESEND_API_KEY, RESEND_FROM
// Alternativa: SMTP_HOST/PORT/USER/PASS (nodemailer) â€” fallback se sem Resend
// ============================================================================
async function enviarCodigoPorEmail(email, codigo) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM = process.env.RESEND_FROM || "onboarding@resend.dev";

  const subject = "CÃ³digo de acesso - APP Pais EDUCA.MELHOR";
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#1a56db">EDUCA.MELHOR â€” APP Pais</h2>
      <p>Seu cÃ³digo de acesso Ã©:</p>
      <div style="font-size:2.5rem;font-weight:bold;letter-spacing:8px;color:#111;margin:16px 0">${codigo}</div>
      <p style="color:#555">Este cÃ³digo expira em <strong>10 minutos</strong>. NÃ£o compartilhe com ninguÃ©m.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="font-size:0.75rem;color:#aaa">EDUCA.MELHOR Sistema Educacional</p>
    </div>
  `;
  const text = `Seu cÃ³digo de acesso Ã©: ${codigo}\n\nEste cÃ³digo expira em 10 minutos.`;

  if (RESEND_API_KEY) {
    // â”â”â” PRIORIDADE: Resend HTTP API (nÃ£o usa SMTP, nunca bloqueado) â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject,
        html,
        text,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error("[APP_PAIS][RESEND] Erro:", resp.status, body);
      throw new Error(`RESEND_ERROR:${resp.status}:${body}`);
    }

    const data = await resp.json();
    console.log("[APP_PAIS][RESEND] E-mail enviado:", data?.id);
    return;
  }

  // â”â”â” FALLBACK: SMTP via nodemailer (pode ser bloqueado em alguns ambientes) â”â”â”â”â”
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.error("[APP_PAIS][EMAIL] Nenhum provedor de e-mail configurado (RESEND_API_KEY ou SMTP_HOST).");
    throw new Error("EMAIL_NAO_CONFIGURADO: defina RESEND_API_KEY no painel do DigitalOcean.");
  }

  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  const info = await transporter.sendMail({ from: `"EDUCA.MELHOR" <${SMTP_USER}>`, to: email, subject, html, text });
  console.log("[APP_PAIS][SMTP] E-mail enviado:", info.messageId);
}

// ============================================================================
// SMS VIA TWILIO
// Env vars: TWILIO_SID, TWILIO_TOKEN, TWILIO_PHONE
// ============================================================================
async function enviarCodigoPorSms(telefone, codigo) {
  const SID   = process.env.TWILIO_SID;
  const TOKEN = process.env.TWILIO_TOKEN;
  const FROM  = process.env.TWILIO_PHONE;

  if (!SID || !TOKEN || !FROM) {
    console.error("[APP_PAIS][SMS] Twilio não configurado (TWILIO_SID/TOKEN/PHONE).");
    throw new Error("SMS_NAO_CONFIGURADO");
  }

  // Normaliza para E.164 (+55DDNNNNNNNNN)
  const digitos = String(telefone || "").replace(/\D/g, "");
  const e164 = digitos.startsWith("55") ? `+${digitos}` : `+55${digitos}`;

  // ── Formato Google SMS Retriever API ─────────────────────────────────────
  // O SMS DEVE começar com "<#>" e terminar com o App Hash de 11 chars.
  // Sem o hash → SMS é entregue normalmente, mas o auto-read Android não dispara.
  // Hash obtido em: console.log do app (LoginCodigoScreen) no primeiro build Android.
  // Configurar via: SMS_APP_HASH no painel do DigitalOcean.
  const appHash = process.env.SMS_APP_HASH || "";     // ex: "Fjk9Rk2ABC1"
  const hashSuffix = appHash ? `\n${appHash}` : "";   // linha final do SMS

  const body = `<#> EDUCA.MELHOR\nSeu código de acesso: ${codigo}\nVálido por 10 min. Não compartilhe.${hashSuffix}`;

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: FROM, To: e164, Body: body }).toString(),
    }
  );

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("[APP_PAIS][SMS] Erro Twilio:", resp.status, data);
    throw new Error(`TWILIO_ERROR:${resp.status}:${data?.message || ""}`);
  }
  console.log("[APP_PAIS][SMS] Enviado para", e164, "| hash incluso:", !!appHash, "| SID:", data?.sid);
}


// Helper: máscara de e-mail (ex: jo***@gmail.com)
function mascaraEmail(email) {
  if (!email || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  const vis = local.slice(0, Math.min(2, local.length));
  return `${vis}***@${domain}`;
}

// Helper: máscara de telefone (ex: (61) 9****-1234)
function mascaraTelefone(tel) {
  if (!tel) return null;
  const d = String(tel).replace(/\D/g, "");
  if (d.length < 10) return null;
  return `(${d.slice(0, 2)}) 9****-${d.slice(-4)}`;
}

// ============================================================================
// STARTUP MIGRATIONS â€” executadas automaticamente no boot do servidor
// Falham silenciosamente em ambiente local sem credenciais de BD.
// ============================================================================
async function runStartupMigrations() {
  // 1. CREATE TABLE consentimentos_log (audit log jurÃ­dico imutÃ¡vel)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consentimentos_log (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      responsavel_id  INT NOT NULL,
      aluno_id        INT NOT NULL,
      escola_id       INT NOT NULL,
      responsavel_nome  VARCHAR(255) NOT NULL,
      responsavel_cpf   VARCHAR(11)  NOT NULL,
      aluno_nome        VARCHAR(255) NOT NULL,
      acao          ENUM('CONCEDER','REVOGAR') NOT NULL DEFAULT 'CONCEDER',
      canal         ENUM('FISICO','DIGITAL_APP','DIGITAL_WEB') NOT NULL,
      versao_termo  VARCHAR(20) NOT NULL DEFAULT '3.0',
      ip_address    VARCHAR(45)  NULL,
      user_agent    TEXT         NULL,
      device_id     VARCHAR(255) NULL,
      plataforma    VARCHAR(50)  NULL,
      chk_fotografia_cadastro    TINYINT(1) NOT NULL DEFAULT 0,
      chk_imagem_sistema         TINYINT(1) NOT NULL DEFAULT 0,
      chk_template_biometrico    TINYINT(1) NOT NULL DEFAULT 0,
      chk_sistemas_seguranca     TINYINT(1) NOT NULL DEFAULT 0,
      chk_app_educa_mobile       TINYINT(1) NOT NULL DEFAULT 0,
      chk_captura_educa_capture  TINYINT(1) NOT NULL DEFAULT 0,
      confirmado_por_usuario_id  INT          NULL,
      confirmado_por_nome        VARCHAR(255) NULL,
      confirmado_por_ip          VARCHAR(45)  NULL,
      criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_responsavel (responsavel_id),
      INDEX idx_aluno       (aluno_id),
      INDEX idx_escola      (escola_id),
      INDEX idx_criado_em   (criado_em)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='Audit log jurÃ­dico de consentimentos LGPD â€” IMUTÃVEL'
  `);

  // 2. Novos campos em responsaveis_alunos (cada ALTER separado para tolerar falha individual)
  const alterColumns = [
    `ALTER TABLE responsaveis_alunos ADD COLUMN consentimento_canal
       ENUM('FISICO','DIGITAL_APP','DIGITAL_WEB') NULL DEFAULT NULL
       COMMENT 'Canal pelo qual o consentimento foi obtido'
       AFTER consentimento_imagem_por`,
    `ALTER TABLE responsaveis_alunos ADD COLUMN consentimento_versao_termo
       VARCHAR(20) NULL DEFAULT NULL
       COMMENT 'VersÃ£o do termo aceito (ex: 3.0)'
       AFTER consentimento_canal`,
    `ALTER TABLE responsaveis_alunos ADD COLUMN consentimento_log_id
       BIGINT UNSIGNED NULL DEFAULT NULL
       COMMENT 'ReferÃªncia ao registro mais recente em consentimentos_log'
       AFTER consentimento_versao_termo`,
    // Audit: timestamp de quando o responsÃ¡vel abriu o documento (LGPD click-through evidence)
    `ALTER TABLE consentimentos_log ADD COLUMN termo_lido_em
       DATETIME NULL DEFAULT NULL
       COMMENT 'Timestamp de quando o responsÃ¡vel abriu o termo para leitura (audit LGPD)'
       AFTER plataforma`,
    // Termos de Uso + PolÃ­tica de Privacidade: aceite no 1Âº acesso ao app
    `ALTER TABLE responsaveis ADD COLUMN termos_aceitos_em
       DATETIME NULL DEFAULT NULL
       COMMENT 'Timestamp do aceite dos Termos de Uso e PolÃ­tica de Privacidade no EDUCA-Mobile'`,
    `ALTER TABLE responsaveis ADD COLUMN termos_versao
       VARCHAR(10) NULL DEFAULT NULL
       COMMENT 'VersÃ£o dos Termos de Uso aceita pelo responsÃ¡vel'`,
  ];

  for (const sql of alterColumns) {
    try {
      await pool.query(sql);
    } catch (e) {
      // Ignora "Duplicate column name" â€” coluna jÃ¡ existe
      if (!e.message?.includes("Duplicate column")) {
        console.warn("[APP_PAIS][MIGRATION] ALTER ignorado:", e.message);
      }
    }
  }

  // 3. Retrocompatibilidade: marca registros fÃ­sicos legados
  await pool.query(`
    UPDATE responsaveis_alunos
    SET consentimento_canal = 'FISICO', consentimento_versao_termo = '3.0'
    WHERE consentimento_imagem = 1 AND consentimento_canal IS NULL
  `);

  console.log("[APP_PAIS][MIGRATION] consentimentos_log — responsaveis_alunos atualizado");

  // 5. APP ALUNO: adiciona coluna telefone em alunos (se não existir)
  try {
    await pool.query(`ALTER TABLE alunos ADD COLUMN IF NOT EXISTS telefone VARCHAR(20) NULL AFTER cpf`);
    console.log('[APP_PAIS][MIGRATION] alunos.telefone — OK');
  } catch (e) {
    if (!e.message?.includes('Duplicate column')) {
      console.warn('[APP_PAIS][MIGRATION] alunos.telefone:', e.message);
    }
  }

  // 6. APP ALUNO: cria tabela app_aluno_codigos (se não existir)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_aluno_codigos (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      aluno_id BIGINT UNSIGNED NOT NULL,
      codigo CHAR(6) NOT NULL,
      destino VARCHAR(20) NOT NULL,
      expiracao DATETIME NOT NULL,
      usado_em DATETIME NULL,
      token_data_nasc VARCHAR(64) NULL,
      token_data_nasc_exp DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_aluno_cod (aluno_id, codigo)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('[APP_PAIS][MIGRATION] app_aluno_codigos — OK');

  // 4. DEMO-APPLE: garante que o responsavel demo existe com CPF 00000000019
  // Credencial fornecida à Apple App Store Review. O token é gerado diretamente
  // no bypass de /verificar-codigo — sem necessidade de vínculos reais no banco.
  try {
    await pool.query(
      `INSERT INTO responsaveis (nome, cpf, email, status_global)
       VALUES ('Demo Apple Review', '00000000019', 'demo@educamelhor.com.br', 'ATIVO')
       ON DUPLICATE KEY UPDATE nome = nome`
    );
    console.log('[APP_PAIS][MIGRATION] Responsavel demo DEMO-APPLE garantido (cpf=00000000019).');
  } catch (e) {
    console.warn('[APP_PAIS][MIGRATION] Erro ao garantir responsavel demo:', e.message);
  }
}

runStartupMigrations().catch(err =>
  console.warn("[APP_PAIS][MIGRATION] Erro (nÃ£o crÃ­tico):", err.message)
);


// ============================================================================
// PING
// ============================================================================
router.get("/ping", (req, res) => {
  return res.json({ ok: true, msg: "APP_PAIS router OK" });
});


// ============================================================================
// GET /me
// ============================================================================
router.get("/me", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id } = req.appPaisAuth;

    const [rows] = await db.query(
      "SELECT id, nome, cpf, email, telefone_celular, status_global FROM responsaveis WHERE id = ? LIMIT 1",
      [responsavel_id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "ResponsÃ¡vel nÃ£o encontrado." });
    }

    // Verifica se hÃ¡ algum aluno vinculado SEM consentimento
    const [[{ pendente }]] = await db.query(
      `SELECT COUNT(*) AS pendente
       FROM responsaveis_alunos
       WHERE responsavel_id = ? AND ativo = 1 AND consentimento_imagem = 0`,
      [responsavel_id]
    );

    return res.json({
      ok: true,
      responsavel: rows[0],
      termos_pendentes: !rows[0].termos_aceitos_em, // Termos de Uso + PolÃ­tica de Privacidade
      consentimento_pendente: pendente > 0,
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /me:", error);
    return res.status(500).json({ message: "Erro ao carregar sessÃ£o." });
  }
});

// ============================================================================
// POST /termos/aceitar â€” Registra aceite dos Termos de Uso + PolÃ­tica de Privacidade
// ============================================================================
router.post("/termos/aceitar", authAppPais, async (req, res) => {
  const { responsavel_id } = req.appPaisAuth;
  const VERSAO_TERMOS = "1.0";
  try {
    await pool.query(
      `UPDATE responsaveis
       SET termos_aceitos_em = NOW(), termos_versao = ?
       WHERE id = ?`,
      [VERSAO_TERMOS, responsavel_id]
    );
    console.log(`[APP_PAIS] Termos v${VERSAO_TERMOS} aceitos pelo responsavel_id=${responsavel_id}`);
    return res.json({ ok: true, versao: VERSAO_TERMOS });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /termos/aceitar:", error);
    return res.status(500).json({ message: "Erro ao registrar aceite dos termos." });
  }
});

// ============================================================================
// GET /consentimento
// Retorna status de consentimento por aluno vinculado ao responsÃ¡vel logado.
// ============================================================================
router.get("/consentimento", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id } = req.appPaisAuth;

    const [alunos] = await db.query(
      `SELECT
         ra.aluno_id,
         a.estudante                       AS aluno_nome,
         ra.consentimento_imagem           AS consentimento_imagem,
         ra.consentimento_canal            AS canal,
         ra.consentimento_imagem_em        AS em,
         ra.consentimento_versao_termo     AS versao_termo
       FROM responsaveis_alunos ra
       INNER JOIN alunos a ON a.id = ra.aluno_id
       WHERE ra.responsavel_id = ? AND ra.ativo = 1
       ORDER BY a.estudante ASC`,
      [responsavel_id]
    );

    const consentimento_pendente = alunos.some(a => !a.consentimento_imagem);

    return res.json({
      ok: true,
      consentimento_pendente,
      alunos: alunos.map(a => ({
        aluno_id:           a.aluno_id,
        nome:               a.aluno_nome,
        consentimento_imagem: !!a.consentimento_imagem,
        canal:              a.canal || null,
        em:                 a.em || null,
        versao_termo:       a.versao_termo || null,
      })),
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /consentimento:", error);
    return res.status(500).json({ message: "Erro ao carregar status de consentimento." });
  }
});

// ============================================================================
// POST /consentimento/confirmar
// Registra consentimento DIGITAL do responsÃ¡vel para um ou mais alunos.
// Faz INSERT no log imutÃ¡vel + UPDATE na flag operacional.
// NÃ£o sobrescreve consentimento fÃ­sico jÃ¡ existente.
// ============================================================================
router.post("/consentimento/confirmar", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id } = req.appPaisAuth;

    const {
      aluno_ids,
      checkboxes    = {},
      versao_termo  = "3.0",
      device_id     = null,
      plataforma    = null,
      termo_lido_em = null, // ISO timestamp de quando o responsÃ¡vel abriu o termo
    } = req.body;

    if (!Array.isArray(aluno_ids) || aluno_ids.length === 0) {
      return res.status(400).json({ ok: false, message: "aluno_ids Ã© obrigatÃ³rio." });
    }

    // Todos os 6 checkboxes obrigatÃ³rios
    const requiredBoxes = [
      "fotografia_cadastro",
      "imagem_sistema",
      "template_biometrico",
      "sistemas_seguranca",
      "app_educa_mobile",
      "captura_educa_capture",
    ];
    const faltando = requiredBoxes.filter(k => !checkboxes[k]);
    if (faltando.length > 0) {
      return res.status(400).json({
        ok: false,
        message: `Todos os 6 checkboxes sÃ£o obrigatÃ³rios. Faltando: ${faltando.join(", ")}`,
      });
    }

    // Snapshot do responsÃ¡vel
    const [[resp]] = await db.query(
      "SELECT nome, cpf FROM responsaveis WHERE id = ? LIMIT 1",
      [responsavel_id]
    );
    if (!resp) {
      return res.status(404).json({ ok: false, message: "ResponsÃ¡vel nÃ£o encontrado." });
    }

    // IP e user-agent do app
    const ipAddress    = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
    const userAgentStr = req.headers["user-agent"] || null;

    const alunoIdsNum = aluno_ids.map(Number);

    // Valida vÃ­nculo ativo + busca nomes + verifica se jÃ¡ tem consentimento
    const [vinculos] = await db.query(
      `SELECT ra.aluno_id, ra.escola_id, ra.consentimento_imagem, a.estudante AS aluno_nome
       FROM responsaveis_alunos ra
       INNER JOIN alunos a ON a.id = ra.aluno_id
       WHERE ra.responsavel_id = ?
         AND ra.aluno_id IN (${alunoIdsNum.map(() => "?").join(",")})
         AND ra.ativo = 1`,
      [responsavel_id, ...alunoIdsNum]
    );

    if (vinculos.length === 0) {
      return res.status(403).json({ ok: false, message: "Nenhum vÃ­nculo ativo encontrado." });
    }

    // Filtra apenas os que ainda nÃ£o tÃªm consentimento (nÃ£o sobrescreve canal fÃ­sico)
    const pendentes = vinculos.filter(v => !v.consentimento_imagem);

    if (pendentes.length === 0) {
      return res.json({ ok: true, message: "Consentimento jÃ¡ registrado para todos os alunos.", registrados: 0 });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const registrados = [];

      for (const vinculo of pendentes) {
        const { aluno_id: alunoId, escola_id: escolaId, aluno_nome: alunoNome } = vinculo;

        // INSERT no log imutÃ¡vel
        const [logResult] = await conn.query(
          `INSERT INTO consentimentos_log (
            responsavel_id, aluno_id, escola_id,
            responsavel_nome, responsavel_cpf, aluno_nome,
            acao, canal, versao_termo,
            ip_address, user_agent, device_id, plataforma, termo_lido_em,
            chk_fotografia_cadastro, chk_imagem_sistema, chk_template_biometrico,
            chk_sistemas_seguranca, chk_app_educa_mobile, chk_captura_educa_capture
          ) VALUES (?, ?, ?, ?, ?, ?, 'CONCEDER', 'DIGITAL_APP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            responsavel_id, alunoId, escolaId,
            resp.nome, resp.cpf || "", alunoNome,
            versao_termo,
            ipAddress, userAgentStr, device_id, plataforma,
            termo_lido_em ? new Date(termo_lido_em) : null,
            checkboxes.fotografia_cadastro   ? 1 : 0,
            checkboxes.imagem_sistema        ? 1 : 0,
            checkboxes.template_biometrico   ? 1 : 0,
            checkboxes.sistemas_seguranca    ? 1 : 0,
            checkboxes.app_educa_mobile      ? 1 : 0,
            checkboxes.captura_educa_capture ? 1 : 0,
          ]
        );

        // UPDATE flag operacional
        await conn.query(
          `UPDATE responsaveis_alunos
           SET consentimento_imagem        = 1,
               consentimento_imagem_em     = NOW(),
               consentimento_imagem_por    = NULL,
               consentimento_canal         = 'DIGITAL_APP',
               consentimento_versao_termo  = ?,
               consentimento_log_id        = ?
           WHERE responsavel_id = ? AND escola_id = ? AND aluno_id = ? AND ativo = 1`,
          [versao_termo, logResult.insertId, responsavel_id, escolaId, alunoId]
        );

        registrados.push(alunoId);
      }

      await conn.commit();

      return res.json({
        ok: true,
        message: "Consentimento digital registrado com sucesso.",
        registrados: registrados.length,
        aluno_ids: registrados,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("[APP_PAIS] Erro em /consentimento/confirmar:", error);
    return res.status(500).json({ ok: false, message: "Erro ao registrar consentimento digital." });
  }
});


// ============================================================================
// GET /consentimento/pre-login?cpf=...
// Rota pré-autenticação: carrega os alunos do responsável pelo CPF (sem token).
// Usado pela ConsentimentoScreen quando o responsável ainda não está logado.
// ============================================================================
router.get("/consentimento/pre-login", async (req, res) => {
  const db = pool;
  const cpf = normalizarCpf(req.query?.cpf);
  if (!cpf) return res.status(400).json({ ok: false, message: "CPF obrigatório." });

  try {
    const [[resp]] = await db.query(
      "SELECT id, nome, cpf FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpf]
    );
    if (!resp) return res.status(404).json({ ok: false, message: "Responsável não encontrado." });

    const [alunos] = await db.query(
      `SELECT ra.aluno_id, a.estudante AS nome, ra.consentimento_imagem
       FROM responsaveis_alunos ra
       INNER JOIN alunos a ON a.id = ra.aluno_id
       WHERE ra.responsavel_id = ? AND ra.ativo = 1
       ORDER BY a.estudante ASC`,
      [resp.id]
    );

    return res.json({
      ok: true,
      responsavel: { id: resp.id, nome: resp.nome, cpf: resp.cpf },
      alunos: alunos.map(a => ({
        aluno_id: a.aluno_id,
        nome: a.nome,
        consentimento_imagem: !!a.consentimento_imagem,
      })),
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /consentimento/pre-login GET:", error);
    return res.status(500).json({ ok: false, message: "Erro ao carregar dados." });
  }
});

// ============================================================================
// POST /consentimento/pre-login
// Rota pré-autenticação: salva consentimento usando CPF (sem token JWT).
// Idêntica ao /consentimento/confirmar, mas aceita CPF em vez de token.
// Usada quando o responsável assina o termo ANTES do primeiro login.
// ============================================================================
router.post("/consentimento/pre-login", async (req, res) => {
  const db = pool;
  const cpf = normalizarCpf(req.body?.cpf);
  if (!cpf) return res.status(400).json({ ok: false, message: "CPF obrigatório." });

  const {
    aluno_ids     = [],
    checkboxes    = {},
    versao_termo  = "3.0",
    device_id     = null,
    plataforma    = null,
    termo_lido_em = null,
  } = req.body;

  if (!Array.isArray(aluno_ids) || aluno_ids.length === 0) {
    return res.status(400).json({ ok: false, message: "aluno_ids é obrigatório." });
  }

  const requiredBoxes = [
    "fotografia_cadastro", "imagem_sistema", "template_biometrico",
    "sistemas_seguranca", "app_educa_mobile", "captura_educa_capture",
  ];
  const faltando = requiredBoxes.filter(k => !checkboxes[k]);
  if (faltando.length > 0) {
    return res.status(400).json({ ok: false, message: `Todos os 6 checkboxes são obrigatórios.` });
  }

  try {
    const [[resp]] = await db.query(
      "SELECT id, nome, cpf FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpf]
    );
    if (!resp) return res.status(404).json({ ok: false, message: "Responsável não encontrado." });

    const responsavel_id = resp.id;
    const ipAddress  = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
    const userAgent   = req.headers["user-agent"] || null;
    const alunoIdsNum = aluno_ids.map(Number);

    const [vinculos] = await db.query(
      `SELECT ra.aluno_id, ra.escola_id, ra.consentimento_imagem, a.estudante AS aluno_nome
       FROM responsaveis_alunos ra
       INNER JOIN alunos a ON a.id = ra.aluno_id
       WHERE ra.responsavel_id = ?
         AND ra.aluno_id IN (${alunoIdsNum.map(() => "?").join(",")})
         AND ra.ativo = 1`,
      [responsavel_id, ...alunoIdsNum]
    );

    if (vinculos.length === 0) {
      return res.status(403).json({ ok: false, message: "Nenhum vínculo ativo encontrado." });
    }

    const pendentes = vinculos.filter(v => !v.consentimento_imagem);
    if (pendentes.length === 0) {
      return res.json({ ok: true, message: "Consentimento já registrado.", registrados: 0 });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const registrados = [];

      for (const vinculo of pendentes) {
        const { aluno_id: alunoId, escola_id: escolaId, aluno_nome: alunoNome } = vinculo;

        const [logResult] = await conn.query(
          `INSERT INTO consentimentos_log (
            responsavel_id, aluno_id, escola_id,
            responsavel_nome, responsavel_cpf, aluno_nome,
            acao, canal, versao_termo,
            ip_address, user_agent, device_id, plataforma, termo_lido_em,
            chk_fotografia_cadastro, chk_imagem_sistema, chk_template_biometrico,
            chk_sistemas_seguranca, chk_app_educa_mobile, chk_captura_educa_capture
          ) VALUES (?, ?, ?, ?, ?, ?, 'CONCEDER', 'DIGITAL_APP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            responsavel_id, alunoId, escolaId,
            resp.nome, resp.cpf || "", alunoNome,
            versao_termo, ipAddress, userAgent, device_id, plataforma,
            termo_lido_em ? new Date(termo_lido_em) : null,
            checkboxes.fotografia_cadastro   ? 1 : 0,
            checkboxes.imagem_sistema        ? 1 : 0,
            checkboxes.template_biometrico   ? 1 : 0,
            checkboxes.sistemas_seguranca    ? 1 : 0,
            checkboxes.app_educa_mobile      ? 1 : 0,
            checkboxes.captura_educa_capture ? 1 : 0,
          ]
        );

        await conn.query(
          `UPDATE responsaveis_alunos
           SET consentimento_imagem        = 1,
               consentimento_imagem_em     = NOW(),
               consentimento_imagem_por    = NULL,
               consentimento_canal         = 'DIGITAL_APP',
               consentimento_versao_termo  = ?,
               consentimento_log_id        = ?
           WHERE responsavel_id = ? AND escola_id = ? AND aluno_id = ? AND ativo = 1`,
          [versao_termo, logResult.insertId, responsavel_id, escolaId, alunoId]
        );

        registrados.push(alunoId);
      }

      await conn.commit();
      console.log(`[APP_PAIS][PRE-LOGIN-CONSENT] CPF=${cpf} registrou consentimento para ${registrados.length} aluno(s)`);

      return res.json({
        ok: true,
        message: "Consentimento digital registrado com sucesso.",
        registrados: registrados.length,
        aluno_ids: registrados,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("[APP_PAIS] Erro em /consentimento/pre-login POST:", error);
    return res.status(500).json({ ok: false, message: "Erro ao registrar consentimento." });
  }
});


// ============================================================================
// GET /alunos (Home)
// ============================================================================
router.get("/alunos", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id } = req.appPaisAuth;

    // âœ… CONTRATO (APP PAIS)
    // "Entrada hoje" Ã© derivada de presencas_diarias (1 linha por aluno/dia/escola).
    // ConsolidaÃ§Ã£o/atualizaÃ§Ã£o Ã© responsabilidade do MÃ“DULO MONITORAMENTO.
    // O App Pais apenas reflete o registro atual no banco.
    const [rows] = await db.query(
      `
      SELECT
        ra.escola_id AS escola_id,
        e.apelido    AS escola_apelido,

        a.id AS aluno_id,
        a.estudante AS aluno_nome,
        
        t.id   AS turma_id,
        t.nome AS turma_nome,
        t.serie AS turma_serie,
        t.turno AS turma_turno,

        ra.pode_ver_boletim,
        ra.pode_ver_frequencia,
        ra.pode_ver_agenda,
        ra.pode_receber_notificacoes,
        ra.principal,

        pd.horario AS entrada_hoje
      FROM responsaveis_alunos ra
      INNER JOIN escolas e ON e.id = ra.escola_id
      INNER JOIN alunos a ON a.id = ra.aluno_id
      LEFT JOIN turmas t ON t.id = a.turma_id
      LEFT JOIN presencas_diarias pd
        ON pd.aluno_id = a.id
        AND pd.escola_id = ra.escola_id
        AND pd.data = CURDATE()
      WHERE ra.responsavel_id = ?
        AND ra.ativo = 1
      ORDER BY ra.principal DESC, a.estudante ASC
      `,
      [responsavel_id]
    );

    const alunos = rows.map((r) => ({
      id: r.aluno_id,
      nome: r.aluno_nome,

      escola: {
        id: r.escola_id,
        apelido: r.escola_apelido ?? null,
      },

      turma: {
        id: r.turma_id ?? null,
        nome: r.turma_nome ?? null,
        serie: r.turma_serie ?? null,
        turno: r.turma_turno ?? null,
      },
      permissoes: {
        boletim: !!r.pode_ver_boletim,
        frequencia: !!r.pode_ver_frequencia,
        agenda: !!r.pode_ver_agenda,
        notificacoes: !!r.pode_receber_notificacoes,
      },
      principal: !!r.principal,
      entrada_hoje: r.entrada_hoje ?? null,
    }));

    const escolasUnicas = Array.from(
      new Set(rows.map((r) => String(r.escola_id)))
    );

    const escola =
      escolasUnicas.length === 1
        ? { id: rows[0]?.escola_id ?? null, apelido: rows[0]?.escola_apelido ?? null }
        : null;


    return res.json({ ok: true, escola, alunos });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /alunos:", error);
    return res.status(500).json({ message: "Erro ao listar alunos." });
  }
});

// ============================================================================
// OPÃ‡ÃƒO B (LGPD forte) â€” GET /alunos/:id/foto-url
// - Bucket privado: App Pais pede URL assinada temporÃ¡ria
// - Valida vÃ­nculo responsaveis_alunos (ativo=1) + escola_id do vÃ­nculo
// ============================================================================
router.get("/alunos/:id/foto-url", authAppPais, async (req, res) => {
  const db = pool;

  try {
    const { responsavel_id } = req.appPaisAuth;
    const aluno_id = Number(req.params?.id);

    if (!Number.isFinite(aluno_id)) {
      return res.status(400).json({ ok: false, message: "aluno_id invÃ¡lido." });
    }

    const [[row]] = await db.query(
      `
      SELECT
        ra.escola_id AS escola_id,
        a.foto AS aluno_foto
      FROM responsaveis_alunos ra
      INNER JOIN alunos a ON a.id = ra.aluno_id
      WHERE ra.responsavel_id = ?
        AND ra.aluno_id = ?
        AND ra.ativo = 1
      LIMIT 1
      `,
      [responsavel_id, aluno_id]
    );

    if (!row) {
      return res.status(403).json({ ok: false, message: "Acesso negado a este estudante." });
    }
    const escola_id = Number(row.escola_id);
    const objectKey = extrairObjectKeyDeFoto(row.aluno_foto);

    const ttl = Number(process.env.APP_PAIS_FOTO_URL_TTL_SECONDS || 3600);
    const signed = await getSignedGetObjectUrl(objectKey, ttl);

    return res.json({
      ok: true,
      escola_id,
      aluno_id,
      objectKey: signed.objectKey,
      url_assinada: signed.url,
      expires_in: signed.expiresIn,
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /alunos/:id/foto-url:", error);
    return res.status(500).json({ ok: false, message: "Erro ao gerar URL assinada." });
  }
});


// ============================================================================
// PASSO 3.1 — GET /boletim (App Pais + App Aluno)
// - Retorna notas do aluno para o responsável OU para o próprio aluno logado
// - Valida vínculo em responsaveis_alunos (ativo=1) e permissão pode_ver_boletim
// Querystring:
//   /api/app-pais/boletim?aluno_id=2&ano=2024   (ano opcional)
// ============================================================================
function authAppPaisOuAluno(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const parts = auth.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer')
      return res.status(401).json({ message: 'Token ausente.' });
    const decoded = jwt.verify(parts[1], APP_PAIS_JWT_SECRET);
    if (decoded.tipo === 'ALUNO') req.alunoAuth = decoded;
    else req.appPaisAuth = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ message: 'Token inválido ou expirado.' });
  }
}

router.get("/boletim", authAppPaisOuAluno, async (req, res) => {
  const db = pool;

  try {
    // === FLUXO ALUNO ===
    if (req.alunoAuth) {
      const { aluno_id, escola_id } = req.alunoAuth;
      const reqAlunoId = parseInt(req.query.aluno_id);
      if (reqAlunoId && reqAlunoId !== aluno_id)
        return res.status(403).json({ message: 'Acesso negado.' });
      const ano = req.query.ano ? parseInt(req.query.ano) : null;
      let notasQuery = `SELECT n.ano, n.bimestre, d.nome AS disciplina, n.nota, n.faltas
        FROM notas n INNER JOIN disciplinas d ON d.id = n.disciplina_id
        WHERE n.escola_id = ? AND n.aluno_id = ?`;
      const params = [escola_id, aluno_id];
      if (ano) { notasQuery += ' AND n.ano = ?'; params.push(ano); }
      notasQuery += ' ORDER BY n.ano DESC, n.bimestre ASC, d.nome ASC';
      const [rows] = await db.query(notasQuery, params);
      return res.json({ ok: true, escola_id, aluno_id, rows });
    }
    // === FIM FLUXO ALUNO ===

    const { responsavel_id, cpf: cpfAuth } = req.appPaisAuth;

    const aluno_id = Number(req.query?.aluno_id);
    const ano = req.query?.ano != null ? Number(req.query.ano) : null;

    if (!Number.isFinite(aluno_id)) {
      return res.status(400).json({ message: "aluno_id é obrigatório." });
    }

    // ── DEMO-APPLE bypass ────────────────────────────────────────────────────
    if (cpfAuth === '00000000019') {
      return res.json({
        ok: true,
        aluno: 'Maria Eduarda Santos',
        turma: '7º Ano - Turma B',
        escola_id: null,
        notas: [],
        anos: [new Date().getFullYear()],
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // 1) Confirma vínculo ativo + permissão de boletim e obtém escola_id do vínculo
    const [[vinculo]] = await db.query(
      `
      SELECT escola_id, pode_ver_boletim
      FROM responsaveis_alunos
      WHERE responsavel_id = ?
        AND aluno_id = ?
        AND ativo = 1
      LIMIT 1
      `,
      [responsavel_id, aluno_id]
    );

    if (!vinculo) {
      return res.status(403).json({ message: "Acesso negado a este estudante." });
    }

    if (!vinculo.pode_ver_boletim) {
      return res.status(403).json({ message: "Sem permissão para ver boletim." });
    }

    const escola_id = Number(vinculo.escola_id);

    // 2) Busca notas (join com disciplinas para devolver nome)
    // Observação: a tabela notas no seu BD tem: escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas...
    const params = [escola_id, aluno_id];
    let sql = `
      SELECT
        n.ano,
        n.bimestre,
        d.nome AS disciplina,
        n.nota,
        n.faltas
      FROM notas n
      INNER JOIN disciplinas d ON d.id = n.disciplina_id
      WHERE n.escola_id = ?
        AND n.aluno_id = ?
    `;

    if (Number.isFinite(ano)) {
      sql += ` AND n.ano = ? `;
      params.push(ano);
    }

    sql += `
      ORDER BY n.ano DESC, n.bimestre ASC, d.nome ASC
    `;

    const [rows] = await db.query(sql, params);

    return res.json({
      ok: true,
      escola_id,
      aluno_id,
      rows,
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /boletim:", error);
    return res.status(500).json({ message: "Erro ao carregar boletim." });
  }
});




// ============================================================================
// PASSO 8.2 — GET /boletim-pdf (App Pais)
// - Backend gera PDF e o app apenas baixa/abre
// - PDF SEMPRE reflete TODAS as notas do ANO selecionado
// - Ranking no PDF é acumulado até o bimestre (opcional) informado
// Querystring:
//   /api/app-pais/boletim-pdf?aluno_id=2&ano=2025&bimestre=2
// ============================================================================
router.get("/boletim-pdf", authAppPais, async (req, res) => {
  const db = pool;

  try {
    const { responsavel_id, cpf: cpfAuth } = req.appPaisAuth;

    const aluno_id = Number(req.query?.aluno_id);
    const ano = Number(req.query?.ano);
    const bimestreRaw = req.query?.bimestre != null ? Number(req.query.bimestre) : 4;
    const bimestre = Number.isFinite(bimestreRaw) ? bimestreRaw : 4;

    if (!Number.isFinite(aluno_id) || !Number.isFinite(ano)) {
      return res.status(400).json({ message: "aluno_id e ano são obrigatórios." });
    }

    if (bimestre < 1 || bimestre > 4) {
      return res.status(400).json({ message: "bimestre inválido (1 a 4)." });
    }

    // ── DEMO-APPLE bypass ────────────────────────────────────────────────────
    if (cpfAuth === '00000000019') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="boletim-demo.pdf"');
      const demoDoc = new PDFDocument();
      demoDoc.pipe(res);
      demoDoc.fontSize(18).text('Boletim Demo - Apple Review', { align: 'center' });
      demoDoc.moveDown();
      demoDoc.fontSize(12).text('Maria Eduarda Santos - 7º Ano Turma B');
      demoDoc.end();
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ----------------------------------------------------------------------
    // 1) Confirma vínculo ativo + permissão e obtém escopos (turma/série/turno)
    // ----------------------------------------------------------------------
    const [[vinculo]] = await db.query(
      `
      SELECT
        ra.escola_id,
        ra.pode_ver_boletim,
        a.estudante AS aluno_nome,
        a.turma_id  AS turma_id,
        t.nome      AS turma_nome,
        t.serie     AS turma_serie,
        t.turno     AS turma_turno
      FROM responsaveis_alunos ra
      INNER JOIN alunos a ON a.id = ra.aluno_id
      LEFT JOIN turmas t ON t.id = a.turma_id
      WHERE ra.responsavel_id = ?
        AND ra.aluno_id = ?
        AND ra.ativo = 1
      LIMIT 1
      `,
      [responsavel_id, aluno_id]
    );

    if (!vinculo) {
      return res.status(403).json({ message: "Acesso negado a este estudante." });
    }

    if (!vinculo.pode_ver_boletim) {
      return res.status(403).json({ message: "Sem permissão para ver boletim." });
    }

    const escola_id = Number(vinculo.escola_id);

    // ----------------------------------------------------------------------
    // 2) Busca TODAS as notas do ANO (independente do bimestre atual no app)
    // ----------------------------------------------------------------------
    const [rows] = await db.query(
      `
      SELECT
        n.ano,
        n.bimestre,
        d.nome AS disciplina,
        n.nota,
        n.faltas
      FROM notas n
      INNER JOIN disciplinas d ON d.id = n.disciplina_id
      WHERE n.escola_id = ?
        AND n.aluno_id = ?
        AND n.ano = ?
      ORDER BY n.bimestre ASC, d.nome ASC
      `,
      [escola_id, aluno_id, ano]
    );

    // ----------------------------------------------------------------------
    // 3) Ranking (acumulado até o bimestre informado) — mesma lógica do /ranking
    // ----------------------------------------------------------------------
    async function calcularRanking(whereExtraSql = "", paramsExtra = []) {
      const [ranks] = await db.query(
        `
        SELECT
          n.aluno_id,
          AVG(n.nota) AS media
        FROM notas n
        INNER JOIN alunos a ON a.id = n.aluno_id
        LEFT JOIN turmas t ON t.id = a.turma_id
        WHERE n.escola_id = ?
          AND n.ano = ?
          AND n.bimestre <= ?
          AND n.nota IS NOT NULL
          ${whereExtraSql}
        GROUP BY n.aluno_id
        ORDER BY media DESC
        `,
        [escola_id, ano, bimestre, ...paramsExtra]
      );

      const total = ranks.length;
      const idx = ranks.findIndex((x) => Number(x.aluno_id) === aluno_id);

      return {
        posicao: idx >= 0 ? idx + 1 : null,
        total,
        label: idx >= 0 ? `${idx + 1}/${total}` : `—/${total}`,
      };
    }

    const rankingSala = await calcularRanking("AND t.id = ?", [vinculo.turma_id]);
    const rankingSerie = await calcularRanking("AND t.serie = ?", [vinculo.turma_serie]);
    const rankingTurno = await calcularRanking("AND t.turno = ?", [vinculo.turma_turno]);
    const rankingEscola = await calcularRanking();

    // ----------------------------------------------------------------------
    // 4) Geração do PDF (stream)
    // ----------------------------------------------------------------------
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="boletim_${aluno_id}_${ano}.pdf"`
    );

    const doc = new PDFDocument({ size: "A4", margin: 40 });

    // Pipe para a resposta HTTP
    doc.pipe(res);

    // Cabeçalho
    doc.fontSize(18).text("EDUCA.MELHOR — Boletim", { align: "left" });
    doc.moveDown(0.5);

    doc.fontSize(11).fillColor("#111111");
    doc.text(`Aluno: ${vinculo.aluno_nome || `ID ${aluno_id}`}`);
    doc.text(`Turma: ${vinculo.turma_nome || "—"} | Série: ${vinculo.turma_serie || "—"} | Turno: ${vinculo.turma_turno || "—"}`);
    doc.text(`Ano letivo: ${ano}`);
    doc.text(`Ranking acumulado até: ${bimestre}º bimestre`);
    doc.moveDown(0.8);

    // Ranking (4 linhas)
    doc.fontSize(12).text("Ranking", { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(11);
    doc.text(`Ranking sala:   ${rankingSala.label}`);
    doc.text(`Ranking série:  ${rankingSerie.label}`);
    doc.text(`Ranking turno:  ${rankingTurno.label}`);
    doc.text(`Ranking escola: ${rankingEscola.label}`);
    doc.moveDown(1);

    // ----------------------------------------------------------------------
    // TABELA ÚNICA (mais usual): Disciplina x Bimestres (1º..4º)
    // - Linhas: disciplinas
    // - Colunas: 1º, 2º, 3º, 4º (nota)
    // - Observação: no futuro podemos adicionar também faltas por bimestre
    // ----------------------------------------------------------------------
    doc.fontSize(12).text("Notas do ano (todas as notas lançadas)", { underline: true });
    doc.moveDown(0.6);

    // Pivot: disciplina -> {1:{nota,faltas},2:{...},3:{...},4:{...}}
    const porDisciplina = new Map();

    for (const r of rows) {
      const disc = String(r.disciplina || "—").trim() || "—";
      const bim = Number(r.bimestre);
      if (bim < 1 || bim > 4) continue;

      if (!porDisciplina.has(disc)) {
        porDisciplina.set(disc, { 1: null, 2: null, 3: null, 4: null });
      }

      porDisciplina.get(disc)[bim] = {
        nota: r.nota,
        faltas: r.faltas,
      };
    }

    // Ordena disciplinas (natural e previsível)
    const disciplinasOrdenadas = Array.from(porDisciplina.keys()).sort((a, b) =>
      a.localeCompare(b, "pt-BR", { sensitivity: "base" })
    );










    // Layout de colunas (compacto): Disciplina | 1º | 2º | 3º | 4º | Total Faltas | Resultado

    const X0 = 40;
    const GAP = 6;

    // Ajuste fino para caber com folga na margem direita do A4
    const W_DISC = 220;
    const W_BIM = 34;      // 1º..4º (nota)
    const W_FALTAS = 48;   // total faltas
    const W_RES = 72;      // resultado (compacto)

    const xDisc = X0;
    const xB1 = xDisc + W_DISC + GAP;
    const xB2 = xB1 + W_BIM + GAP;
    const xB3 = xB2 + W_BIM + GAP;
    const xB4 = xB3 + W_BIM + GAP;
    const xTF = xB4 + W_BIM + GAP;
    const xRes = xTF + W_FALTAS + GAP;

    function classificarResultado(media) {
      if (media == null || !Number.isFinite(media)) return "—";
      if (media >= 7.0) return "Aprovado";
      if (media >= 5.0) return "Recuperação";
      return "Reprovado";
    }

    function printTabelaHeader() {
      doc.fontSize(10).fillColor("#444444");
      const y = doc.y;

      doc.text("Disciplina", xDisc, y, { width: W_DISC });
      doc.text("1º", xB1, y, { width: W_BIM, align: "right" });
      doc.text("2º", xB2, y, { width: W_BIM, align: "right" });
      doc.text("3º", xB3, y, { width: W_BIM, align: "right" });
      doc.text("4º", xB4, y, { width: W_BIM, align: "right" });
      doc.text("Faltas", xTF, y, { width: W_FALTAS, align: "right" });
      doc.text("Resultado", xRes, y, { width: W_RES, align: "right" });

      doc.moveDown(0.2);
      doc
        .moveTo(X0, doc.y)
        .lineTo(555, doc.y)
        .strokeColor("#dddddd")
        .stroke();
      doc.moveDown(0.3);

      doc.fontSize(10).fillColor("#111111");
    }

    // Se não houver registros no ano
    if (disciplinasOrdenadas.length === 0) {
      doc.fontSize(11).fillColor("#111111");
      doc.text("Nenhuma nota lançada para este ano.");
      doc.moveDown(0.6);
    } else {
      printTabelaHeader();

      for (const disc of disciplinasOrdenadas) {
        // Quebra de página: se estiver no final, adiciona página e reimprime header
        if (doc.y > 760) {
          doc.addPage();
          doc.moveDown(0.2);
          printTabelaHeader();
        }

        const data = porDisciplina.get(disc);

        const formatNota = (cell) => {
          if (!cell || cell.nota == null) return "—";
          const n = Number(cell.nota);
          return Number.isFinite(n) ? n.toFixed(1) : "—";
        };

        // Total faltas (somando as faltas dos bimestres existentes)
        const faltasTotal =
          (data[1]?.faltas != null ? Number(data[1].faltas) : 0) +
          (data[2]?.faltas != null ? Number(data[2].faltas) : 0) +
          (data[3]?.faltas != null ? Number(data[3].faltas) : 0) +
          (data[4]?.faltas != null ? Number(data[4].faltas) : 0);

        // Média anual da disciplina (apenas bimestres com nota)
        const notas = [data[1], data[2], data[3], data[4]]
          .map((c) => (c?.nota == null ? null : Number(c.nota)))
          .filter((v) => Number.isFinite(v));

        const mediaDisc =
          notas.length > 0 ? notas.reduce((acc, v) => acc + v, 0) / notas.length : null;

        const resultado = classificarResultado(mediaDisc);

        const y = doc.y;

        doc.text(disc, xDisc, y, { width: W_DISC });
        doc.text(formatNota(data[1]), xB1, y, { width: W_BIM, align: "right" });
        doc.text(formatNota(data[2]), xB2, y, { width: W_BIM, align: "right" });
        doc.text(formatNota(data[3]), xB3, y, { width: W_BIM, align: "right" });
        doc.text(formatNota(data[4]), xB4, y, { width: W_BIM, align: "right" });
        doc.text(String(faltasTotal), xTF, y, { width: W_FALTAS, align: "right" });
        doc.text(resultado, xRes, y, { width: W_RES, align: "right" });

        doc.moveDown(0.35);
      }

      doc.moveDown(0.5);
    }










    // ----------------------------------------------------------------------
    // PASSO 8.2.5 — RESUMO GERAL DO ANO (abaixo da tabela)
    // - Média geral do ano (todas as notas do ano, ignorando null)
    // - Total de faltas do ano (somatório de todas as faltas do ano)
    // - Resultado final do aluno no ano
    // ----------------------------------------------------------------------
    {
      // 1) Todas as notas numéricas do ano (todas disciplinas / bimestres)
      const notasAno = (rows || [])
        .map((r) => (r?.nota == null ? null : Number(r.nota)))
        .filter((n) => Number.isFinite(n));

      // 2) Total de faltas do ano
      const faltasAno = (rows || []).reduce((acc, r) => {
        const f = r?.faltas == null ? 0 : Number(r.faltas);
        return acc + (Number.isFinite(f) ? f : 0);
      }, 0);

      // 3) Média geral do ano
      const mediaAno =
        notasAno.length > 0
          ? notasAno.reduce((acc, v) => acc + v, 0) / notasAno.length
          : null;

      const resultadoFinalAno = classificarResultado(mediaAno);

      // ------------------------------------------------------------
      // FORÇA DE LAYOUT: sempre começar no X padrão e com largura total
      // ------------------------------------------------------------
      const BOX_X = 40;
      const BOX_W = 555 - 40; // mesma largura útil do conteúdo (A4 com margin 40)
      const mediaTexto = mediaAno == null ? "—" : mediaAno.toFixed(1);

      // Espaço antes do resumo
      doc.moveDown(0.8);

      // Linha separadora (full width)
      doc
        .moveTo(BOX_X, doc.y)
        .lineTo(BOX_X + BOX_W, doc.y)
        .strokeColor("#e5e7eb")
        .stroke();

      doc.moveDown(0.6);

      // Se estiver perto do fim, joga o resumo para a próxima página (antes de desenhar o  card)
      if (doc.y > 660) {
        doc.addPage();
      }

      // Card do resumo (visual moderno e limpo)
      const cardTop = doc.y;
      const cardPad = 12;

      // desenha um fundo leve
      doc
        .roundedRect(BOX_X, cardTop, BOX_W, 92, 8)
        .fillColor("#f8fafc")
        .fill();
 
      // volta para desenhar texto por cima
      doc.fillColor("#111111");

      // título (sem underline para não “quebrar” estética)
      doc.fontSize(12).text("Resumo geral do ano", BOX_X + cardPad, cardTop + cardPad, {
        width: BOX_W - cardPad * 2,
        align: "left",
      });

      doc.moveDown(0.4);

      // corpo
      doc.fontSize(11).fillColor("#111111");
      const bodyTop = cardTop + cardPad + 22;

      doc.text(`Média geral do ano: ${mediaTexto}`, BOX_X + cardPad, bodyTop, {
        width: BOX_W - cardPad * 2,
        align: "left",
      });

      doc.text(`Total de faltas no ano: ${String(faltasAno)}`, BOX_X + cardPad, bodyTop + 18, {
        width: BOX_W - cardPad * 2,
        align: "left",
      });

      doc.text(`Resultado final: ${resultadoFinalAno}`, BOX_X + cardPad, bodyTop + 36, {
        width: BOX_W - cardPad * 2,
        align: "left",
      });

      // posiciona o cursor abaixo do card
      doc.y = cardTop + 92 + 6;
    }











    // Rodapé
    doc.fontSize(9).fillColor("#6b7280");

    // Rodapé com coordenada fixa para nunca “quebrar” em várias linhas
    const rodapeTexto = `Gerado em: ${new Date().toLocaleString("pt-BR")}`;

    // y fixo próximo ao final da página (A4 com margin 40)
    const rodapeY = doc.page.height - 40;

    doc.text(rodapeTexto, 40, rodapeY, {
      width: doc.page.width - 80,
      align: "right",
      lineBreak: false,
    });


    doc.end();
  } catch (error) {
    console.error("[APP_PAIS] Erro em /boletim-pdf:", error);
    return res.status(500).json({ message: "Erro ao gerar boletim em PDF." });
  }
});









// ============================================================================
// PASSO 7.2 — GET /ranking (App Pais)
// - Retorna ranking acumulado (até o bimestre selecionado)
// - Escopos: sala, série, turno, escola
// Querystring:
//   /api/app-pais/ranking?aluno_id=2&ano=2025&bimestre=2
// ============================================================================
router.get("/ranking", authAppPais, async (req, res) => {
  const db = pool;

  try {
    const { responsavel_id } = req.appPaisAuth;

    const aluno_id = Number(req.query?.aluno_id);
    const ano = Number(req.query?.ano);
    const bimestre = Number(req.query?.bimestre);

    if (
      !Number.isFinite(aluno_id) ||
      !Number.isFinite(ano) ||
      !Number.isFinite(bimestre) ||
      bimestre < 1 ||
      bimestre > 4
    ) {
      return res.status(400).json({
        message: "Parâmetros inválidos: aluno_id, ano e bimestre são obrigatórios.",
      });
    }

    // ----------------------------------------------------------------------
    // 1) Confirma vínculo ativo + permissão
    // ----------------------------------------------------------------------
    const [[vinculo]] = await db.query(
      `
      SELECT
        ra.escola_id,
        ra.pode_ver_boletim,
        t.id     AS turma_id,
        t.serie  AS turma_serie,
        t.turno  AS turma_turno
      FROM responsaveis_alunos ra
      INNER JOIN alunos a ON a.id = ra.aluno_id
      LEFT JOIN turmas t ON t.id = a.turma_id
      WHERE ra.responsavel_id = ?
        AND ra.aluno_id = ?
        AND ra.ativo = 1
      LIMIT 1
      `,
      [responsavel_id, aluno_id]
    );

    if (!vinculo) {
      return res.status(403).json({ message: "Acesso negado a este estudante." });
    }

    if (!vinculo.pode_ver_boletim) {
      return res.status(403).json({ message: "Sem permissão para ver ranking." });
    }

    const escola_id = vinculo.escola_id;

    // ----------------------------------------------------------------------
    // Helper para calcular ranking
    // ----------------------------------------------------------------------
    async function calcularRanking(whereExtraSql = "", paramsExtra = []) {
      const [rows] = await db.query(
        `
        SELECT
          n.aluno_id,
          AVG(n.nota) AS media
        FROM notas n
        INNER JOIN alunos a ON a.id = n.aluno_id
        LEFT JOIN turmas t ON t.id = n.turma_id
        WHERE n.escola_id = ?
          AND n.ano = ?
          AND n.bimestre <= ?
          AND n.nota IS NOT NULL
          ${whereExtraSql}
        GROUP BY n.aluno_id
        ORDER BY media DESC
        `,
        [escola_id, ano, bimestre, ...paramsExtra]
      );

      const total = rows.length;
      const index = rows.findIndex((r) => r.aluno_id === aluno_id);

      return {
        posicao: index >= 0 ? index + 1 : null,
        total,
        label: index >= 0 ? `${index + 1}/${total}` : `—/${total}`,
      };
    }

    // ----------------------------------------------------------------------
    // 2) Rankings
    // ----------------------------------------------------------------------
    const rankingSala = await calcularRanking(
      "AND t.id = ?",
      [vinculo.turma_id]
    );

    const rankingSerie = await calcularRanking(
      "AND t.serie = ?",
      [vinculo.turma_serie]
    );

    const rankingTurno = await calcularRanking(
      "AND t.turno = ?",
      [vinculo.turma_turno]
    );

    const rankingEscola = await calcularRanking();

    // ----------------------------------------------------------------------
    // 3) Response
    // ----------------------------------------------------------------------
    return res.json({
      ok: true,
      meta: {
        escola_id,
        aluno_id,
        ano,
        bimestre,
        acumulado_ate_bimestre: bimestre,
      },
      ranking: {
        sala: rankingSala,
        serie: rankingSerie,
        turno: rankingTurno,
        escola: rankingEscola,
      },
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /ranking:", error);
    return res.status(500).json({ message: "Erro ao calcular ranking." });
  }
});








// ============================================================================
// PASSO 2.3.1 — GET /credenciais/contextos (master)
// - Retorna lista de escolas + estudantes onde o responsável logado é MASTER
// - Usado pelo seletor moderno (multiescola/multiestudante)
// ============================================================================
router.get("/credenciais/contextos", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id } = req.appPaisAuth;

    const [rows] = await db.query(
      `
      SELECT
        ra.escola_id,
        e.apelido AS escola_apelido,
        a.id   AS aluno_id,
        a.estudante AS aluno_nome
      FROM responsaveis_alunos ra
      INNER JOIN escolas e ON e.id = ra.escola_id
      INNER JOIN alunos a ON a.id = ra.aluno_id
      WHERE ra.responsavel_id = ?
        AND ra.ativo = 1
        AND ra.principal = 1
        AND ra.pode_autorizar_terceiros = 1
      ORDER BY ra.escola_id ASC, a.estudante ASC
      `,
      [responsavel_id]
    );

    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.escola_id)) {
        map.set(r.escola_id, {
          escola: { id: r.escola_id, apelido: r.escola_apelido ?? null },
          estudantes: [],
        });
      }
      map.get(r.escola_id).estudantes.push({
        aluno_id: r.aluno_id,
        aluno_nome: r.aluno_nome,
      });
    }

    return res.json({ ok: true, contextos: Array.from(map.values()) });

    } catch (error) {
      console.error("[APP_PAIS] Erro em /credenciais/contextos:", error);
      return res
        .status(500)
        .json({ message: "Erro ao buscar contextos de credenciais." });
    }
  });


// ============================================================================
// POST /solicitar-codigo  (v2 — suporte a e-mail + SMS + fluxo PRECISA_EMAIL)
// ============================================================================
// ============================================================================
// APP ALUNO — Rotas de autenticação e perfil do aluno
// ============================================================================

// POST /aluno/solicitar-codigo
router.post('/aluno/solicitar-codigo', async (req, res) => {
  try {
    const cpf = normalizarCpf(req.body?.cpf);
    if (!cpf) return res.status(400).json({ message: 'CPF é obrigatório.' });
    const [[aluno]] = await pool.query(
      `SELECT id, estudante, telefone, escola_id, data_nascimento FROM alunos WHERE cpf = ? AND status = 'ativo' LIMIT 1`,
      [cpf]
    );
    if (!aluno) return res.status(404).json({ ok: false, code: 'ALUNO_NAO_ENCONTRADO', message: 'CPF não encontrado.' });
    if (aluno.telefone) {
      const codigo = Math.floor(100000 + Math.random() * 900000).toString();
      await pool.query(
        `INSERT INTO app_aluno_codigos (aluno_id, codigo, destino, expiracao) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
        [aluno.id, codigo, aluno.telefone]
      );
      await enviarCodigoPorSms(aluno.telefone, codigo);
      return res.json({ ok: true, tem_telefone: true, telefone_mascara: maskPhone(aluno.telefone) });
    } else {
      return res.json({ ok: true, tem_telefone: false, requer_verificacao: true });
    }
  } catch (e) {
    console.error('[ALUNO/SOLICITAR-CODIGO]', e);
    return res.status(500).json({ message: 'Erro interno.' });
  }
});

// POST /aluno/verificar-data-nascimento
router.post('/aluno/verificar-data-nascimento', async (req, res) => {
  try {
    const cpf = normalizarCpf(req.body?.cpf);
    const dataNasc = String(req.body?.data_nascimento || '');
    if (!cpf || !dataNasc) return res.status(400).json({ message: 'CPF e data_nascimento são obrigatórios.' });
    const [[aluno]] = await pool.query(
      `SELECT id, data_nascimento FROM alunos WHERE cpf = ? AND status = 'ativo' LIMIT 1`,
      [cpf]
    );
    if (!aluno) return res.status(404).json({ message: 'Aluno não encontrado.' });
    const normalize = (d) => {
      const s = String(d).replace(/\D/g, '');
      if (s.length !== 8) return null;
      const maybeYear = parseInt(s.slice(0, 4));
      if (maybeYear > 1900 && maybeYear < 2100) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
      return `${s.slice(4,8)}-${s.slice(2,4)}-${s.slice(0,2)}`;
    };
    const dbDate = aluno.data_nascimento ? String(aluno.data_nascimento).slice(0, 10) : null;
    const inputDate = normalize(dataNasc);
    if (!dbDate || !inputDate || dbDate !== inputDate)
      return res.status(403).json({ message: 'Data de nascimento incorreta.' });
    const tokenTemp = require('crypto').randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO app_aluno_codigos (aluno_id, codigo, destino, expiracao, token_data_nasc, token_data_nasc_exp) VALUES (?, '', '', DATE_ADD(NOW(), INTERVAL 1 MINUTE), ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))`,
      [aluno.id, tokenTemp]
    );
    return res.json({ ok: true, token_temp: tokenTemp });
  } catch (e) {
    console.error('[ALUNO/VERIFICAR-DATA-NASCIMENTO]', e);
    return res.status(500).json({ message: 'Erro interno.' });
  }
});

// POST /aluno/cadastrar-telefone
router.post('/aluno/cadastrar-telefone', async (req, res) => {
  try {
    const cpf = normalizarCpf(req.body?.cpf);
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const tokenTemp = String(req.body?.token_temp || '');
    if (!cpf || !telefone || !tokenTemp) return res.status(400).json({ message: 'Dados incompletos.' });
    const [[aluno]] = await pool.query(`SELECT id FROM alunos WHERE cpf = ? AND status = 'ativo' LIMIT 1`, [cpf]);
    if (!aluno) return res.status(404).json({ message: 'Aluno não encontrado.' });
    const [[tokenRow]] = await pool.query(
      `SELECT id FROM app_aluno_codigos WHERE aluno_id = ? AND token_data_nasc = ? AND token_data_nasc_exp > NOW() LIMIT 1`,
      [aluno.id, tokenTemp]
    );
    if (!tokenRow) return res.status(403).json({ message: 'Token expirado. Tente novamente.' });
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query(
      `INSERT INTO app_aluno_codigos (aluno_id, codigo, destino, expiracao) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
      [aluno.id, codigo, telefone]
    );
    await enviarCodigoPorSms(telefone, codigo);
    return res.json({ ok: true, telefone_mascara: maskPhone(telefone) });
  } catch (e) {
    console.error('[ALUNO/CADASTRAR-TELEFONE]', e);
    return res.status(500).json({ message: 'Erro interno.' });
  }
});

// POST /aluno/verificar-codigo
router.post('/aluno/verificar-codigo', async (req, res) => {
  try {
    const cpf = normalizarCpf(req.body?.cpf);
    const codigo = String(req.body?.codigo || '').trim();
    if (!cpf || !codigo) return res.status(400).json({ message: 'CPF e código são obrigatórios.' });
    const [[aluno]] = await pool.query(
      `SELECT id, estudante, escola_id, telefone, cpf FROM alunos WHERE cpf = ? AND status = 'ativo' LIMIT 1`, [cpf]
    );
    if (!aluno) return res.status(404).json({ message: 'Aluno não encontrado.' });
    const [[otpRow]] = await pool.query(
      `SELECT id, destino FROM app_aluno_codigos WHERE aluno_id = ? AND codigo = ? AND usado_em IS NULL AND expiracao > NOW() AND destino != '' ORDER BY id DESC LIMIT 1`,
      [aluno.id, codigo]
    );
    if (!otpRow) return res.status(401).json({ message: 'Código inválido ou expirado.' });
    await pool.query(`UPDATE app_aluno_codigos SET usado_em = NOW() WHERE id = ?`, [otpRow.id]);
    if (!aluno.telefone) {
      await pool.query(`UPDATE alunos SET telefone = ? WHERE id = ?`, [otpRow.destino, aluno.id]);
    }
    const token = jwt.sign(
      { tipo: 'ALUNO', aluno_id: aluno.id, cpf: aluno.cpf, escola_id: aluno.escola_id },
      APP_PAIS_JWT_SECRET,
      { expiresIn: '30d' }
    );
    return res.json({ ok: true, token, aluno: { id: aluno.id, nome: aluno.estudante, escola_id: aluno.escola_id } });
  } catch (e) {
    console.error('[ALUNO/VERIFICAR-CODIGO]', e);
    return res.status(500).json({ message: 'Erro interno.' });
  }
});

// GET /aluno/me
router.get('/aluno/me', authAluno, async (req, res) => {
  try {
    const { aluno_id } = req.alunoAuth;
    const [[aluno]] = await pool.query(
      `SELECT a.id, a.estudante AS nome, a.codigo AS ra, a.escola_id, a.cpf, a.serie,
              e.apelido AS escola_apelido,
              t.nome AS turma_nome, t.serie AS turma_serie, t.turno AS turma_turno
       FROM alunos a
       LEFT JOIN escolas e ON e.id = a.escola_id
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.id = ? LIMIT 1`,
      [aluno_id]
    );
    if (!aluno) return res.status(404).json({ message: 'Aluno não encontrado.' });
    return res.json({ ok: true, aluno });
  } catch (e) {
    return res.status(500).json({ message: 'Erro interno.' });
  }
});

router.post("/solicitar-codigo", async (req, res) => {
  console.log("[SOLICITAR-CODIGO] body:", JSON.stringify(req.body ?? null));
  const db = pool;
  const cpf   = normalizarCpf(req.body?.cpf);
  const canal = String(req.body?.canal || "email").toLowerCase(); // "email" | "sms"

  if (!cpf) {
    return res.status(400).json({ message: "CPF é obrigatório." });
  }

  // ── DEMO ACCOUNT (Apple App Store Review) ────────────────────────────────
  if (cpf === "00000000019") {
    console.log("[APP_PAIS][DEMO] Conta revisão Apple — bypass");
    return res.json({ ok: true });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, email, telefone_celular, status_global
       FROM responsaveis WHERE cpf = ? LIMIT 1`,
      [cpf]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Responsável não encontrado." });
    }

    const responsavel = rows[0];
    const email       = String(responsavel.email || "").trim();
    const telefone    = String(responsavel.telefone_celular || "").trim();
    const status      = String(responsavel.status_global || "").trim().toUpperCase();

    // ── Bloqueio real: consentimento ainda não foi confirmado pela escola ────
    if (status === "PENDENTE") {
      return res.status(403).json({
        code: "CREDENCIAL_PENDENTE",
        message:
          "Seu credenciamento ainda não foi liberado. Procure a secretaria da escola do estudante ou solicite ao responsável já credenciado para liberar seu acesso.",
      });
    }

    // ── Verifica se o responsável já assinou o Termo de Consentimento Específico ──────
    // O consentimento pode ser dado:
    //   a) Digitalmente via app (DIGITAL_APP) — pelo próprio responsável
    //   b) Fisicamente na escola (FISICO) — direção marca consentimento_imagem = 1 no portal
    // Se nenhum aluno tiver consentimento_imagem = 1, bloqueia com TERMO_PENDENTE.
    const [[{ comConsentimento }]] = await db.query(
      `SELECT COUNT(*) AS comConsentimento
       FROM responsaveis_alunos
       WHERE responsavel_id = ? AND ativo = 1 AND consentimento_imagem = 1`,
      [responsavel.id]
    );

    if (comConsentimento === 0) {
      return res.status(403).json({
        code: "TERMO_PENDENTE",
        message:
          "Para acessar o EDUCA MOBILE, você precisa assinar o Termo de Consentimento Específico. " +
          "Você pode assinar digitalmente agora, ou comparecer à escola para assinar fisicamente.",
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    // ── Sem e-mail e canal email: pede o e-mail ao usuário ──────────────────
    if (canal === "email" && !email) {
      return res.status(403).json({
        code: "PRECISA_EMAIL",
        message: "Informe seu e-mail para receber o código de acesso.",
        tem_sms: !!(telefone && process.env.TWILIO_SID),
        telefone_mascara: mascaraTelefone(telefone) || null,
      });
    }

    // ── Canal SMS: sempre pede confirmação/digitação do número antes de enviar ──
    // Isso garante que números desatualizados possam ser corrigidos pelo pai/mãe.
    if (canal === "sms") {
      if (!process.env.TWILIO_SID) {
        return res.status(503).json({
          code: "SMS_NAO_CONFIGURADO",
          message: "Envio por SMS temporariamente indisponível. Use e-mail.",
        });
      }
      // Sempre retorna CONFIRMAR_TELEFONE para o app mostrar o modal de confirmação.
      // O app exibe o número mascarado (se cadastrado) e permite digitar um novo.
      return res.status(202).json({
        code: "CONFIRMAR_TELEFONE",
        message: telefone
          ? "Confirme ou atualize o número de celular para receber o código."
          : "Informe seu número de celular para receber o código por SMS.",
        telefone_mascara: mascaraTelefone(telefone) || null,
        tem_telefone: !!telefone,
      });
    }


    // ── Gera e persiste o código ─────────────────────────────────────────────
    const codigo = gerarCodigo();
    const destino = canal === "sms" ? telefone : email;

    await db.query(
      `INSERT INTO app_pais_codigos
         (responsavel_id, codigo, canal, destino, expiracao)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
      [responsavel.id, codigo, canal, destino]
    );

    // ── Envia pelo canal escolhido ───────────────────────────────────────────
    if (canal === "sms") {
      await enviarCodigoPorSms(telefone, codigo);
    } else {
      await enviarCodigoPorEmail(email, codigo);
    }

    return res.json({
      ok: true,
      canal,
      destino_mascara: canal === "sms" ? mascaraTelefone(telefone) : mascaraEmail(email),
    });

  } catch (error) {
    console.error("[APP_PAIS] Erro em /solicitar-codigo:", error);
    return res
      .status(500)
      .json({ ok: false, message: "Erro ao enviar código. Tente novamente." });
  }
});


// ============================================================================
// POST /salvar-email
// Salva (ou atualiza) o e-mail do responsável antes do login (pré-autenticação).
// body: { cpf, email }
// - Não requer token (pré-login)
// - O e-mail fica persistido; no próximo acesso o backend usa diretamente
// - Pode ser chamado novamente para trocar o e-mail
// ============================================================================
router.post("/salvar-email", async (req, res) => {
  const db  = pool;
  const cpf = normalizarCpf(req.body?.cpf);
  const emailRaw = String(req.body?.email || "").trim().toLowerCase();

  if (!cpf) {
    return res.status(400).json({ message: "CPF é obrigatório." });
  }
  if (!emailRaw || !emailRaw.includes("@") || !emailRaw.includes(".")) {
    return res.status(400).json({ message: "Informe um e-mail válido." });
  }

  try {
    const [[resp]] = await db.query(
      "SELECT id, status_global FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpf]
    );

    if (!resp) {
      return res.status(404).json({ message: "Responsável não encontrado." });
    }

    // Salva o e-mail
    await db.query(
      "UPDATE responsaveis SET email = ? WHERE id = ?",
      [emailRaw, resp.id]
    );

    console.log(`[APP_PAIS][SALVAR-EMAIL] E-mail atualizado para responsável ${resp.id}`);

    return res.json({
      ok: true,
      message: "E-mail salvo com sucesso.",
      email_mascara: mascaraEmail(emailRaw),
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /salvar-email:", error);
    return res.status(500).json({ message: "Erro ao salvar e-mail. Tente novamente." });
  }
});

// ============================================================================
// POST /salvar-telefone
// Salva (ou atualiza) o celular do responsável antes do login via SMS.
// body: { cpf, telefone }
// - Não requer token (pré-login)
// - Valida formato brasileiro (10-11 dígitos numéricos)
// - Permite corrigir número desatualizado sem ir à secretaria
// ============================================================================
router.post("/salvar-telefone", async (req, res) => {
  const db  = pool;
  const cpf = normalizarCpf(req.body?.cpf);
  const telRaw = String(req.body?.telefone || "").replace(/\D/g, "").trim();

  if (!cpf) {
    return res.status(400).json({ message: "CPF é obrigatório." });
  }
  if (!telRaw || telRaw.length < 10 || telRaw.length > 11) {
    return res.status(400).json({ message: "Informe um número de celular válido (com DDD)." });
  }

  try {
    const [[resp]] = await db.query(
      "SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpf]
    );

    if (!resp) {
      return res.status(404).json({ message: "Responsável não encontrado." });
    }

    await db.query(
      "UPDATE responsaveis SET telefone_celular = ? WHERE id = ?",
      [telRaw, resp.id]
    );

    console.log(`[APP_PAIS][SALVAR-TEL] Telefone atualizado para responsável ${resp.id}`);

    return res.json({
      ok: true,
      message: "Telefone salvo com sucesso.",
      telefone_mascara: mascaraTelefone(telRaw),
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /salvar-telefone:", error);
    return res.status(500).json({ message: "Erro ao salvar telefone. Tente novamente." });
  }
});

// ============================================================================
// POST /verificar-codigo
// ============================================================================
router.post("/verificar-codigo", async (req, res) => {
  const db = pool;
  const cpf = normalizarCpf(req.body?.cpf);
  const codigo = normalizarCodigo(req.body?.codigo);

  if (!cpf || !codigo) {
    return res.status(400).json({ message: "CPF e código são obrigatórios." });
  }

  // ── DEMO ACCOUNT (Apple App Store Review) ────────────────────────────────
  // CPF 00000000191 + OTP 000000 → token de demonstração com dados reais no banco
  if (cpf === '00000000019' && codigo === '000000') {
    console.log('[APP_PAIS][DEMO] Bypass de revisão Apple — buscando responsável demo no banco');
    try {
      const [[demoResp]] = await db.query(
        "SELECT id, nome, cpf, email FROM responsaveis WHERE cpf = '00000000019' LIMIT 1"
      );
      if (!demoResp) {
        console.error('[APP_PAIS][DEMO] Responsável demo não encontrado no banco!');
        return res.status(500).json({ message: "Conta demo não configurada." });
      }
      const token = gerarTokenSessaoResponsavel(demoResp);
      return res.json({
        ok: true,
        token,
        expires_in: APP_PAIS_JWT_EXPIRES_IN_SECONDS,
        responsavel: demoResp,
      });
    } catch (err) {
      console.error('[APP_PAIS][DEMO] Erro ao buscar responsável demo:', err.message);
      return res.status(500).json({ message: "Erro na conta demo." });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  try {
    const [[responsavel]] = await db.query(
      "SELECT id, nome, cpf, email FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpf]
    );
      if (!responsavel) {
        return res.status(404).json({ message: "Responsável não encontrado." });
      }
    const [[registro]] = await db.query(
      `
      SELECT * FROM app_pais_codigos
      WHERE responsavel_id = ? AND codigo = ?
      ORDER BY id DESC LIMIT 1
      `,
      [responsavel.id, codigo]
    );

    if (!registro) {
      return res.status(400).json({ message: "Código inválido." });
    }

    if (new Date(registro.expiracao) < new Date()) {
      return res.status(400).json({ message: "Código expirado." });
    }

    await db.query(
      "UPDATE app_pais_codigos SET usado_em = NOW() WHERE id = ?",
      [registro.id]
    );


    // ============================================================================
    // PASSO 2.7.3.6 — BLOQUEIO DE SESSÃO SEM VÍNCULO (S3 NÃO PODE EXISTIR)
    // Regra: se o CPF passou no OTP, ele precisa ter ao menos 1 vínculo ativo em responsaveis_alunos.
    // Caso contrário, NÃO gera token e orienta a procurar a secretaria.
    // ============================================================================
    const [[vinculoAtivo]] = await db.query(
      `
      SELECT 1
      FROM responsaveis_alunos
      WHERE responsavel_id = ?
        AND ativo = 1
      LIMIT 1
      `,
      [responsavel.id]
    );

    if (!vinculoAtivo && cpf !== '00000000019') {
      return res.status(403).json({
        message:
          "Cadastro encontrado, porém sem vínculo ativo com aluno. Procure a secretaria da escola para regularizar o credenciamento.",
        code: "SEM_VINCULO_ATIVO",
      });
    }

    const token = gerarTokenSessaoResponsavel(responsavel);

    return res.json({
      ok: true,
      token,
      expires_in: APP_PAIS_JWT_EXPIRES_IN_SECONDS,
      responsavel,
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /verificar-codigo:", error);
    return res.status(500).json({ ok: false, message: "Erro ao verificar código. Tente novamente." });
  }
});

// ============================================================================
// PASSO 2.3.1 — GET /credenciais/buscar?cpf=...
// - Master digita CPF do terceiro
// - Se não existir no BD → 404 com orientação (precisa solicitar no app)
// ============================================================================
router.get("/credenciais/buscar", authAppPais, async (req, res) => {
  const db = pool;
  const cpf = normalizarCpf(req.query?.cpf);

  if (!cpf) {
    return res.status(400).json({ message: "CPF é obrigatório." });
  }

  try {
    const [[resp]] = await db.query(
      "SELECT id, cpf, nome, email, status_global FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpf]
    );

    if (!resp) {
      return res.status(404).json({
        ok: false,
        code: "PRECISA_SOLICITAR_CREDENCIAMENTO",
        message: "Esse CPF precisa solicitar o credenciamento no EDUCA.MELHOR.",
      });
    }

    return res.json({ ok: true, responsavel: resp });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /credenciais/buscar:", error);
    return res.status(500).json({ message: "Erro ao buscar CPF." });
  }
});

// ============================================================================
// 🆕 PASSO 2.7.3.4 — CREDENCIAL / CONTEXTO (pré-login)
// ============================================================================
router.get("/credencial/contexto", async (req, res) => {
  const db = pool;
  const cpf = normalizarCpf(req.query?.cpf);

  if (!cpf) {
    return res.status(400).json({ message: "CPF é obrigatório." });
  }

  // ✅ Se CPF já existe, o fluxo correto é S1 (solicitar-codigo), não S2.
  const [[resp]] = await db.query(
    "SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1",
    [cpf]
  );

  // ✅ Pré-login: não há escola selecionada aqui.
  // Regra do fluxo: se existir responsável master em QUALQUER escola,
  // a solicitação pode ser aberta (a escola será herdada do(s) master(s)).
  const [masters] = await db.query(
    `
    SELECT DISTINCT escola_id
    FROM responsaveis_alunos
    WHERE ativo = 1
      AND principal = 1
      AND pode_autorizar_terceiros = 1
    ORDER BY escola_id ASC
    `
  );

  const escolas_master = masters.map((m) => m.escola_id);

  return res.json({
    ok: true,
    cpf_existe: !!resp,
    tem_master: escolas_master.length > 0,
    escolas_master, // pode ajudar o frontend futuramente (debug/telemetria)
  });
});


// ============================================================================
// 🆕 PASSO 2.7.3.X — CREDENCIAL / PRÉ-CADASTRO (silencioso)
// - Objetivo: salvar o CPF no BD para posterior finalização pela secretaria
// - NÃO abre solicitação, NÃO exige master, NÃO exige nome/email
// ============================================================================
// POST /api/app-pais/credencial/pre-cadastro
// body: { cpf }
router.post("/credencial/pre-cadastro", async (req, res) => {
  const db = pool;
  const cpfNorm = normalizarCpf(req.body?.cpf);

  if (!cpfNorm) {
    return res.status(400).json({ message: "CPF é obrigatório." });
  }

  try {
    // 1) Se já existe, não mexe (pré-cadastro é “idempotente”)
    const [[existente]] = await db.query(
      "SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpfNorm]
    );

    if (existente?.id) {
      return res.json({
        ok: true,
        cpf: cpfNorm,
        responsavel_id: existente.id,
        ja_existia: true,
      });
    }

    // 2) Se não existe, cria registro mínimo para a secretaria completar depois
    // Observação: para evitar risco de coluna NOT NULL em "nome", gravamos "PENDENTE".
    await db.query(
      `
      INSERT INTO responsaveis (cpf, nome, email, status_global)
      VALUES (?, 'PENDENTE', NULL, 'PENDENTE')
      `,
      [cpfNorm]
    );

    const [[novo]] = await db.query(
      "SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpfNorm]
    );

    return res.json({
      ok: true,
      cpf: cpfNorm,
      responsavel_id: novo?.id || null,
      ja_existia: false,
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /credencial/pre-cadastro:", error);
    return res.status(500).json({ message: "Erro ao registrar pré-cadastro." });
  }
});

// ============================================================================
// 🆕 PASSO 2.7.3.4 — CREDENCIAL / SOLICITAR (pré-login)
// ============================================================================
router.post("/credencial/solicitar", async (req, res) => {
  const db = pool;
  const { cpf, nome, email, parentesco, observacao } = req.body;

  if (!cpf || !nome) {
    return res.status(400).json({ message: "CPF e nome são obrigatórios." });
  }

  const cpfNorm = normalizarCpf(cpf);

  // ✅ Descobre todas as escolas onde existe responsável master (pré-login)
  const [masters] = await db.query(
    `
    SELECT DISTINCT escola_id
    FROM responsaveis_alunos
    WHERE ativo = 1
      AND principal = 1
      AND pode_autorizar_terceiros = 1
    ORDER BY escola_id ASC
    `
  );

  if (!masters.length) {
    return res.status(403).json({
      status: "SEM_MASTER",
      message: "Procure a secretaria da escola para realizar o credenciamento.",
    });
  }

  // ✅ Cria/atualiza o responsável solicitante
  await db.query(
    `
    INSERT INTO responsaveis (cpf, nome, email, status_global)
    VALUES (?, ?, ?, 'ATIVO')
    ON DUPLICATE KEY UPDATE
      nome = VALUES(nome),
      email = VALUES(email)
    `,
    [cpfNorm, String(nome).toUpperCase(), email || null]
  );

  // ⚠️ Em ON DUPLICATE KEY UPDATE, insertId pode não vir como esperado.
  // Então garantimos o ID com SELECT.
  const [[respRow]] = await db.query(
    "SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1",
    [cpfNorm]
  );

  const responsavel_id = respRow?.id;
               pode_ver_frequencia = ?,
               pode_ver_agenda = ?,
               pode_receber_notificacoes = ?,
               ativo = 1,
               pode_autorizar_terceiros = ?
         WHERE id = ?
        `,
        [
          pode_ver_boletim,
          pode_ver_frequencia,
          pode_ver_agenda,
          pode_receber_notificacoes,
          pode_autorizar_terceiros,
          existeVinculo.id,
        ]
      );
    }

    // 5) Opcional: ajustar status_global (não quebra login, mas mantém semântica)
    // - Se ainda não tem email, continua PENDENTE (o OTP depende de email).
    // - Se tem email, pode promover para ATIVO.
    const email = String(terceiro.email || "").trim();
    if (email) {
      await db.query(
        "UPDATE responsaveis SET status_global = 'ATIVO' WHERE id = ?",
        [terceiro.id]
      );
    }

    return res.json({
      ok: true,
      message: `CPF ${cpf} credenciado com sucesso!`,
      responsavel_id: terceiro.id,
      escola_id,
      aluno_id,
    });
  } catch (error) {
    // ── DEMO-APPLE bypass ────────────────────────────────────────────────────
    if (cpfAuth === '00000000019') {
      return res.json({ ok: true, disciplinas: [
        { id: 1, nome: 'Português' },
        { id: 2, nome: 'Matemática' },
        { id: 3, nome: 'Ciências' },
        { id: 4, nome: 'História' },
        { id: 5, nome: 'Geografia' },
        { id: 6, nome: 'Artes' },
        { id: 7, nome: 'Educação Física' },
      ]});
    }
    // ─────────────────────────────────────────────────────────────────────────

    // 1) Descobre escola_id a partir do vínculo (garante acesso)
    const [vinc] = await db.query(
      `
      SELECT ra.escola_id
      FROM responsaveis_alunos ra
      WHERE ra.responsavel_id = ?
        AND ra.aluno_id = ?
        AND ra.ativo = 1
      LIMIT 1
      `,
      [responsavel_id, alunoId]
    );

    if (!vinc.length) {
      return res.status(403).json({ message: "Acesso negado para este aluno." });
    }

    const escolaId = vinc[0].escola_id;

    // 2) Lista disciplinas da escola
    const [rows] = await db.query(
      `
      SELECT id, nome
      FROM disciplinas
      WHERE escola_id = ?
      ORDER BY nome ASC
      `,
      [escolaId]
    );

    return res.json({ ok: true, disciplinas: rows });
  } catch (error) {
    console.error("[APP_PAIS] Erro em GET /conteudos/disciplinas:", error);
    return res.status(500).json({ message: "Erro ao carregar disciplinas." });
  }
});

router.get("/conteudos", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id, cpf: cpfAuth } = req.appPaisAuth;

    const alunoId      = Number(req.query.aluno_id);
    const disciplinaId = Number(req.query.disciplina_id);
    const bimestre     = Number(req.query.bimestre);

    // ano_letivo opcional: se nao vier, usamos o ano corrente
    const anoLetivo = req.query.ano_letivo ? Number(req.query.ano_letivo) : new Date().getFullYear();

    if (!alunoId || Number.isNaN(alunoId)) {
      return res.status(400).json({ message: "Parametro aluno_id invalido." });
    }
    if (!disciplinaId || Number.isNaN(disciplinaId)) {
      return res.status(400).json({ message: "Parametro disciplina_id invalido." });
    }

    // DEMO-APPLE bypass - retorna objetivos de exemplo com topicos e subitens
    if (cpfAuth === '00000000019') {
      const DEMO_OBJETIVOS = {
        1: [
          { texto: "Compreender os diferentes generos textuais e suas funcoes comunicativas", subitens: ["Narrativo: conto, cronica, fabula", "Descritivo: descricao de pessoas e lugares", "Argumentativo: artigo de opiniao"] },
          { texto: "Desenvolver habilidades de leitura e interpretacao de texto", subitens: ["Identificacao de tema central", "Inferencias e conclusoes"] },
        ],
        2: [
          { texto: "Dominar as operacoes fundamentais com numeros naturais e inteiros", subitens: ["Adicao e subtracao de inteiros", "Multiplicacao e divisao", "Potenciacao e radiciacao"] },
          { texto: "Resolver situacoes-problema do cotidiano usando operacoes basicas", subitens: [] },
        ],
        3: [
          { texto: "Analisar fenomenos naturais e suas relacoes com o cotidiano", subitens: ["Ciclo da agua e clima", "Ecossistemas brasileiros", "Biodiversidade e preservacao"] },
        ],
        4: [
          { texto: "Consolidar os aprendizados do ano letivo com foco em revisao e aplicacao", subitens: ["Revisao dos principais conteudos", "Avaliacao pratica e contextualizada"] },
        ],
      };
      const objetivosDemo = DEMO_OBJETIVOS[bimestre] || DEMO_OBJETIVOS[1];
      return res.json({
        ok: true,
        ref: { escola_id: null, turma_id: null, disciplina_id: disciplinaId, bimestre, ano_letivo: anoLetivo },
        objetivos: objetivosDemo,
      });
    }

    if (!bimestre || Number.isNaN(bimestre) || bimestre < 1 || bimestre > 4) {
      return res.status(400).json({ message: "Parametro bimestre invalido (1..4)." });
    }
    if (!anoLetivo || Number.isNaN(anoLetivo)) {
      return res.status(400).json({ message: "Parametro ano_letivo invalido." });
    }

    // 1) Resolve escola_id, turma_id e serie com validacao do vinculo
    const [ctx] = await db.query(
      `SELECT
         ra.escola_id,
         a.turma_id,
         t.serie
       FROM responsaveis_alunos ra
       INNER JOIN alunos a ON a.id = ra.aluno_id
       LEFT  JOIN turmas  t ON t.id = a.turma_id
       WHERE ra.responsavel_id = ?
         AND ra.aluno_id = ?
         AND ra.ativo = 1
       LIMIT 1`,
      [responsavel_id, alunoId]
    );

    if (!ctx.length) {
      return res.status(403).json({ message: "Acesso negado para este aluno." });
    }

    const escolaId = ctx[0].escola_id;
    const turmaId  = ctx[0].turma_id;
    const serie    = String(ctx[0].serie || "").trim().toUpperCase();

    if (!turmaId || !serie) {
      return res.json({
        ok: true,
        ref: { escola_id: escolaId, turma_id: null, disciplina_id: disciplinaId, bimestre, ano_letivo: anoLetivo },
        objetivos: [],
      });
    }

    // 2) Busca objetivo_texto em conteudos_plano_itens
    //    Filtro: escola + serie + disciplina + bimestre + ano_letivo
    //    Pode haver multiplas linhas (um por Conteudo SEEDF) -- agrega todas
    const [itensRows] = await db.query(
      `SELECT objetivo_texto
       FROM conteudos_plano_itens
       WHERE escola_id   = ?
         AND serie       = ?
         AND disciplina_id = ?
         AND ano_letivo  = ?
         AND bimestre    = ?
         AND objetivo_texto IS NOT NULL
         AND TRIM(objetivo_texto) != ''
       ORDER BY id ASC
       LIMIT 100`,
      [escolaId, serie, disciplinaId, anoLetivo, bimestre]
    );

    // 3) Helper: parse do texto estruturado "1. Topico\n   - Subitem" em [{texto, subitens}]
    function parseObjetivoTexto(texto) {
      if (!texto) return [];
      const topicos = [];
      let atual = null;
      for (const linha of texto.split('\n')) {
        const tMatch = linha.match(/^\s*\d+[.)]\s+(.+)/);
        const sMatch = linha.match(/^\s*[*\-]\s+(.+)/) || linha.match(/^\s*\u2022\s+(.+)/);
        if (tMatch) {
          atual = { texto: tMatch[1].trim(), subitens: [] };
          topicos.push(atual);
        } else if (sMatch && atual) {
          const sub = sMatch[1].trim();
          if (sub) atual.subitens.push(sub);
        } else {
          const raw = linha.replace(/^[*\-\u2022]\s*/, '').trim();
          if (raw && !atual) {
            atual = { texto: raw, subitens: [] };
            topicos.push(atual);
          } else if (raw && atual && raw !== atual.texto && /^\s{2,}/.test(linha)) {
            atual.subitens.push(raw);
          }
        }
      }
      return topicos;
    }

    // 4) Agrega topicos de todas as linhas
    const objetivos = itensRows.flatMap(row => parseObjetivoTexto(row.objetivo_texto));

    return res.json({
      ok: true,
      ref: { escola_id: escolaId, turma_id: turmaId, disciplina_id: disciplinaId, bimestre, ano_letivo: anoLetivo },
      objetivos,
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em GET /conteudos:", error);
    return res.status(500).json({ message: "Erro ao carregar conteudos." });
  }
});

// ============================================================================
// PASSO 3 — POST /device-token
// - Registra ou atualiza o token do Expo Push Notification (mobile_devices)
// - Para que possamos testar pelo App (educa-mobile)
// ============================================================================
router.post("/device-token", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id } = req.appPaisAuth;
    const { token, plataforma, escola_id } = req.body;

    if (!token) {
      return res.status(400).json({ ok: false, message: "Token Ã© obrigatÃ³rio." });
    }

    if (!escola_id) {
      return res.status(400).json({ ok: false, message: "escola_id Ã© obrigatÃ³rio." });
    }

    // Usaremos ON DUPLICATE KEY UPDATE para garantir uma chave limpa "ativo = 1"
    const plt = plataforma || "expo";

    const sql = `
      INSERT INTO mobile_devices (responsavel_id, escola_id, plataforma, device_token, ativo)
      VALUES (?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE ativo = 1, plataforma = VALUES(plataforma)
    `;

    await db.query(sql, [responsavel_id, escola_id, plt, token]);

    return res.json({ ok: true, message: "Device token registrado com sucesso!" });
  } catch (error) {
    console.error("[APP_PAIS] Erro ao registrar device token:", error);
    return res.status(500).json({ ok: false, message: "Erro ao registrar token do dispositivo." });
  }
});

// ============================================================================
// GET /api/app-pais/registros
// Retorna registros pedagÃ³gicos e disciplinares do aluno para o responsÃ¡vel
// Querystring: aluno_id, ano (opcional), tipo (pedagogico|disciplinar|all)
// ============================================================================
router.get("/registros", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id, cpf: cpfAuth } = req.appPaisAuth;

    const aluno_id = Number(req.query?.aluno_id);
    const ano      = req.query?.ano ? Number(req.query.ano) : null;
    const tipo     = req.query?.tipo || "all"; // "pedagogico" | "disciplinar" | "all"

    if (!Number.isFinite(aluno_id)) {
      return res.status(400).json({ message: "aluno_id Ã© obrigatÃ³rio." });
    }

    // ── DEMO-APPLE bypass
    if (cpfAuth === '00000000019') {
      return res.json({ ok: true, pedagogicos: [], disciplinares: [], registros: [] });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // 1) Valida vÃ­nculo ativo
    const [[vinculo]] = await db.query(
      `SELECT escola_id
       FROM responsaveis_alunos
       WHERE responsavel_id = ? AND aluno_id = ? AND ativo = 1
       LIMIT 1`,
      [responsavel_id, aluno_id]
    );

    if (!vinculo) {
      return res.status(403).json({ message: "Acesso negado a este estudante." });
    }

    const escola_id = Number(vinculo.escola_id);
    const anoFiltro = Number.isFinite(ano) ? ano : null;

    // â”€â”€ 2) DISCIPLINARES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let disciplinares = [];
    if (tipo === "disciplinar" || tipo === "all") {
      const params = [escola_id, aluno_id];
      let sql = `
        SELECT
          o.id,
          'disciplinar'                          AS tipo,
          COALESCE(o.tipo_ocorrencia, 'Disciplinar') AS titulo,
          DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y') AS data,
          COALESCE(o.motivo, o.descricao, '')    AS resumo,
          COALESCE(o.descricao, o.motivo, '')    AS texto_completo,
          o.status,
          o.data_ocorrencia
        FROM ocorrencias_disciplinares o
        WHERE o.escola_id = ? AND o.aluno_id = ?
          AND o.status != 'CANCELADA'
      `;
      if (anoFiltro) {
        sql += " AND YEAR(o.data_ocorrencia) = ?";
        params.push(anoFiltro);
      }
      sql += " ORDER BY o.data_ocorrencia DESC LIMIT 100";
      const [rows] = await db.query(sql, params);
      disciplinares = rows;
    }

    // â”€â”€ 3) PEDAGÃ“GICOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Tenta buscar de tabela dedicada (se existir). Fallback silencioso.
    let pedagogicos = [];
    if (tipo === "pedagogico" || tipo === "all") {
      try {
        const params = [escola_id, aluno_id];
        let sql = `
          SELECT
            rp.id,
            'pedagogico'                                  AS tipo,
            COALESCE(rp.titulo, 'Registro PedagÃ³gico')   AS titulo,
            DATE_FORMAT(rp.data_registro, '%d/%m/%Y')    AS data,
            COALESCE(rp.resumo, rp.descricao, '')        AS resumo,
            COALESCE(rp.descricao, rp.resumo, '')        AS texto_completo,
            rp.data_registro
          FROM registros_pedagogicos rp
          WHERE rp.escola_id = ? AND rp.aluno_id = ?
        `;
        if (anoFiltro) {
          sql += " AND YEAR(rp.data_registro) = ?";
          params.push(anoFiltro);
        }
        sql += " ORDER BY rp.data_registro DESC LIMIT 100";
        const [rows] = await db.query(sql, params);
        pedagogicos = rows;
      } catch (e) {
        // Tabela nÃ£o existente ainda â€” retorna vazio sem quebrar
        console.warn("[APP_PAIS] Tabela registros_pedagogicos nÃ£o encontrada:", e.code);
        pedagogicos = [];
      }
    }

    // â”€â”€ 4) Anos disponÃ­veis (para o seletor) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const [anosRows] = await db.query(
      `SELECT DISTINCT YEAR(data_ocorrencia) AS ano
       FROM ocorrencias_disciplinares
       WHERE escola_id = ? AND aluno_id = ? AND status != 'CANCELADA'
       ORDER BY ano DESC`,
      [escola_id, aluno_id]
    );
    const anos = anosRows.map(r => Number(r.ano));

    return res.json({
      ok: true,
      aluno_id,
      escola_id,
      anos,
      disciplinares,
      pedagogicos,
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /registros:", error);
    return res.status(500).json({ message: "Erro ao carregar registros." });
  }
});

/**
 * mountToApp â€” registra as rotas do app_pais DIRETAMENTE no app Express,
 * chamando app.get/app.post _dentro_ deste mÃ³dulo (sem cross-module extraction).
 * Workaround para bug do Express 5 com app.use(router) em ambiente Docker/DO.
 *
 * @param {import('express').Application} app
 */
export function mountToApp(app, prefix = "") {
  let count = 0;
  for (const layer of router.stack ?? []) {
    const route = layer.route;
    if (!route?.path || !route?.methods) continue;
    for (const [method, active] of Object.entries(route.methods)) {
      if (!active || typeof app[method] !== "function") continue;
      const handlers = route.stack.map((l) => l.handle);
      if (!handlers.length) continue;
      const fullPath = prefix + route.path;
      if (count < 6) console.log(`[MOUNTTOAPP] #${count} method="${method}" path="${fullPath}" handlers=${handlers.length}`);
      app[method](fullPath, ...handlers);
      count++;
    }
  }
  console.log(`[APP_PAIS] mountToApp: ${count} rotas registradas em app com prefix='${prefix}'.`);
}

export default router;

