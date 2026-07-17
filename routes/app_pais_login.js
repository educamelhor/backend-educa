// routes/app_pais_login.js
// Router PÚBLICO para autenticação do responsável — sem middleware de auth.
// Segue o mesmo padrão de app_aluno_auth.js que funciona no Express 5 + Docker/DO.
// Registrado com app.use("/api/app-pais", ...) em server.js, antes de qualquer
// middleware autenticado.
//
// Rotas incluídas (todas pré-autenticação, sem token):
//   POST /solicitar-codigo
//   POST /salvar-email
//   POST /salvar-telefone
//   POST /verificar-codigo
//   GET  /credencial/contexto
//   POST /credencial/pre-cadastro
//   POST /credencial/solicitar

import express from "express";
import jwt     from "jsonwebtoken";
import pool    from "../db.js";

const router = express.Router();

// ── JWT ─────────────────────────────────────────────────────────────────────
const APP_PAIS_JWT_SECRET =
  process.env.APP_PAIS_JWT_SECRET || "DEV_ONLY__CHANGE_ME_APP_PAIS_JWT_SECRET";
const APP_PAIS_JWT_EXPIRES_IN         = process.env.APP_PAIS_JWT_EXPIRES_IN || "7d";
const APP_PAIS_JWT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizarCpf(cpf) {
  return String(cpf ?? "").replace(/\D/g, "").trim();
}
function normalizarCodigo(c) {
  return String(c ?? "").trim();
}
function gerarCodigo() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function mascaraEmail(email) {
  if (!email || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}
function mascaraTelefone(tel) {
  if (!tel) return null;
  const d = String(tel).replace(/\D/g, "");
  if (d.length < 10) return null;
  return `(${d.slice(0, 2)}) 9****-${d.slice(-4)}`;
}
function gerarTokenSessaoResponsavel(responsavel) {
  return jwt.sign(
    { tipo: "RESPONSAVEL", responsavel_id: responsavel.id, cpf: responsavel.cpf },
    APP_PAIS_JWT_SECRET,
    { expiresIn: APP_PAIS_JWT_EXPIRES_IN }
  );
}

// ── Envio de e-mail via Resend (com fallback SMTP) ───────────────────────────
async function enviarCodigoPorEmail(email, codigo) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM    = process.env.RESEND_FROM || "onboarding@resend.dev";

  const subject = "Código de acesso - APP Pais EDUCA.MELHOR";
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#1a56db">EDUCA.MELHOR – APP Pais</h2>
      <p>Seu código de acesso é:</p>
      <div style="font-size:2.5rem;font-weight:bold;letter-spacing:8px;color:#111;margin:16px 0">${codigo}</div>
      <p style="color:#555">Este código expira em <strong>10 minutos</strong>. Não compartilhe com ninguém.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="font-size:0.75rem;color:#aaa">EDUCA.MELHOR Sistema Educacional</p>
    </div>
  `;
  const text = `Seu código de acesso é: ${codigo}\n\nEste código expira em 10 minutos.`;

  if (RESEND_API_KEY) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [email], subject, html, text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error("[APP_PAIS_LOGIN][RESEND] Erro:", resp.status, body);
      throw new Error(`RESEND_ERROR:${resp.status}:${body}`);
    }
    const data = await resp.json();
    console.log("[APP_PAIS_LOGIN][RESEND] E-mail enviado:", data?.id);
    return;
  }

  // Fallback SMTP
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.error("[APP_PAIS_LOGIN][EMAIL] Nenhum provedor de e-mail configurado.");
    throw new Error("EMAIL_NAO_CONFIGURADO: defina RESEND_API_KEY no painel do DigitalOcean.");
  }
  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  const info = await transporter.sendMail({
    from: `"EDUCA.MELHOR" <${SMTP_USER}>`,
    to: email, subject, html, text,
  });
  console.log("[APP_PAIS_LOGIN][SMTP] E-mail enviado:", info.messageId);
}

// ── Envio de SMS via Twilio ───────────────────────────────────────────────────
async function enviarCodigoPorSms(telefone, codigo) {
  const SID   = process.env.TWILIO_SID;
  const TOKEN = process.env.TWILIO_TOKEN;
  const FROM  = process.env.TWILIO_PHONE;
  if (!SID || !TOKEN || !FROM) throw new Error("SMS_NAO_CONFIGURADO");
  const digitos = String(telefone || "").replace(/\D/g, "");
  const e164    = digitos.startsWith("55") ? `+${digitos}` : `+55${digitos}`;
  const appHash = process.env.SMS_APP_HASH || "";
  const body = `<#> EDUCA.MELHOR\nSeu código de acesso: ${codigo}\nVálido por 10 min.${appHash ? `\n${appHash}` : ""}`;
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
  if (!resp.ok) throw new Error(`TWILIO_ERROR:${resp.status}:${data?.message || ""}`);
  console.log("[APP_PAIS_LOGIN][SMS] Enviado para", e164, "SID:", data?.sid);
}

