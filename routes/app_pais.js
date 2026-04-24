// routes/app_pais.js — v4 (2026-04-24: Resend HTTP API, sem SMTP)
import express from "express";
import PDFDocument from "pdfkit";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import { getSignedGetObjectUrl } from "../storage/spacesUpload.js";

const APP_PAIS_VERSION = "v4-resend-2026-04-24";
console.log("[APP_PAIS] Módulo carregado:", APP_PAIS_VERSION);


const router = express.Router();

// ============================================================================
// CONFIG — JWT APP PAIS
// ============================================================================
const APP_PAIS_JWT_SECRET =
  process.env.APP_PAIS_JWT_SECRET || "DEV_ONLY__CHANGE_ME_APP_PAIS_JWT_SECRET";

const APP_PAIS_JWT_EXPIRES_IN = process.env.APP_PAIS_JWT_EXPIRES_IN || "7d"; // 7 dias
const APP_PAIS_JWT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7; // 7 dias (para o frontend)

if (!process.env.APP_PAIS_JWT_SECRET) {
  console.warn(
    "[APP_PAIS][JWT] APP_PAIS_JWT_SECRET não definido no .env. Usando fallback DEV_ONLY__... (NÃO usar em produção)."
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

  // Se já vier absoluto (http/https) ou já vier com /uploads, respeita.
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

  // Caso 2: já vem como "/uploads/..."
  if (s.startsWith("/uploads/")) return s.slice(1);

  // Caso 3: já vem como "uploads/..."
  if (s.startsWith("uploads/")) return s;

  return null;
}

function authAppPais(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const parts = auth.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "Token ausente ou inválido." });
    }

    const token = parts[1];
    const decoded = jwt.verify(token, APP_PAIS_JWT_SECRET);
    req.appPaisAuth = decoded;

    return next();
  } catch (err) {
    return res.status(401).json({ message: "Token inválido ou expirado." });
  }
}

// ============================================================================
// PASSO 2.3.1 — Helpers de Credenciais (master)
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
    const err = new Error("Acesso negado: você não é master neste estudante.");
    err.status = 403;
    err.code = "NAO_MASTER_NO_CONTEXTO";
    throw err;
  }
}