// ============================================================================
// POST /solicitar-codigo
// Solicita código de acesso por e-mail ou SMS (pré-login, sem token).
// ============================================================================
router.post("/solicitar-codigo", async (req, res) => {
  console.log("[APP_PAIS_LOGIN][SOLICITAR-CODIGO] body:", JSON.stringify(req.body ?? null));
  const db    = pool;
  const cpf   = normalizarCpf(req.body?.cpf);
  const canal = String(req.body?.canal || "email").toLowerCase();

  if (!cpf) return res.status(400).json({ message: "CPF é obrigatório." });

  // Demo Apple App Store
  if (cpf === "00000000019") {
    console.log("[APP_PAIS_LOGIN][DEMO] Conta revisão Apple — bypass");
    return res.json({ ok: true });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, email, telefone_celular, status_global FROM responsaveis WHERE cpf = ? LIMIT 1`,
      [cpf]
    );
    if (!rows.length) return res.status(404).json({ message: "Responsável não encontrado." });

    const responsavel = rows[0];
    const email    = String(responsavel.email || "").trim();
    const telefone = String(responsavel.telefone_celular || "").trim();
    const status   = String(responsavel.status_global || "").trim().toUpperCase();

    if (status === "PENDENTE") {
      return res.status(403).json({
        code: "CREDENCIAL_PENDENTE",
        message: "Seu credenciamento ainda não foi liberado. Procure a secretaria da escola do estudante ou solicite ao responsável já credenciado para liberar seu acesso.",
      });
    }

    const [[{ comConsentimento }]] = await db.query(
      `SELECT COUNT(*) AS comConsentimento FROM responsaveis_alunos WHERE responsavel_id = ? AND ativo = 1 AND consentimento_imagem = 1`,
      [responsavel.id]
    );
    if (comConsentimento === 0) {
      return res.status(403).json({
        code: "TERMO_PENDENTE",
        message: "Para acessar o EDUCA MOBILE, você precisa assinar o Termo de Consentimento Específico. Você pode assinar digitalmente agora, ou comparecer à escola para assinar fisicamente.",
      });
    }

    if (canal === "email" && !email) {
      return res.status(403).json({
        code: "PRECISA_EMAIL",
        message: "Informe seu e-mail para receber o código de acesso.",
        tem_sms: !!(telefone && process.env.TWILIO_SID),
        telefone_mascara: mascaraTelefone(telefone) || null,
      });
    }

    if (canal === "sms") {
      if (!process.env.TWILIO_SID) {
        return res.status(503).json({ code: "SMS_NAO_CONFIGURADO", message: "Envio por SMS temporariamente indisponível. Use e-mail." });
      }
      return res.status(202).json({
        code: "CONFIRMAR_TELEFONE",
        message: telefone
          ? "Confirme ou atualize o número de celular para receber o código."
          : "Informe seu número de celular para receber o código por SMS.",
        telefone_mascara: mascaraTelefone(telefone) || null,
        tem_telefone: !!telefone,
      });
    }

    const codigo  = gerarCodigo();
    const destino = canal === "sms" ? telefone : email;

    await db.query(
      `INSERT INTO app_pais_codigos (responsavel_id, codigo, canal, destino, expiracao) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
      [responsavel.id, codigo, canal, destino]
    );

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
    console.error("[APP_PAIS_LOGIN] Erro em /solicitar-codigo:", error);
    return res.status(500).json({ ok: false, message: "Erro ao enviar código. Tente novamente." });
  }
});

// ============================================================================
// POST /salvar-email  — salva e-mail do responsável antes do login (sem token)
// ============================================================================
router.post("/salvar-email", async (req, res) => {
  const db       = pool;
  const cpf      = normalizarCpf(req.body?.cpf);
  const emailRaw = String(req.body?.email || "").trim().toLowerCase();

  if (!cpf) return res.status(400).json({ message: "CPF é obrigatório." });
  if (!emailRaw || !emailRaw.includes("@") || !emailRaw.includes("."))
    return res.status(400).json({ message: "Informe um e-mail válido." });

  try {
    const [[resp]] = await db.query(
      "SELECT id, status_global FROM responsaveis WHERE cpf = ? LIMIT 1", [cpf]
    );
    if (!resp) return res.status(404).json({ message: "Responsável não encontrado." });

    await db.query("UPDATE responsaveis SET email = ? WHERE id = ?", [emailRaw, resp.id]);
    console.log(`[APP_PAIS_LOGIN][SALVAR-EMAIL] E-mail atualizado para responsável ${resp.id}`);

    return res.json({ ok: true, message: "E-mail salvo com sucesso.", email_mascara: mascaraEmail(emailRaw) });
  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em /salvar-email:", error);
    return res.status(500).json({ message: "Erro ao salvar e-mail. Tente novamente." });
  }
});

// ============================================================================
// POST /salvar-telefone — salva celular do responsável antes do login (sem token)
// ============================================================================
router.post("/salvar-telefone", async (req, res) => {
  const db     = pool;
  const cpf    = normalizarCpf(req.body?.cpf);
  const telRaw = String(req.body?.telefone || "").replace(/\D/g, "").trim();

  if (!cpf) return res.status(400).json({ message: "CPF é obrigatório." });
  if (!telRaw || telRaw.length < 10 || telRaw.length > 11)
    return res.status(400).json({ message: "Informe um número de celular válido (com DDD)." });

  try {
    const [[resp]] = await db.query(
      "SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1", [cpf]
    );
    if (!resp) return res.status(404).json({ message: "Responsável não encontrado." });

    await db.query("UPDATE responsaveis SET telefone_celular = ? WHERE id = ?", [telRaw, resp.id]);
    console.log(`[APP_PAIS_LOGIN][SALVAR-TEL] Telefone atualizado para responsável ${resp.id}`);

    return res.json({ ok: true, message: "Telefone salvo com sucesso.", telefone_mascara: mascaraTelefone(telRaw) });
  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em /salvar-telefone:", error);
    return res.status(500).json({ message: "Erro ao salvar telefone. Tente novamente." });
  }
});

// ============================================================================
// POST /verificar-codigo — verifica OTP e retorna JWT de sessão (sem token prévio)
// ============================================================================
router.post("/verificar-codigo", async (req, res) => {
  const db     = pool;
  const cpf    = normalizarCpf(req.body?.cpf);
  const codigo = normalizarCodigo(req.body?.codigo);

  if (!cpf || !codigo) return res.status(400).json({ message: "CPF e código são obrigatórios." });

  // Demo Apple App Store
  if (cpf === "00000000019" && codigo === "000000") {
    try {
      const [[demoResp]] = await db.query(
        "SELECT id, nome, cpf, email FROM responsaveis WHERE cpf = '00000000019' LIMIT 1"
      );
      if (!demoResp) return res.status(500).json({ message: "Conta demo não configurada." });
      return res.json({ ok: true, token: gerarTokenSessaoResponsavel(demoResp), expires_in: APP_PAIS_JWT_EXPIRES_IN_SECONDS, responsavel: demoResp });
    } catch (err) {
      return res.status(500).json({ message: "Erro na conta demo." });
    }
  }

  try {
    const [[responsavel]] = await db.query(
      "SELECT id, nome, cpf, email FROM responsaveis WHERE cpf = ? LIMIT 1", [cpf]
    );
    if (!responsavel) return res.status(404).json({ message: "Responsável não encontrado." });

    const [[registro]] = await db.query(
      `SELECT * FROM app_pais_codigos WHERE responsavel_id = ? AND codigo = ? ORDER BY id DESC LIMIT 1`,
      [responsavel.id, codigo]
    );
    if (!registro) return res.status(400).json({ message: "Código inválido." });
    if (new Date(registro.expiracao) < new Date()) return res.status(400).json({ message: "Código expirado." });

    await db.query("UPDATE app_pais_codigos SET usado_em = NOW() WHERE id = ?", [registro.id]);

    // Verificação de vínculo ativo
    const [[vinculoAtivo]] = await db.query(
      `SELECT 1 FROM responsaveis_alunos WHERE responsavel_id = ? AND ativo = 1 LIMIT 1`,
      [responsavel.id]
    );
    if (!vinculoAtivo && cpf !== "00000000019") {
      return res.status(403).json({
        message: "Cadastro encontrado, porém sem vínculo ativo com aluno. Procure a secretaria da escola para regularizar o credenciamento.",
        code: "SEM_VINCULO_ATIVO",
      });
    }

    const token = gerarTokenSessaoResponsavel(responsavel);
    return res.json({ ok: true, token, expires_in: APP_PAIS_JWT_EXPIRES_IN_SECONDS, responsavel });

  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em /verificar-codigo:", error);
    return res.status(500).json({ ok: false, message: "Erro ao verificar código. Tente novamente." });
  }
});

// ============================================================================
// GET /credencial/contexto — checa se CPF existe e tem master disponível (sem token)
// ============================================================================
router.get("/credencial/contexto", async (req, res) => {
  const db  = pool;
  const cpf = normalizarCpf(req.query?.cpf);
  if (!cpf) return res.status(400).json({ message: "CPF é obrigatório." });

  const [[resp]] = await db.query(
    "SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1", [cpf]
  );
  const [masters] = await db.query(
    `SELECT DISTINCT escola_id FROM responsaveis_alunos WHERE ativo = 1 AND principal = 1 AND pode_autorizar_terceiros = 1 ORDER BY escola_id ASC`
  );

  return res.json({ ok: true, cpf_existe: !!resp, tem_master: masters.length > 0, escolas_master: masters.map(m => m.escola_id) });
});

// ============================================================================
// POST /credencial/pre-cadastro — registra CPF para posterior finalização (sem token)
// ============================================================================
router.post("/credencial/pre-cadastro", async (req, res) => {
  const db      = pool;
  const cpfNorm = normalizarCpf(req.body?.cpf);
  if (!cpfNorm) return res.status(400).json({ message: "CPF é obrigatório." });

  try {
    const [[existente]] = await db.query("SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1", [cpfNorm]);
    if (existente?.id) return res.json({ ok: true, cpf: cpfNorm, responsavel_id: existente.id, ja_existia: true });

    await db.query(
      `INSERT INTO responsaveis (cpf, nome, email, status_global) VALUES (?, 'PENDENTE', NULL, 'PENDENTE')`,
      [cpfNorm]
    );
    const [[novo]] = await db.query("SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1", [cpfNorm]);
    return res.json({ ok: true, cpf: cpfNorm, responsavel_id: novo?.id || null, ja_existia: false });
  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em /credencial/pre-cadastro:", error);
    return res.status(500).json({ message: "Erro ao registrar pré-cadastro." });
  }
});

// ============================================================================
// POST /credencial/solicitar — abre solicitação de credenciamento (sem token)
// ============================================================================
router.post("/credencial/solicitar", async (req, res) => {
  const db = pool;
  const { cpf, nome, email, parentesco, observacao } = req.body;
  if (!cpf || !nome) return res.status(400).json({ message: "CPF e nome são obrigatórios." });

  const cpfNorm = normalizarCpf(cpf);
  const [masters] = await db.query(
    `SELECT DISTINCT escola_id FROM responsaveis_alunos WHERE ativo = 1 AND principal = 1 AND pode_autorizar_terceiros = 1 ORDER BY escola_id ASC`
  );
  if (!masters.length) {
    return res.status(403).json({ status: "SEM_MASTER", message: "Procure a secretaria da escola para realizar o credenciamento." });
  }

  await db.query(
    `INSERT INTO responsaveis (cpf, nome, email, status_global) VALUES (?, ?, ?, 'ATIVO') ON DUPLICATE KEY UPDATE nome = VALUES(nome), email = VALUES(email)`,
    [cpfNorm, String(nome).toUpperCase(), email || null]
  );
  const [[respRow]] = await db.query("SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1", [cpfNorm]);
  return res.json({ ok: true, responsavel_id: respRow?.id });
});


// ============================================================================
// AUTENTICAÇÃO INLINE — funciona para token de RESPONSÁVEL ou ALUNO
// ============================================================================
function authAppPaisOuAluno(req, res, next) {
  try {
    const auth  = req.headers.authorization || "";
    const parts = auth.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer")
      return res.status(401).json({ message: "Token ausente." });
    const decoded = jwt.verify(parts[1], APP_PAIS_JWT_SECRET);
    if (decoded.tipo === "ALUNO") req.alunoAuth   = decoded;
    else                          req.appPaisAuth  = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ message: "Token inválido ou expirado." });
  }
}