// ============================================================================
// E-MAIL VIA RESEND API (HTTP, sem SMTP — funciona em qualquer cloud)
// Env vars: RESEND_API_KEY, RESEND_FROM
// Alternativa: SMTP_HOST/PORT/USER/PASS (nodemailer) — fallback se sem Resend
// ============================================================================
async function enviarCodigoPorEmail(email, codigo) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM = process.env.RESEND_FROM || "onboarding@resend.dev";

  const subject = "Código de acesso - APP Pais EDUCA.MELHOR";
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#1a56db">EDUCA.MELHOR — APP Pais</h2>
      <p>Seu código de acesso é:</p>
      <div style="font-size:2.5rem;font-weight:bold;letter-spacing:8px;color:#111;margin:16px 0">${codigo}</div>
      <p style="color:#555">Este código expira em <strong>10 minutos</strong>. Não compartilhe com ninguém.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="font-size:0.75rem;color:#aaa">EDUCA.MELHOR Sistema Educacional</p>
    </div>
  `;
  const text = `Seu código de acesso é: ${codigo}\n\nEste código expira em 10 minutos.`;

  if (RESEND_API_KEY) {
    // ━━━ PRIORIDADE: Resend HTTP API (não usa SMTP, nunca bloqueado) ━━━━━━━━━━━━━━━━━
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

  // ━━━ FALLBACK: SMTP via nodemailer (pode ser bloqueado em alguns ambientes) ━━━━━
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
      return res.status(404).json({ message: "Responsável não encontrado." });
    }

    return res.json({ ok: true, responsavel: rows[0] });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /me:", error);
    return res.status(500).json({ message: "Erro ao carregar sessão." });
  }
});

// ============================================================================
// GET /alunos (Home)
// ============================================================================
router.get("/alunos", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id } = req.appPaisAuth;

    // ✅ CONTRATO (APP PAIS)
    // "Entrada hoje" é derivada de presencas_diarias (1 linha por aluno/dia/escola).
    // Consolidação/atualização é responsabilidade do MÓDULO MONITORAMENTO.
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
// OPÇÃO B (LGPD forte) — GET /alunos/:id/foto-url
// - Bucket privado: App Pais pede URL assinada temporária
// - Valida vínculo responsaveis_alunos (ativo=1) + escola_id do vínculo
// ============================================================================
router.get("/alunos/:id/foto-url", authAppPais, async (req, res) => {
  const db = pool;

  try {
    const { responsavel_id } = req.appPaisAuth;
    const aluno_id = Number(req.params?.id);

    if (!Number.isFinite(aluno_id)) {
      return res.status(400).json({ ok: false, message: "aluno_id inválido." });
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

    if (!objectKey) {
      return res.status(404).json({ ok: false, message: "Foto não disponível para este estudante." });
    }

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
// PASSO 3.1 — GET /boletim (App Pais)
// - Retorna notas do aluno para o responsável logado
// - Valida vínculo em responsaveis_alunos (ativo=1) e permissão pode_ver_boletim
// Querystring:
//   /api/app-pais/boletim?aluno_id=2&ano=2024   (ano opcional)
// ============================================================================
router.get("/boletim", authAppPais, async (req, res) => {
  const db = pool;

  try {
    const { responsavel_id } = req.appPaisAuth;

    const aluno_id = Number(req.query?.aluno_id);
    const ano = req.query?.ano != null ? Number(req.query.ano) : null;

    if (!Number.isFinite(aluno_id)) {
      return res.status(400).json({ message: "aluno_id é obrigatório." });
    }

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
    const { responsavel_id } = req.appPaisAuth;

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

    // Agrupa por escola para facilitar o frontend
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
// POST /solicitar-codigo
// ============================================================================
router.post("/solicitar-codigo", async (req, res) => {
  console.log("[SOLICITAR-CODIGO] Handler chamado! body:", JSON.stringify(req.body ?? null));
  const db = pool;
  const cpf = normalizarCpf(req.body?.cpf);

  if (!cpf) {
    return res.status(400).json({ message: "CPF é obrigatório." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id, email, status_global FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpf]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Responsável não encontrado." });
    }

    const responsavel = rows[0];

    // ✅ PASSO 2.2.7 — BLOQUEIO: pré-cadastro (pendente) não pode receber código ainda
    // Regra: enquanto não houver e-mail válido (e/ou status não estiver ATIVO),
    // o usuário deve ser orientado a procurar secretaria ou responsável master.
    const email = String(responsavel.email || "").trim();
    const status = String(responsavel.status_global || "").trim().toUpperCase();

    if (!email || status === "PENDENTE") {
      return res.status(403).json({
        code: "CREDENCIAL_PENDENTE",
        message:
          "Seu credenciamento ainda não foi liberado. Procure a secretaria da escola do estudante ou solicite ao responsável já credenciado para liberar seu acesso.",
      });
    }

    const codigo = gerarCodigo();
    ;

    await db.query(
      `
      INSERT INTO app_pais_codigos
        (responsavel_id, codigo, canal, destino, expiracao)
      VALUES (?, ?, 'email', ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))
      `,
      [responsavel.id, codigo, responsavel.email]
    );

    await enviarCodigoPorEmail(responsavel.email, codigo);

    return res.json({ ok: true });
  } catch (error) {
    console.error("[APP_PAIS] Erro em /solicitar-codigo:", error);
    return res.status(500).json({ ok: false, message: "Erro ao enviar código. Tente novamente." });
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

    if (!vinculoAtivo) {
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

  if (!responsavel_id) {
    return res.status(500).json({ message: "Erro ao registrar responsável." });
  }

  // ✅ Abre solicitação ABERTA para cada escola que tenha master
  // (a aprovação final ocorrerá pela secretaria/master no painel)
  const obs =
    observacao ||
    `Parentesco: ${parentesco || "N/I"} | Solicitação via app (pré-login)`;

  for (const m of masters) {
    const escola_id = m.escola_id;

    await db.query(
      `
      INSERT INTO responsaveis_vinculacao_solicitacoes
        (escola_id, responsavel_id, status, observacao)
      VALUES (?, ?, 'ABERTA', ?)
      `,
      [escola_id, responsavel_id, obs]
    );
  }

  return res.json({
    ok: true,
    status: "ABERTA",
    message: "Solicitação registrada. Aguarde autorização.",
    escolas_destino: masters.map((m) => m.escola_id),
  });
});

// ============================================================================
// PASSO 2.3.1 — POST /credenciais/autorizar
// - Master autoriza um CPF (pré-cadastrado) para um estudante específico
// - Permissões ficam no vínculo responsaveis_alunos (escopo: escola + aluno)
// Body:
// {
//   cpf: "00000000000",
//   escola_id: 1,
//   aluno_id: 123,
//   permissoes: {
//     boletim: true,
//     conteudos: true,
//     historico_entrada: true,
//     agenda: true,
//     registros: true,
//     atividades: true,
//     credenciais: false
//   }
// }
// ============================================================================
router.post("/credenciais/autorizar", authAppPais, async (req, res) => {
  const db = pool;

  const { responsavel_id } = req.appPaisAuth;
  const cpf = normalizarCpf(req.body?.cpf);
  const escola_id = Number(req.body?.escola_id);
  const aluno_id = Number(req.body?.aluno_id);
  const p = req.body?.permissoes || {};

  if (!cpf || !Number.isFinite(escola_id) || !Number.isFinite(aluno_id)) {
    return res.status(400).json({ message: "cpf, escola_id e aluno_id são obrigatórios." });
  }

  try {
    // 1) Confirma que o LOGADO é master nesse contexto (escola+aluno)
    await exigirMasterNoContexto(db, responsavel_id, escola_id, aluno_id);

    // 2) Confirma que o CPF existe (pré-cadastro)
    const [[terceiro]] = await db.query(
      "SELECT id, email, status_global FROM responsaveis WHERE cpf = ? LIMIT 1",
      [cpf]
    );

    if (!terceiro) {
      return res.status(404).json({
        code: "PRECISA_SOLICITAR_CREDENCIAMENTO",
        message: "Esse CPF precisa solicitar o credenciamento no EDUCA.MELHOR.",
      });
    }

    // 3) Monta flags (campos existentes no seu SELECT do /alunos)
    // Observação: conteudos/registros/atividades podem exigir colunas novas (ver nota abaixo).
    const pode_ver_boletim = !!p.boletim;
    const pode_ver_agenda = !!p.agenda;
    const pode_ver_frequencia = !!p.historico_entrada;
    const pode_receber_notificacoes = true; // default seguro (pode evoluir depois)
    const pode_autorizar_terceiros = !!p.credenciais;

    // 4) Upsert do vínculo (se existir, atualiza; se não, cria)
    const [[existeVinculo]] = await db.query(
      `
      SELECT id
      FROM responsaveis_alunos
      WHERE responsavel_id = ?
        AND escola_id = ?
        AND aluno_id = ?
      LIMIT 1
      `,
      [terceiro.id, escola_id, aluno_id]
    );

    if (!existeVinculo) {
      await db.query(
        `
        INSERT INTO responsaveis_alunos
          (responsavel_id, escola_id, aluno_id,
           pode_ver_boletim, pode_ver_frequencia, pode_ver_agenda, pode_receber_notificacoes,
           principal, ativo, pode_autorizar_terceiros)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
        `,
        [
          terceiro.id,
          escola_id,
          aluno_id,
          pode_ver_boletim,
          pode_ver_frequencia,
          pode_ver_agenda,
          pode_receber_notificacoes,
          pode_autorizar_terceiros,
        ]
      );
    } else {
      await db.query(
        `
        UPDATE responsaveis_alunos
           SET pode_ver_boletim = ?,
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
    console.error("[APP_PAIS] Erro em /credenciais/autorizar:", error);
    return res.status(error.status || 500).json({
      message: error.message || "Erro ao autorizar credencial.",
      code: error.code || "ERRO_AUTORIZAR_CREDENCIAL",
    });
  }
});