// ============================================================================
// GET /ranking — proxy para o ranking anual de notas
// ============================================================================
router.get("/ranking", authAppPaisOuAluno, async (req, res) => {
  const db = pool;
  try {
    const alunoId = parseInt(req.query.aluno_id);
    if (!alunoId) return res.status(400).json({ message: "aluno_id ausente" });

    // Se responsavel, valida vinculo
    if (req.appPaisAuth) {
      const { responsavel_id } = req.appPaisAuth;
      const [vinculo] = await db.query(
        "SELECT 1 FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ?",
        [responsavel_id, alunoId]
      );
      if (vinculo.length === 0) return res.status(403).json({ message: "Acesso negado." });
    }

    // Se aluno, valida se é ele mesmo
    if (req.alunoAuth) {
      const authAlunoId = req.alunoAuth.aluno_id;
      if (authAlunoId !== alunoId) return res.status(403).json({ message: "Acesso negado." });
    }

    // Em vez de chamar a rota interna de notas (que exige token de admin/professor e causa 401),
    // vamos calcular o ranking diretamente no banco, usando a mesma lógica de notas.js.
    const anoRef = Number(req.query.ano) || new Date().getFullYear();
    const semNotasObj = { ranking: 0, total_alunos: 0, semNotas: true };
    const emptyRes = { escola: semNotasObj, turma: semNotasObj, serie: semNotasObj, turno: semNotasObj };

    // 1) Dados do aluno: escola_id, turma_id + serie e turno via turmas
    const [alRes] = await db.query(
      `SELECT a.escola_id, a.turma_id, t.serie, t.turno
       FROM alunos a
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.id = ?`,
      [alunoId]
    );
    if (!alRes.length) return res.json(emptyRes);

    const { escola_id, turma_id, serie, turno } = alRes[0];

    // 2) Soma do aluno no ano
    const [somaRes] = await db.query(
      "SELECT SUM(n.nota) AS soma FROM notas n WHERE n.aluno_id = ? AND n.ano = ?",
      [alunoId, anoRef]
    );
    const somaAluno = somaRes[0]?.soma;

    // Helper: calcula ranking em um escopo (WHERE clause fragment)
    async function calcRanking(whereClause, params) {
      // Total de participantes
      const [[{ total }]] = await db.query(
        `SELECT COUNT(*) AS total FROM (
          SELECT a2.id, SUM(n2.nota) AS soma_notas
          FROM alunos a2
          JOIN notas n2 ON n2.aluno_id = a2.id
          LEFT JOIN turmas t2 ON t2.id = a2.turma_id
          WHERE n2.ano = ? ${whereClause}
          GROUP BY a2.id
          HAVING soma_notas IS NOT NULL
        ) x`,
        [anoRef, ...params]
      );

      if (!somaAluno) {
        return { ranking: total || 0, total_alunos: total || 0, semNotas: true };
      }

      // Posição
      const [[{ posicao }]] = await db.query(
        `SELECT COUNT(*) + 1 AS posicao FROM (
          SELECT a2.id, SUM(n2.nota) AS soma_notas
          FROM alunos a2
          JOIN notas n2 ON n2.aluno_id = a2.id
          LEFT JOIN turmas t2 ON t2.id = a2.turma_id
          WHERE n2.ano = ? ${whereClause}
          GROUP BY a2.id
          HAVING soma_notas IS NOT NULL
        ) r
        WHERE r.soma_notas > (
          SELECT SUM(n3.nota) FROM notas n3 WHERE n3.aluno_id = ? AND n3.ano = ?
        )`,
        [anoRef, ...params, alunoId, anoRef]
      );

      return { ranking: posicao || 1, total_alunos: total || 0, semNotas: false };
    }

    // 3) Calcular os 4 rankings
    const [rkEscola, rkTurma, rkSerie, rkTurno] = await Promise.all([
      calcRanking("AND a2.escola_id = ?", [escola_id]),
      calcRanking("AND a2.turma_id = ?", [turma_id]),
      serie
        ? calcRanking("AND a2.escola_id = ? AND t2.serie = ?", [escola_id, serie])
        : Promise.resolve(semNotasObj),
      turno
        ? calcRanking("AND a2.escola_id = ? AND t2.turno = ?", [escola_id, turno])
        : Promise.resolve(semNotasObj),
    ]);

    // Formata para o frontend: { ok: true, ranking: { sala: { label }, serie: { label }, ... } }
    // O frontend (BoletimScreen) espera .label como "195º / 1126" e usa "sala" (não "turma").
    function fmtLabel(rk) {
      if (rk.semNotas) return "Sem notas";
      return `${rk.ranking}º / ${rk.total_alunos}`;
    }

    return res.json({
      ok: true,
      ranking: {
        sala:   { label: fmtLabel(rkTurma),  ...rkTurma },
        serie:  { label: fmtLabel(rkSerie),  ...rkSerie },
        turno:  { label: fmtLabel(rkTurno),  ...rkTurno },
        escola: { label: fmtLabel(rkEscola), ...rkEscola },
      },
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /ranking:", error);
    return res.status(500).json({ message: "Erro interno no servidor." });
  }
});

// GET /boletim — handler completo registrado aqui para evitar o handler
// corrompido que existe em app_pais.js (causava 500 "Erro ao registrar token
// do dispositivo" por concatenação acidental do arquivo).
// Este router (app_pais_login) é montado ANTES do app_pais router em server.js.
// ============================================================================
router.get("/boletim", authAppPaisOuAluno, async (req, res) => {
  const db = pool;
  try {
    // === FLUXO ALUNO ===
    if (req.alunoAuth) {
      const { aluno_id, escola_id } = req.alunoAuth;
      const reqAlunoId = parseInt(req.query.aluno_id);
      if (reqAlunoId && reqAlunoId !== aluno_id)
        return res.status(403).json({ message: "Acesso negado." });
      const ano = req.query.ano ? parseInt(req.query.ano) : null;
      let notasQuery = `SELECT n.ano, n.bimestre, d.nome AS disciplina, n.nota, n.faltas
        FROM notas n INNER JOIN disciplinas d ON d.id = n.disciplina_id
        WHERE n.escola_id = ? AND n.aluno_id = ?`;
      const params = [escola_id, aluno_id];
      if (ano) { notasQuery += " AND n.ano = ?"; params.push(ano); }
      notasQuery += " ORDER BY n.ano DESC, n.bimestre ASC, d.nome ASC";
      const [rows] = await db.query(notasQuery, params);
      return res.json({ ok: true, escola_id, aluno_id, rows });
    }
    // === FIM FLUXO ALUNO ===

    const { responsavel_id, cpf: cpfAuth } = req.appPaisAuth;

    const aluno_id = Number(req.query?.aluno_id);
    const ano      = req.query?.ano != null ? Number(req.query.ano) : null;

    if (!Number.isFinite(aluno_id)) {
      return res.status(400).json({ message: "aluno_id é obrigatório." });
    }

    // ── DEMO-APPLE bypass ────────────────────────────────────────────────────
    if (cpfAuth === "00000000019") {
      return res.json({
        ok: true,
        aluno: "Estudante Demo",
        turma: "Turma Demo",
        escola_id: null,
        rows: [],
        anos: [new Date().getFullYear()],
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // 1) Confirma vínculo ativo + permissão de boletim
    const [[vinculo]] = await db.query(
      `SELECT escola_id, pode_ver_boletim
       FROM responsaveis_alunos
       WHERE responsavel_id = ? AND aluno_id = ? AND ativo = 1
       LIMIT 1`,
      [responsavel_id, aluno_id]
    );

    if (!vinculo) {
      return res.status(403).json({ message: "Acesso negado a este estudante." });
    }
    if (!vinculo.pode_ver_boletim) {
      return res.status(403).json({ message: "Sem permissão para ver boletim." });
    }

    const escola_id = Number(vinculo.escola_id);

    // 2) Busca notas
    const params = [escola_id, aluno_id];
    let sql = `
      SELECT n.ano, n.bimestre, d.nome AS disciplina, n.nota, n.faltas
      FROM notas n
      INNER JOIN disciplinas d ON d.id = n.disciplina_id
      WHERE n.escola_id = ? AND n.aluno_id = ?
    `;
    if (Number.isFinite(ano)) {
      sql += " AND n.ano = ?";
      params.push(ano);
    }
    sql += " ORDER BY n.ano DESC, n.bimestre ASC, d.nome ASC";

    const [rows] = await db.query(sql, params);

    return res.json({ ok: true, escola_id, aluno_id, rows });

  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em GET /boletim:", error);
    return res.status(500).json({ message: "Erro ao carregar boletim." });
  }
});


// ============================================================================
// authAppPais — valida JWT de RESPONSÁVEL apenas (sem suporte a ALUNO)
// ============================================================================
function authAppPais(req, res, next) {
  try {
    const auth  = req.headers.authorization || "";
    const parts = auth.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer")
      return res.status(401).json({ message: "Token ausente." });
    const decoded = jwt.verify(parts[1], APP_PAIS_JWT_SECRET);
    if (decoded.tipo === "ALUNO")
      return res.status(403).json({ message: "Acesso não permitido para este perfil." });
    req.appPaisAuth = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ message: "Token inválido ou expirado." });
  }
}



// ============================================================================
// GET /conteudos/disciplinas — lista disciplinas vinculadas ao aluno/escola
// Registrado aqui pois authAppPaisOuAluno está em escopo incorreto em app_pais.js
// ============================================================================
router.get("/conteudos/disciplinas", authAppPaisOuAluno, async (req, res) => {
  const db = pool;
  const alunoId = Number(req.query.aluno_id);

  if (!alunoId) {
    return res.status(400).json({ message: "aluno_id é obrigatório." });
  }

  try {
    // ── DEMO-APPLE bypass ────────────────────────────────────────────────────
    if (req.appPaisAuth?.cpf === "00000000019") {
      return res.json({ ok: true, disciplinas: [
        { id: 1, nome: "Português" },
        { id: 2, nome: "Matemática" },
        { id: 3, nome: "Ciências" },
        { id: 4, nome: "História" },
        { id: 5, nome: "Geografia" },
        { id: 6, nome: "Artes" },
        { id: 7, nome: "Educação Física" },
      ]});
    }
    // ─────────────────────────────────────────────────────────────────────────

    // 1) Descobre escola_id a partir do vínculo (garante acesso)
    let escolaId = null;
    if (req.alunoAuth) {
      if (req.alunoAuth.aluno_id !== alunoId)
        return res.status(403).json({ message: "Acesso negado." });
      const [[vinc]] = await db.query(
        `SELECT escola_id FROM alunos WHERE id = ? LIMIT 1`, [alunoId]
      );
      if (!vinc) return res.status(403).json({ message: "Acesso negado para este aluno." });
      escolaId = vinc.escola_id;
    } else {
      const { responsavel_id } = req.appPaisAuth;
      const [vinc] = await db.query(
        `SELECT ra.escola_id
         FROM responsaveis_alunos ra
         WHERE ra.responsavel_id = ? AND ra.aluno_id = ? AND ra.ativo = 1
         LIMIT 1`,
        [responsavel_id, alunoId]
      );
      if (!vinc.length) return res.status(403).json({ message: "Acesso negado para este aluno." });
      escolaId = vinc[0].escola_id;
    }

    // 2) Lista disciplinas da escola
    const [rows] = await db.query(
      `SELECT id, nome FROM disciplinas WHERE escola_id = ? ORDER BY nome ASC`,
      [escolaId]
    );

    return res.json({ ok: true, disciplinas: rows });
  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em GET /conteudos/disciplinas:", error);
    return res.status(500).json({ message: "Erro ao carregar disciplinas." });
  }
});

// ============================================================================
// GET /conteudos — retorna objetivos de aprendizagem por disciplina/bimestre
// Registrado aqui pois authAppPaisOuAluno está em escopo incorreto em app_pais.js
// ============================================================================
router.get("/conteudos", authAppPaisOuAluno, async (req, res) => {
  const db = pool;
  try {
    const alunoId      = Number(req.query.aluno_id);
    const disciplinaId = Number(req.query.disciplina_id);
    const bimestre     = Number(req.query.bimestre);
    const anoLetivo    = req.query.ano_letivo ? Number(req.query.ano_letivo) : new Date().getFullYear();

    if (!alunoId || Number.isNaN(alunoId))
      return res.status(400).json({ message: "Parâmetro aluno_id inválido." });
    if (!disciplinaId || Number.isNaN(disciplinaId))
      return res.status(400).json({ message: "Parâmetro disciplina_id inválido." });

    // ── DEMO-APPLE bypass ────────────────────────────────────────────────────
    if (req.appPaisAuth?.cpf === "00000000019") {
      const DEMO_OBJETIVOS = {
        1: [{ texto: "Compreender os diferentes gêneros textuais", subitens: ["Narrativo", "Descritivo", "Argumentativo"] }],
        2: [{ texto: "Dominar as operações fundamentais", subitens: ["Adição e subtração", "Multiplicação e divisão"] }],
        3: [{ texto: "Analisar fenômenos naturais", subitens: ["Ciclo da água", "Ecossistemas brasileiros"] }],
        4: [{ texto: "Consolidar os aprendizados do ano letivo", subitens: ["Revisão dos principais conteúdos"] }],
      };
      return res.json({
        ok: true,
        ref: { escola_id: null, turma_id: null, disciplina_id: disciplinaId, bimestre, ano_letivo: anoLetivo },
        objetivos: DEMO_OBJETIVOS[bimestre] || DEMO_OBJETIVOS[1],
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!bimestre || Number.isNaN(bimestre) || bimestre < 1 || bimestre > 4)
      return res.status(400).json({ message: "Parâmetro bimestre inválido (1..4)." });
    if (!anoLetivo || Number.isNaN(anoLetivo))
      return res.status(400).json({ message: "Parâmetro ano_letivo inválido." });

    // 1) Resolve escola_id, turma_id e série com validação do vínculo
    let ctxResult = [];
    if (req.alunoAuth) {
      const { aluno_id } = req.alunoAuth;
      if (aluno_id !== alunoId) return res.status(403).json({ message: "Acesso negado." });
      [ctxResult] = await db.query(
        `SELECT a.escola_id, a.turma_id, t.serie
         FROM alunos a LEFT JOIN turmas t ON t.id = a.turma_id
         WHERE a.id = ? LIMIT 1`,
        [alunoId]
      );
    } else {
      const { responsavel_id } = req.appPaisAuth;
      [ctxResult] = await db.query(
        `SELECT ra.escola_id, a.turma_id, t.serie
         FROM responsaveis_alunos ra
         INNER JOIN alunos a ON a.id = ra.aluno_id
         LEFT  JOIN turmas  t ON t.id = a.turma_id
         WHERE ra.responsavel_id = ? AND ra.aluno_id = ? AND ra.ativo = 1
         LIMIT 1`,
        [responsavel_id, alunoId]
      );
    }

    if (!ctxResult.length)
      return res.status(403).json({ message: "Acesso negado para este aluno." });

    const escolaId = ctxResult[0].escola_id;
    const turmaId  = ctxResult[0].turma_id;
    const serie    = String(ctxResult[0].serie || "").trim().toUpperCase();

    if (!turmaId || !serie) {
      return res.json({
        ok: true,
        ref: { escola_id: escolaId, turma_id: null, disciplina_id: disciplinaId, bimestre, ano_letivo: anoLetivo },
        objetivos: [],
      });
    }

    // 2) Busca texto em conteudos_objetivos_escola
    const [itensRows] = await db.query(
      `SELECT texto as objetivo_texto
       FROM conteudos_objetivos_escola
       WHERE escola_id   = ?
         AND serie       = ?
         AND disciplina_id = ?
         AND ano_letivo  = ?
         AND bimestre    = ?
         AND texto IS NOT NULL
         AND TRIM(texto) != ''
       ORDER BY id ASC
       LIMIT 100`,
      [escolaId, serie, disciplinaId, anoLetivo, bimestre]
    );

    // 3) Parse do texto estruturado
    function parseObjetivoTexto(texto) {
      if (!texto) return [];
      const topicos = [];
      let atual = null;
      for (const linha of texto.split("\n")) {
        const tMatch = linha.match(/^\s*\d+[.)]\s+(.+)/);
        const sMatch = linha.match(/^\s*[*\-]\s+(.+)/) || linha.match(/^\s*\u2022\s+(.+)/);
        if (tMatch) {
          atual = { texto: tMatch[1].trim(), subitens: [] };
          topicos.push(atual);
        } else if (sMatch && atual) {
          const sub = sMatch[1].trim();
          if (sub) atual.subitens.push(sub);
        } else {
          const raw = linha.replace(/^[*\-\u2022]\s*/, "").trim();
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

    const objetivos = itensRows.flatMap((row) => parseObjetivoTexto(row.objetivo_texto));

    return res.json({
      ok: true,
      ref: { escola_id: escolaId, turma_id: turmaId, disciplina_id: disciplinaId, bimestre, ano_letivo: anoLetivo },
      objetivos,
    });
  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em GET /conteudos:", error);
    return res.status(500).json({ message: "Erro ao carregar conteúdos." });
  }
});

// ============================================================================
// GET /credenciais/contextos — lista estudantes que o responsável master pode
// credenciar. Registrado aqui pois authAppPais ficava em escopo incorreto
// dentro do handler corrompido em app_pais.js → causava 401 loop.
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
        a.id       AS aluno_id,
        a.estudante AS aluno_nome
      FROM responsaveis_alunos ra
      INNER JOIN escolas e ON e.id = ra.escola_id
      INNER JOIN alunos  a ON a.id = ra.aluno_id
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
        aluno_id:   r.aluno_id,
        aluno_nome: r.aluno_nome,
      });
    }

    return res.json({ ok: true, contextos: Array.from(map.values()) });

  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em GET /credenciais/contextos:", error);
    return res.status(500).json({ message: "Erro ao buscar contextos de credenciais." });
  }
});

// ============================================================================
// GET /credenciais/buscar — busca responsável por CPF para credenciamento.
// Registrado aqui pelo mesmo motivo que /credenciais/contextos acima.
// ============================================================================
router.get("/credenciais/buscar", authAppPais, async (req, res) => {
  const db  = pool;
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
    console.error("[APP_PAIS_LOGIN] Erro em GET /credenciais/buscar:", error);
    return res.status(500).json({ message: "Erro ao buscar CPF." });
  }
});