// ============================================================================
// CONTEÚDOS (APP PAIS) — por turma/disciplina/bimestre/ano_letivo
// - Objetivo: retornar "itens" (array de tópicos) para o ConteudosScreen.js
// - Filtro: turma_id é derivado do aluno (alunos.turma_id)
// - Segurança: responsável precisa estar vinculado ao aluno (responsaveis_alunos ativo)
// ============================================================================

router.get("/conteudos/disciplinas", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id } = req.appPaisAuth;
    const alunoId = Number(req.query.aluno_id);

    if (!alunoId || Number.isNaN(alunoId)) {
      return res.status(400).json({ message: "Parâmetro aluno_id inválido." });
    }

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
    const { responsavel_id } = req.appPaisAuth;

    const alunoId = Number(req.query.aluno_id);
    const disciplinaId = Number(req.query.disciplina_id);
    const bimestre = Number(req.query.bimestre);

    // ano_letivo opcional: se não vier, usamos o ano corrente
    const anoLetivo = req.query.ano_letivo ? Number(req.query.ano_letivo) : new Date().getFullYear();

    if (!alunoId || Number.isNaN(alunoId)) {
      return res.status(400).json({ message: "Parâmetro aluno_id inválido." });
    }
    if (!disciplinaId || Number.isNaN(disciplinaId)) {
      return res.status(400).json({ message: "Parâmetro disciplina_id inválido." });
    }
    if (!bimestre || Number.isNaN(bimestre) || bimestre < 1 || bimestre > 4) {
      return res.status(400).json({ message: "Parâmetro bimestre inválido (1..4)." });
    }
    if (!anoLetivo || Number.isNaN(anoLetivo)) {
      return res.status(400).json({ message: "Parâmetro ano_letivo inválido." });
    }

    // 1) Resolve escola_id e turma_id com validação do vínculo
    const [ctx] = await db.query(
      `
      SELECT
        ra.escola_id,
        a.turma_id
      FROM responsaveis_alunos ra
      INNER JOIN alunos a ON a.id = ra.aluno_id
      WHERE ra.responsavel_id = ?
        AND ra.aluno_id = ?
        AND ra.ativo = 1
      LIMIT 1
      `,
      [responsavel_id, alunoId]
    );

    if (!ctx.length) {
      return res.status(403).json({ message: "Acesso negado para este aluno." });
    }

    const escolaId = ctx[0].escola_id;
    const turmaId = ctx[0].turma_id;

    if (!turmaId) {
      return res.json({
        ok: true,
        ref: { escola_id: escolaId, turma_id: null, disciplina_id: disciplinaId, bimestre, ano_letivo: anoLetivo },
        itens: [],
      });
    }

    // 2) Busca o plano (cabeçalho)
    const [planos] = await db.query(
      `
      SELECT id
      FROM conteudos_planos
      WHERE escola_id = ?
        AND turma_id = ?
        AND disciplina_id = ?
        AND ano_letivo = ?
        AND bimestre = ?
        AND status = 'ATIVO'
      LIMIT 1
      `,
      [escolaId, turmaId, disciplinaId, anoLetivo, bimestre]
    );

    if (!planos.length) {
      return res.json({
        ok: true,
        ref: { escola_id: escolaId, turma_id: turmaId, disciplina_id: disciplinaId, bimestre, ano_letivo: anoLetivo },
        itens: [],
      });
    }

    const planoId = planos[0].id;

    // 3) Busca itens (ordenados) — formato pronto para renderizar em lista
    const [itensRows] = await db.query(
      `
      SELECT ordem, texto
      FROM conteudos_itens
      WHERE plano_id = ?
        AND status = 'ATIVO'
      ORDER BY ordem ASC
      `,
      [planoId]
    );

    const itens = itensRows.map((x) => x.texto);

    return res.json({
      ok: true,
      ref: { escola_id: escolaId, turma_id: turmaId, disciplina_id: disciplinaId, bimestre, ano_letivo: anoLetivo },
      itens,
    });
  } catch (error) {
    console.error("[APP_PAIS] Erro em GET /conteudos:", error);
    return res.status(500).json({ message: "Erro ao carregar conteúdos." });
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
      return res.status(400).json({ ok: false, message: "Token é obrigatório." });
    }

    if (!escola_id) {
      return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });
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
// Retorna registros pedagógicos e disciplinares do aluno para o responsável
// Querystring: aluno_id, ano (opcional), tipo (pedagogico|disciplinar|all)
// ============================================================================
router.get("/registros", authAppPais, async (req, res) => {
  const db = pool;
  try {
    const { responsavel_id } = req.appPaisAuth;

    const aluno_id = Number(req.query?.aluno_id);
    const ano      = req.query?.ano ? Number(req.query.ano) : null;
    const tipo     = req.query?.tipo || "all"; // "pedagogico" | "disciplinar" | "all"

    if (!Number.isFinite(aluno_id)) {
      return res.status(400).json({ message: "aluno_id é obrigatório." });
    }

    // 1) Valida vínculo ativo
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

    // ── 2) DISCIPLINARES ────────────────────────────────────────────────────
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

    // ── 3) PEDAGÓGICOS ──────────────────────────────────────────────────────
    // Tenta buscar de tabela dedicada (se existir). Fallback silencioso.
    let pedagogicos = [];
    if (tipo === "pedagogico" || tipo === "all") {
      try {
        const params = [escola_id, aluno_id];
        let sql = `
          SELECT
            rp.id,
            'pedagogico'                                  AS tipo,
            COALESCE(rp.titulo, 'Registro Pedagógico')   AS titulo,
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
        // Tabela não existente ainda — retorna vazio sem quebrar
        console.warn("[APP_PAIS] Tabela registros_pedagogicos não encontrada:", e.code);
        pedagogicos = [];
      }
    }

    // ── 4) Anos disponíveis (para o seletor) ────────────────────────────────
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
 * mountToApp — registra as rotas do app_pais DIRETAMENTE no app Express,
 * chamando app.get/app.post _dentro_ deste módulo (sem cross-module extraction).
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