// ============================================================================
// POST /credenciais/autorizar — o responsável MASTER vincula um CPF a um
// aluno com permissões específicas.
// body: { cpf, escola_id, aluno_id, permissoes: { boletim, conteudos, ... } }
// ============================================================================
router.post("/credenciais/autorizar", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id: masterId } = req.appPaisAuth;
    const { cpf, escola_id, aluno_id, permissoes = {} } = req.body;

    const cpfNorm = normalizarCpf(cpf);
    const escolaId = Number(escola_id);
    const alunoId  = Number(aluno_id);

    if (!cpfNorm || !escolaId || !alunoId) {
      return res.status(400).json({ message: "cpf, escola_id e aluno_id são obrigatórios." });
    }

    // 1) Confirma que o master tem permissão para autorizar nesta escola/aluno
    const [[vinculoMaster]] = await db.query(
      `SELECT id FROM responsaveis_alunos
       WHERE responsavel_id = ? AND escola_id = ? AND aluno_id = ?
         AND ativo = 1 AND principal = 1 AND pode_autorizar_terceiros = 1
       LIMIT 1`,
      [masterId, escolaId, alunoId]
    );

    if (!vinculoMaster) {
      return res.status(403).json({
        message: "Você não tem permissão para credenciar nesta escola/estudante.",
      });
    }

    // 2) Garante que o responsável com o CPF existe (cria se necessário)
    await db.query(
      `INSERT INTO responsaveis (cpf, nome, email, status_global)
       VALUES (?, 'PENDENTE', NULL, 'ATIVO')
       ON DUPLICATE KEY UPDATE status_global = IF(status_global = 'PENDENTE', 'ATIVO', status_global)`,
      [cpfNorm]
    );

    const [[respRow]] = await db.query(
      "SELECT id FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpfNorm]
    );
    if (!respRow) {
      return res.status(500).json({ message: "Falha ao localizar o responsável." });
    }
    const novoRespId = respRow.id;

    // 3) Monta os campos de permissão
    const podeVerBoletim        = permissoes.boletim          ? 1 : 0;
    const podeAutorizarTerceiros = permissoes.credenciais      ? 1 : 0;

    // Colunas opcionais — inserimos somente o que sabemos que existe com segurança
    // (conteudos, historico_entrada, agenda, registros, atividades podem precisar de migration)
    // Por ora, usamos pode_ver_boletim como base e pode_autorizar_terceiros para credenciais.
    await db.query(
      `INSERT INTO responsaveis_alunos
         (responsavel_id, aluno_id, escola_id, ativo, principal, pode_ver_boletim, pode_autorizar_terceiros)
       VALUES (?, ?, ?, 1, 0, ?, ?)
       ON DUPLICATE KEY UPDATE
         ativo                   = 1,
         pode_ver_boletim        = VALUES(pode_ver_boletim),
         pode_autorizar_terceiros = VALUES(pode_autorizar_terceiros)`,
      [novoRespId, alunoId, escolaId, podeVerBoletim, podeAutorizarTerceiros]
    );

    return res.json({
      ok: true,
      message: `CPF credenciado com sucesso.`,
      responsavel_id: novoRespId,
    });

  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em POST /credenciais/autorizar:", error);
    return res.status(500).json({ message: "Erro ao autorizar credencial." });
  }
});

// ============================================================================
// GET /registros
// Retorna registros pedagógicos e disciplinares do aluno para o responsável
// Também calcula a pontuação final (se a escola for Cívico-Militar)
// ============================================================================
router.get("/registros", authAppPaisOuAluno, async (req, res) => {
  const db = pool;
  try {
    const isAppPais = !!req.appPaisAuth;
    const authData = isAppPais ? req.appPaisAuth : req.alunoAuth;

    const aluno_id = Number(req.query?.aluno_id);
    const ano      = req.query?.ano ? Number(req.query.ano) : null;
    const tipo     = req.query?.tipo || "all";

    if (!Number.isFinite(aluno_id)) {
      return res.status(400).json({ message: "aluno_id é obrigatório." });
    }

    // Valida vínculo ativo
    let vinculo;
    if (isAppPais) {
      const [[v]] = await db.query(
        `SELECT escola_id
         FROM responsaveis_alunos
         WHERE responsavel_id = ? AND aluno_id = ? AND ativo = 1
         LIMIT 1`,
        [authData.responsavel_id, aluno_id]
      );
      vinculo = v;
    } else {
      const [[v]] = await db.query(
        `SELECT escola_id FROM alunos WHERE id = ? AND status = 'ativo' LIMIT 1`,
        [authData.aluno_id]
      );
      if (v && authData.aluno_id === aluno_id) vinculo = v;
    }

    if (!vinculo) {
      return res.status(403).json({ message: "Acesso negado a este estudante." });
    }

    const escola_id = Number(vinculo.escola_id);
    const anoFiltro = Number.isFinite(ano) ? ano : null;

    // ── 1) VERIFICA TIPO DE ESCOLA (CÍVICO-MILITAR) ──────────────────────────
    const [[escolaRow]] = await db.query('SELECT tipo FROM escolas WHERE id = ?', [escola_id]);
    const escolaTipo = escolaRow?.tipo || "";
    const isCivicoMilitar = escolaTipo.includes("CCMDF") || escolaTipo.includes("Militar");

    // ── 2) PONTUAÇÃO (APENAS PARA CÍVICO-MILITAR) ─────────────────────────────
    let pontuacaoFinal = null;
    if (isCivicoMilitar) {
      function pontosEfetivos(pontoBase, medidaDisciplinar, diasSuspensao) {
        if (String(medidaDisciplinar).trim() === 'Suspensão') {
          return Number(pontoBase) * (Number(diasSuspensao) || 1);
        }
        return Number(pontoBase) || 0;
      }
      const PONTUACAO_INICIAL = 8.00;
      const [allRows] = await db.query(
        `SELECT COALESCE(r.pontos,0) AS pontos,
                COALESCE(r.medida_disciplinar,'') AS medida_disciplinar,
                COALESCE(o.dias_suspensao,1) AS dias_suspensao
         FROM ocorrencias_disciplinares o
         LEFT JOIN registros_ocorrencias r
           ON r.descricao_ocorrencia = o.motivo
           AND (o.tipo_ocorrencia IS NULL OR o.tipo_ocorrencia = '' OR r.tipo_ocorrencia = o.tipo_ocorrencia)
         WHERE o.aluno_id = ? AND o.escola_id = ? AND o.status != 'CANCELADA'`,
        [aluno_id, escola_id]
      );
      const totalPontosGeral = allRows.reduce((s, r) => s + pontosEfetivos(r.pontos, r.medida_disciplinar, r.dias_suspensao), 0);
      pontuacaoFinal = Math.max(0, Math.min(10, PONTUACAO_INICIAL + totalPontosGeral)).toFixed(2);
    }

    // ── 3) DISCIPLINARES ──────────────────────────────────────────────────────
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
          o.data_ocorrencia,
          o.convocar_responsavel,
          DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel
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

    // ── 4) PEDAGÓGICOS (Relatório Pedagógico) ─────────────────────────────────
    let pedagogicos = [];
    if (tipo === "pedagogico" || tipo === "all") {
      try {
        const params = [escola_id, aluno_id];
        let sql = `
          SELECT
            o.id,
            'pedagogico'                                 AS tipo,
            COALESCE(o.categoria, 'Relatório Pedagógico') AS titulo,
            DATE_FORMAT(o.data_ocorrencia, '%d/%m/%Y')   AS data,
            COALESCE(o.motivo, o.descricao, '')          AS resumo,
            COALESCE(o.descricao, o.motivo, '')          AS texto_completo,
            o.data_ocorrencia                            AS data_registro,
            o.convocar_responsavel,
            DATE_FORMAT(o.data_comparecimento_responsavel, '%d/%m/%Y %H:%i') AS data_comparecimento_responsavel
          FROM ocorrencias_pedagogicas o
          WHERE o.escola_id = ? AND o.aluno_id = ?
            AND o.status != 'CANCELADA'
        `;
        if (anoFiltro) {
          sql += " AND YEAR(o.data_ocorrencia) = ?";
          params.push(anoFiltro);
        }
        sql += " ORDER BY o.data_ocorrencia DESC, o.id DESC LIMIT 100";
        const [rows] = await db.query(sql, params);
        pedagogicos = rows;
      } catch (e) {
        console.warn("[APP_PAIS_LOGIN] Erro ao buscar ocorrencias_pedagogicas:", e.code);
        pedagogicos = [];
      }
    }

    // ── 5) Anos disponíveis (para o seletor) ──────────────────────────────────
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
      pontuacao: pontuacaoFinal,
      disciplinares,
      pedagogicos,
    });
  } catch (error) {
    console.error("[APP_PAIS_LOGIN] Erro em GET /registros:", error);
    return res.status(500).json({ message: "Erro ao buscar registros." });
  }
});

// ============================================================================
// POST /devices/register — salva o push token do responsável ou aluno
// ============================================================================
router.post("/devices/register", authAppPaisOuAluno, async (req, res) => {
  const db = pool;
  try {
    const isAppPais = !!req.appPaisAuth;
    const responsavel_id = isAppPais ? req.appPaisAuth.responsavel_id : null;
    const aluno_id = !isAppPais ? req.alunoAuth.aluno_id : null;
    const escola_id = isAppPais ? req.appPaisAuth.escola_id : req.alunoAuth.escola_id;

    const { device_token, plataforma } = req.body;

    if (!device_token || (!responsavel_id && !aluno_id)) {
      return res.status(400).json({ message: "device_token e identificação (responsável ou aluno) são obrigatórios." });
    }

    // Upsert: se token já existir, apenas reativa e atualiza
    await db.query(
      `INSERT INTO mobile_devices
         (responsavel_id, aluno_id, escola_id, device_token, plataforma, ativo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         ativo = 1,
         plataforma = VALUES(plataforma),
         updated_at = NOW()`,
      [responsavel_id, aluno_id, escola_id || null, device_token, plataforma || "unknown"]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[APP_PAIS] Erro em /devices/register:", err);
    return res.status(500).json({ message: "Erro ao registrar device." });
  }
});

export default router;
