// ============================================================================
// server.js — API EDUCA.MELHOR
// ============================================================================
import dotenv from "dotenv";
import express from "express";

import cors from "cors";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import { dirname, join } from "path";


// ============================================================================
// ENV (LOCAL): carrega .env.development (ou .env.production) antes de usar process.env
// Em produção (DO), as variáveis vêm do painel; isso não atrapalha.
// ============================================================================
const __filenameEnv = fileURLToPath(import.meta.url);
const __dirnameEnv = dirname(__filenameEnv);

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";

// carrega arquivo do diretório do server.js (apps/educa-backend)
dotenv.config({ path: join(__dirnameEnv, envFile) });

// ===== JWT SECRET (blindagem) =====
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("❌ JWT_SECRET ausente em produção. Corrija as variáveis de ambiente.");
    process.exit(1);
  } else {
    console.warn("⚠️ JWT_SECRET ausente em desenvolvimento. Usando fallback inseguro (apenas DEV).");
    process.env.JWT_SECRET = "superseguro";
  }
}

// ⬇️ AJUSTE: caminho correto do pool conforme sua estrutura validada
import pool from "./db.js";

// ------------------------- Rotas --------------------------------------------
// ⚠️ MODULAÇÃO (temporariamente OFF)
// Motivo: evitar quebrar o boot em produção enquanto o módulo está incompleto.
// Quando for retomar: reativar imports + app.use abaixo e validar controllers.
import modulacaoRoutes from "./routes/modulacao.js";
import modulacaoDiagnosticoRouter from "./routes/modulacao_diagnostico.js";

// ==========================
// OPTIONAL ROUTES (Feature Flags)
// (evita quebrar o boot quando arquivos/módulos ainda estão em construção)
// ==========================
let ocrRouter = null;
let redacoesRouter = null;
let correcoesOpenAI = null;


import gabaritosRoutes from "./routes/gabaritos.js";
import authRouter from "./routes/auth.js";
import authPlataformaRouter from "./routes/auth_plataforma.js";
import plataformaRouter from "./routes/plataforma.js";
import plataformaUsageRouter from "./routes/plataforma_usage.js";
import gabaritosGeneratorRoutes from "./routes/gabaritosGeneratorRoutes.js";
import gabaritoPdfRouter from "./routes/gabaritoPdf.js";
import gabaritoAvaliacoesRouter from "./routes/gabaritoAvaliacoes.js";
import gabaritoLotesRouter from "./routes/gabaritoLotes.js";
import turnosRouter from "./routes/turnos.js";
import suporteRouter from "./routes/suporte.js";
import notasRouter from "./routes/notas.js";
import avaliacoesRouter from "./routes/avaliacoes.js";
import ferramentasIndexRouter from "./routes/ferramentas/index.js";


// ⚠️ BOLETINS (temporariamente OFF)
// Motivo: dependência pesada (puppeteer) — evitar quebrar boot em produção.
// Reativar quando o ambiente de produção estiver preparado para puppeteer/Chromium.
//// import boletinsRouter from "./routes/boletins.js";

import alunosRouter from "./routes/alunos.js";
import matriculasRouter from "./routes/matriculas.js";
import professoresRouter from "./routes/professores.js";
import disciplinasRouter from "./routes/disciplinas.js";
import turmasRouter from "./routes/turmas.js";
import questoesRouter from "./routes/questoes.js";
import questoesUploadRouter from "./routes/questoesUpload.js";
import escolasRouter from "./routes/escolas.js";
import usuariosRouter, { publicRouter as usuariosPublicRouter } from "./routes/usuarios.js";
import alunosImpressaoRouter from "./routes/alunos_impressao.js";
import codigosRouter from "./routes/codigos.js";
import cargasHorariasRouter from "./routes/cargasHorarias.js";
import registrosOcorrenciasRouter from "./routes/registrosOcorrencias.js";
import responsaveisRouter from "./routes/responsaveis.js";
import termoConsentimentoRouter from "./routes/termo-consentimento.js";
import taceRouter from "./routes/tace.js";
import relatorioDisciplinarRouter from "./routes/relatorio-disciplinar.js";
import gradeBaseRoutes from "./routes/gradeBase.js";
import gradeSolveRoutes from "./routes/gradeSolve.js";
import disponibilidadesRouter from "./routes/disponibilidades.js";
import preferenciasRouter from "./routes/preferencias.js";
import gradeRunMockRouter from "./routes/gradeRunMock.js";
import gradePublishRouter from "./routes/gradePublish.js";
import direcaoRouter from "./routes/direcao.js";

// ------------------------- ROTAS OPCIONAIS (blindadas por Feature Flags) -----
let appPaisRouter = null;
let responsavelRoutes = null;
let deviceRoutes = null;

let captureRoutes = null;

let configPedagogicaRouter = null;
let conteudosAdminRouter = null;

let monitoramentoRouter = null;
let monitoramentoEventoRouter = null;
let monitoramentoOverlayRouter = null;
let monitoramentoAlertaRouter = null;
let monitoramentoPainelRouter = null;
let monitoramentoVisitantesRouter = null;
let monitoramentoCamerasRouter = null;
let monitoramentoEmbeddingsRouter = null;
let monitoramentoIngestRouter = null;
let monitoramentoStream = null;
let monitoramentoUltimosRouter = null;

let agenteEducadfRouter = null;

// Carregamento seguro (NÃO quebra o boot se faltar arquivo)
// Padrão profissional: DEV liga por padrão, PROD desliga por padrão.
// Em produção, só liga se a ENV vier explicitamente.
const DEFAULT_ON_DEV = process.env.NODE_ENV !== "production";

const FF_APP_PAIS = ff("FF_APP_PAIS", DEFAULT_ON_DEV);
const FF_CONFIG_PEDAGOGICA = ff("FF_CONFIG_PEDAGOGICA", DEFAULT_ON_DEV);
const FF_CONTEUDOS_ADMIN = ff("FF_CONTEUDOS_ADMIN", DEFAULT_ON_DEV);

const FF_EDUCA_CAPTURE = ff("FF_EDUCA_CAPTURE", DEFAULT_ON_DEV);

// Monitoramento é pesado/sensível: manter OFF por padrão mesmo em DEV (liga quando for trabalhar nele)
const FF_MONITORAMENTO = ff("FF_MONITORAMENTO", false);

// Agente EducaDF: pesado (Playwright) — OFF por padrão, ligar explicitamente
const FF_AGENTE_EDUCADF = ff("FF_AGENTE_EDUCADF", false);

// ✅ DEBUG (DEV): confirma flags efetivas para eliminar dúvida de "rota não montou porque flag estava OFF"
if (process.env.NODE_ENV !== "production") {
  console.log("[FF] FLAGS efetivas:", {
    FF_APP_PAIS,
    FF_CONFIG_PEDAGOGICA,
    FF_CONTEUDOS_ADMIN,
    FF_MONITORAMENTO,
    FF_AGENTE_EDUCADF,
  });
}

if (FF_AGENTE_EDUCADF) {
  agenteEducadfRouter = await safeImportDefault(
    "FF_AGENTE_EDUCADF",
    "./modules/agente/agente.routes.js"
  );
}

// ✅ NOVAS FLAGS (conforme mapa PROD aprovado)
const FF_GABARITOS = ff("FF_GABARITOS", DEFAULT_ON_DEV);
const FF_GABARITOS_GENERATOR = ff("FF_GABARITOS_GENERATOR", DEFAULT_ON_DEV);
const FF_QUESTOES = ff("FF_QUESTOES", DEFAULT_ON_DEV);

// ✅ Cargas Horárias é CADASTRO BÁSICO (core operacional), independente do solver Urania
const FF_CARGAS_HORARIAS = ff("FF_CARGAS_HORARIAS", DEFAULT_ON_DEV);

// ⚠️ Horários/Grade (Urania/solver) fica separado e pode continuar OFF em produção
const FF_HORARIOS = ff("FF_HORARIOS", DEFAULT_ON_DEV);

if (FF_APP_PAIS && requireEnvForFeature("FF_APP_PAIS", ["APP_PAIS_JWT_SECRET"])) {
  appPaisRouter = await safeImportDefault("FF_APP_PAIS", "./routes/app_pais.js");
  responsavelRoutes = await safeImportDefault(
    "FF_APP_PAIS",
    "./modules/app-pais/responsavel/responsavel.routes.js"
  );
  deviceRoutes = await safeImportDefault(
    "FF_APP_PAIS",
    "./modules/app-pais/device/device.routes.js"
  );
} else if (FF_APP_PAIS) {
  console.warn("[FF] FF_APP_PAIS estava ON, mas foi desativado por falta de ENV obrigatórias.");
}

if (FF_EDUCA_CAPTURE) {
  captureRoutes = await safeImportDefault(
    "FF_EDUCA_CAPTURE",
    "./routes/capture.routes.js"
  );
}


if (FF_CONFIG_PEDAGOGICA) {
  configPedagogicaRouter = await safeImportDefault(
    "FF_CONFIG_PEDAGOGICA",
    "./routes/config_pedagogica.js"
  );
}

if (FF_CONTEUDOS_ADMIN) {
  conteudosAdminRouter =
    (await safeImportDefault("FF_CONTEUDOS_ADMIN", "./routes/conteudos_admin.js")) ||
    (await safeImportDefault("FF_CONTEUDOS_ADMIN", "./conteudos_admin.js")) ||
    (await safeImportDefault("FF_CONTEUDOS_ADMIN", "./api/routes/conteudos_admin.js"));

  if (conteudosAdminRouter) {
    console.log("[FF] Conteúdos Admin: router carregado com sucesso.");
  } else {
    console.warn(
      "[FF] Conteúdos Admin: router NÃO carregado (verifique caminho/arquivo). Rotas /api/conteudos/* ficarão 404."
    );
  }
}

// ✅ Ingest do Worker deve ser independente do FF_MONITORAMENTO (canal básico)
const FF_MONITORAMENTO_INGEST = ff("FF_MONITORAMENTO_INGEST", true);

if (FF_MONITORAMENTO_INGEST) {
  monitoramentoIngestRouter = await safeImportDefault(
    "FF_MONITORAMENTO_INGEST",
    "./routes/monitoramento_ingest.js"
  );
}

// ✅ Embeddings também é canal básico do Worker (usa x-worker-token, não JWT)
// Deve carregar independente de FF_MONITORAMENTO, assim como o ingest.
if (FF_MONITORAMENTO_INGEST) {
  monitoramentoEmbeddingsRouter = await safeImportDefault(
    "FF_MONITORAMENTO_INGEST",
    "./routes/monitoramento_embeddings.js"
  );
}

if (FF_MONITORAMENTO && requireEnvForFeature("FF_MONITORAMENTO", ["MONITORAMENTO_TOKEN_SECRET"])) {
  monitoramentoRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento.js");
  monitoramentoEventoRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_evento.js");
  monitoramentoOverlayRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_overlay.js");
  monitoramentoAlertaRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_alerta.js");
  monitoramentoPainelRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_painel.js");
  monitoramentoVisitantesRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_visitantes.js");
  monitoramentoCamerasRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_cameras.js");
  // embeddings já carregado acima (independente de FF_MONITORAMENTO)
  monitoramentoStream = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_stream.js");
  monitoramentoUltimosRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_ultimos.js");
} else if (FF_MONITORAMENTO) {
  console.warn("[FF] FF_MONITORAMENTO estava ON, mas foi desativado por falta de ENV obrigatórias.");
}


// ------------------------- Middlewares globais ------------------------------
import { autenticarToken } from "./middleware/autenticarToken.js";
import { verificarEscola } from "./middleware/verificarEscola.js";
import { exigirEscopo } from "./middleware/verificarEscopo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();

// ============================================================================
// Feature Flags (Padrão A) + Safe Import (blindagem de módulos em construção)
// ============================================================================
function ff(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase().trim());
}

async function safeImportDefault(flagName, importPath) {
  try {
    const mod = await import(importPath);
    return mod?.default ?? mod;
  } catch (err) {
    console.warn(
      `[FF] ${flagName}: NÃO carregado (${importPath}). Motivo: ${err?.message || err}`
    );
    return null; // não quebra o boot
  }
}

function requireEnvForFeature(flagName, requiredVars = []) {
  const missing = requiredVars.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  if (missing.length) {
    console.warn(
      `[FF] ${flagName}: DESATIVADO automaticamente — faltando ENV obrigatória(s): ${missing.join(", ")}`
    );
    return false;
  }
  return true;
}

// ============================================================================
// CORS + Body
// ============================================================================
const defaultWhitelist = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",

  // ✅ Cadastro (Vite em outra porta)
  "http://localhost:5174",
  "http://127.0.0.1:5174",

  "http://190.107.161.46:5173",
  "https://frontend-educa-e86x.vercel.app",
  "https://sistemaeducamelhor.com.br",
];

const extra = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const whitelist = [...new Set([...defaultWhitelist, ...extra])];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || whitelist.includes(origin)) return cb(null, true);

      const err = new Error(`Não permitido por CORS: ${origin}`);
      err.status = 403;
      return cb(err);
    },
    credentials: true,
  })
);

app.use((req, res, next) => {
  req.db = pool;
  next();
});



// Aceita JSONs maiores (necessário para foto_base64)
app.use(express.json({ limit: "10mb" }));

// Aceita também formulários grandes (para futuros uploads)
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Body-parser mantido (compatibilidade, com mesmo limite do express)
app.use(bodyParser.json({ limit: "10mb" }));

// ============================================================================
// Estáticos
// ============================================================================
app.use(
  "/uploads",
  express.static(join(__dirname, "uploads"), {
    maxAge: "1d",
    etag: true,
    setHeaders(res) {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=86400");
    },
  })
);

// ============================================================================
// Pings e debugs PÚBLICOS (não exigem token)
// ============================================================================

// ============================================================================
// Pings e debugs PÚBLICOS (não exigem token)
// ============================================================================
app.get("/__build-info", (_req, res) =>
  res.json({
    ok: true,
    msg: "EDUCA BACKEND — BUILD ATIVO",
    ts: new Date().toISOString(),
  })
);

// Health check público (root)
app.get(["/health", "/healthz"], (_req, res) =>
  res.json({
    ok: true,
    status: "UP",
    ts: new Date().toISOString(),
  })
);

// Health check público (API - compatível com App Platform / Frontend)
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    status: "UP",
    ts: new Date().toISOString(),
  })
);


app.get("/api/visitantes-ping", (_req, res) =>
  res.json({
    ok: true,
    message: "router de visitantes acessível — /api/visitantes-ping",
  })
);

// ============================================================================
// DEBUG (somente DEV) — evita expor rotas e logs sensíveis em produção
// ============================================================================
const IS_PROD = process.env.NODE_ENV === "production";


if (!IS_PROD) {
  // console.log("[FF] MODULAÇÃO reativada");
}


if (!IS_PROD) {
  // Pings/Debugs úteis em DEV
  app.get("/api/monitoramento/visitantes/ping-public", (_req, res) =>
    res.json({
      ok: true,
      message:
        "router de visitantes acessível — /api/monitoramento/visitantes/ping-public",
    })
  );

  app.get("/visitantes-ping-root", (_req, res) =>
    res.json({
      ok: true,
      message: "router de visitantes acessível — /visitantes-ping-root",
    })
  );

  app.get("/api/__overlay-debug", (req, res) => {
    res.json({
      ok: true,
      message: "Overlay debug OK",
      query: req.query,
      ts: new Date().toISOString(),
    });
  });

  // ✅ PASSO 4.3.1 — Observabilidade (DEV) sem vazar segredos
  // - Gera request id
  // - Loga somente monitoramento (sem Authorization)
  app.use((req, res, next) => {
    const startedAt = Date.now();

    const rid =
      req.headers["x-request-id"] ||
      `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;

    req.request_id = String(rid);
    res.setHeader("X-Request-Id", String(rid));

    const url = String(req.originalUrl || "");
    const isMonitoramento = url.startsWith("/api/monitoramento");

    res.on("finish", () => {
      if (!isMonitoramento) return;

      const ms = Date.now() - startedAt;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          module: "monitoramento",
          request_id: String(rid),
          method: req.method,
          url,
          status: res.statusCode,
          duration_ms: ms,
        })
      );
    });

    next();
  });
}

async function bootstrap() {
  // ============================================================================
  // Plataforma (CEO/Admin Global) — rotas públicas próprias (NÃO dependem de escola)
  // ============================================================================
  app.use("/api/auth-plataforma", authPlataformaRouter);
  app.use("/api/plataforma", autenticarToken, exigirEscopo("plataforma"), plataformaRouter);
  app.use("/api/plataforma/usage", autenticarToken, exigirEscopo("plataforma"), plataformaUsageRouter);

  if (appPaisRouter) app.use("/api/app-pais", appPaisRouter);
  if (responsavelRoutes) app.use("/api/app-pais", responsavelRoutes);
  if (deviceRoutes) app.use("/api/app-pais", deviceRoutes);

  if (captureRoutes) app.use("/api/capture", captureRoutes);



  // ============================================================================
  // Monitoramento — STREAM (RTSP→MJPEG) SEM middleware global de auth
  //  - O próprio arquivo monitoramento_stream.js protege /stream/:id.mjpeg
  //  - /stream/ping continua público para diagnóstico
  // ============================================================================
  if (monitoramentoStream) {
    app.use("/api/monitoramento", monitoramentoStream);
  }


  // ============================================================================
  // Rotas protegidas principais (mantidas como estavam)
  // ============================================================================
  app.use("/api/auth", authRouter);
  app.use(
    "/api/ferramentas",
    autenticarToken,
    verificarEscola,
    ferramentasIndexRouter
  );
  app.use("/api/alunos", autenticarToken, verificarEscola, alunosRouter);
  app.use("/api/matriculas", autenticarToken, verificarEscola, matriculasRouter);
  app.use(
    "/api/professores",
    autenticarToken,
    verificarEscola,
    professoresRouter
  );
  app.use(
    "/api/disciplinas",
    autenticarToken,
    verificarEscola,
    disciplinasRouter
  );
  app.use("/api/turmas", autenticarToken, verificarEscola, turmasRouter);


  // ⚠️ MODULAÇÃO (reativado)
  app.use("/api/modulacao", autenticarToken, verificarEscola, modulacaoRoutes);
  app.use(
    "/api/modulacao",
    autenticarToken,
    verificarEscola,
    modulacaoDiagnosticoRouter
  );


  if (FF_QUESTOES) {
    app.use("/api/questoes", autenticarToken, verificarEscola, questoesRouter);
    app.use(
      "/api/questoes",
      autenticarToken,
      verificarEscola,
      questoesUploadRouter
    );
  } else {
    console.log("[FF] Questões desativado");
  }

  app.use("/api/escolas", autenticarToken, verificarEscola, escolasRouter);

  if (ocrRouter) {
    app.use("/api/ocr", autenticarToken, verificarEscola, ocrRouter);
  } else {
    console.log("[FF] OCR desativado");
  }

  if (redacoesRouter) {
    app.use("/api/redacoes", autenticarToken, verificarEscola, redacoesRouter);
  } else {
    console.log("[FF] Redações desativadas");
  }

  if (correcoesOpenAI) {
    app.use(
      "/api/correcoes_openai",
      autenticarToken,
      verificarEscola,
      correcoesOpenAI
    );
  } else {
    console.log("[FF] Correções OpenAI desativadas");
  }

  if (FF_GABARITOS) {
    app.use("/api/gabaritos", autenticarToken, verificarEscola, gabaritosRoutes);
  } else {
    console.log("[FF] Gabaritos desativado");
  }

  if (FF_GABARITOS_GENERATOR) {
    app.use(
      "/api/gabaritos-generator",
      autenticarToken,
      verificarEscola,
      gabaritosGeneratorRoutes
    );
  } else {
    console.log("[FF] Gabaritos-Generator desativado");
  }

  app.use("/api/turnos", autenticarToken, verificarEscola, turnosRouter);
  app.use("/api/gabarito-pdf", autenticarToken, verificarEscola, gabaritoPdfRouter);
  app.use("/api/gabarito-avaliacoes", autenticarToken, verificarEscola, gabaritoAvaliacoesRouter);
  app.use("/api/gabarito-lotes", autenticarToken, verificarEscola, gabaritoLotesRouter);
  app.use("/api/notas", autenticarToken, verificarEscola, notasRouter);
  app.use("/api/avaliacoes", autenticarToken, verificarEscola, avaliacoesRouter);


  // ⚠️ BOLETINS (temporariamente OFF)
  // app.use("/api/boletins", autenticarToken, verificarEscola, boletinsRouter);

  // ✅ Rotas públicas de usuários (cadastro) — sem token, mas exige escola
  app.use("/api/usuarios", verificarEscola, usuariosPublicRouter);

  // 🔒 Rotas protegidas de usuários
  app.use("/api/usuarios", autenticarToken, verificarEscola, usuariosRouter);
  app.use("/api/codigos", autenticarToken, verificarEscola, codigosRouter);
  app.use("/api/registros-ocorrencias", autenticarToken, verificarEscola, registrosOcorrenciasRouter);
  app.use("/api/responsaveis", autenticarToken, verificarEscola, responsaveisRouter);
  app.use("/api/termo-consentimento", autenticarToken, verificarEscola, termoConsentimentoRouter);
  app.use("/api/tace", autenticarToken, verificarEscola, taceRouter);
  app.use("/api/relatorio-disciplinar", autenticarToken, verificarEscola, relatorioDisciplinarRouter);
  app.use("/api/suporte", autenticarToken, verificarEscola, suporteRouter);

  // ✅ Agente Autônomo EducaDF (Playwright — login + lançamento)
  if (agenteEducadfRouter) {
    console.log("[FF] Agente EducaDF ativado");
    app.use("/api/agente", autenticarToken, verificarEscola, agenteEducadfRouter);
  } else if (FF_AGENTE_EDUCADF) {
    console.warn("[FF] Agente EducaDF: router NÃO carregado.");
  }

  // ✅ Direção — Gestão de Equipe (Diretor Disciplinar)
  app.use("/api/direcao", autenticarToken, verificarEscola, direcaoRouter);

  // ✅ Cargas Horárias (CADASTRO BÁSICO) — independente de Horários/Grade (Urania)
  if (FF_CARGAS_HORARIAS) {
    console.log("[FF] Cargas Horárias ativado");
    app.use(
      "/api/cargas-horarias",
      autenticarToken,
      verificarEscola,
      cargasHorariasRouter
    );
  } else {
    console.log("[FF] Cargas Horárias desativado");
  }

  // ⚠️ Horários/Grade (Urania/solver) — pode ficar OFF em produção
  if (FF_HORARIOS) {
    console.log("[FF] Horários/Grade ativado");
    app.use("/api/grade", autenticarToken, verificarEscola, gradeBaseRoutes);
    app.use("/api/grade", autenticarToken, verificarEscola, gradeSolveRoutes);
    app.use(
      "/api/disponibilidades",
      autenticarToken,
      verificarEscola,
      disponibilidadesRouter
    );
    app.use(
      "/api/preferencias",
      autenticarToken,
      verificarEscola,
      preferenciasRouter
    );
    app.use("/api/grade", autenticarToken, verificarEscola, gradeRunMockRouter);
    app.use("/api/grade", autenticarToken, verificarEscola, gradePublishRouter);
  } else {
    console.log("[FF] Horários/Grade desativado");
  }

  // ✅ NOVO — Configurações Pedagógicas (protegido)
  if (configPedagogicaRouter) {
    app.use(
      "/api/config-pedagogica",
      autenticarToken,
      verificarEscola,
      configPedagogicaRouter
    );
  }

  if (monitoramentoIngestRouter) {
    // Ingest do Worker: sem JWT e sem verificarEscola (validação é feita por x-worker-token no próprio router)
    app.use("/api/monitoramento/ingest", monitoramentoIngestRouter);
  }

  if (monitoramentoEmbeddingsRouter) {
    // 🔐 Autenticação delegada ao próprio router:
    // - Worker: x-worker-token (+ x-escola-id)
    // - Admin: JWT + RBAC + verificarEscola (dentro do router)
    // ✅ Precisa ficar ANTES do gate "/api" do Conteúdos Admin
    app.use("/api/monitoramento/embeddings", monitoramentoEmbeddingsRouter);
  }

  if (conteudosAdminRouter) {

    // ⚠️ ATENÇÃO:
    // Este mount em "/api" aplicava autenticação em qualquer "/api/*" que não tivesse
    // sido atendido antes, bloqueando rotas PÚBLICAS como /api/monitoramento-public.
    // Mantemos Conteúdos Admin protegido, mas liberamos explicitamente as rotas públicas.

    app.use(
      "/api",
      (req, res, next) => {
        const p = String(req.path || "");

        // ✅ Rotas públicas do Monitoramento (OPÇÃO A)
        if (p.startsWith("/monitoramento-public")) return next();
        if (p.startsWith("/monitoramento-overlay")) return next();

        // ✅ Monitoramento Embeddings: auth é decidida no próprio router (Worker OU Admin)
        if (p.startsWith("/monitoramento/embeddings")) return next();

        // ✅ Rotas da Plataforma (CEO/Admin Global) — NÃO passam por verificarEscola
        if (p.startsWith("/plataforma")) return next();
        if (p.startsWith("/auth-plataforma")) return next();

        // (opcional) manter health público mesmo se algum dia mudar a ordem
        if (p === "/health" || p === "/healthz") return next();

        // 🔒 Para o restante, exige token + escola
        return autenticarToken(req, res, (err) => {
          if (err) return next(err);
          return verificarEscola(req, res, next);
        });
      },
      conteudosAdminRouter
    );
  }

  if (monitoramentoUltimosRouter) {
    app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoUltimosRouter);
  }

  // (movido para cima, antes do gate "/api" do Conteúdos Admin)

  if (monitoramentoCamerasRouter) {
    app.use("/api/monitoramento/cameras", autenticarToken, verificarEscola, monitoramentoCamerasRouter);
  }

  if (monitoramentoVisitantesRouter) {
    app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoVisitantesRouter);
  }

  if (monitoramentoPainelRouter) {
    app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoPainelRouter);
    app.use("/api/monitoramento_painel", autenticarToken, verificarEscola, monitoramentoPainelRouter);
  }

  if (monitoramentoEventoRouter) {
    app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoEventoRouter);
  }

  if (monitoramentoOverlayRouter) {
    // ✅ Público (sem token) — overlay para painel operacional / TV / diagnóstico
    app.use("/api/monitoramento-public", monitoramentoOverlayRouter);
    app.use("/api/monitoramento-overlay", monitoramentoOverlayRouter);

    // ❌ Removido: overlay NÃO deve ser montado em /api/monitoramento (rota protegida),
    // pois isso força autenticação e quebra o conceito de "public".
    // app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoOverlayRouter);
  }



  if (monitoramentoRouter) {
    app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoRouter);
  }

  if (monitoramentoAlertaRouter) {
    app.use("/api/monitoramento_alerta", monitoramentoAlertaRouter);

    // ✅ ALIAS (compat): frontend chama /api/monitoramento/alertas-ativos e /alertas-stream
    // Encaminha internamente para o router real:
    // - /alertas-ativos  -> /api/monitoramento_alerta/alunos/alertas
    // - /alertas-stream  -> /api/monitoramento_alerta/events (SSE)
    app.use("/api/monitoramento/alertas-ativos", (req, res, next) => {
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      req.url = `/alunos/alertas${qs}`;
      return monitoramentoAlertaRouter.handle(req, res, next);
    });

    app.use("/api/monitoramento/alertas-stream", (req, res, next) => {
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      req.url = `/events${qs}`;
      return monitoramentoAlertaRouter.handle(req, res, next);
    });
  }

  // ============================================================================
  // Error handler global (deve vir ANTES do 404)
  //  - Em DEV: ajuda no diagnóstico
  //  - Em PROD: não vaza detalhes internos
  // ============================================================================
  app.use((err, _req, res, _next) => {
    const isProd = process.env.NODE_ENV === "production";
    const status = err?.status || err?.statusCode || 500;

    // Log sempre (operacional). Em produção, logar a mensagem é suficiente.
    console.error("❌ ERRO:", err?.message || err);

    if (isProd) {
      return res.status(status).json({
        ok: false,
        message: status === 500 ? "Erro interno no servidor." : (err?.message || "Erro."),
      });
    }

    // DEV
    return res.status(status).json({
      ok: false,
      message: err?.message || "Erro.",
      stack: err?.stack,
    });
  });

  // ============================================================================
  // 404 (SEMPRE por último, após registrar todas as rotas)
  // ============================================================================
  app.use((_req, res) =>
    res.status(404).json({ ok: false, message: "Rota não encontrada." })
  );
} // ✅ fecha bootstrap()



// ============================================================================
// PASSO 3.3 — Job de limpeza (PAIR CODES)
// - Sem endpoint público
// - Evita crescimento infinito de capture_pair_codes
// - Seguro: lock em memória para não sobrepor execuções
// ============================================================================
function startCapturePairCleanupJob() {
  const enabled = ff("CAPTURE_PAIR_CLEANUP_ENABLED", true);

  // Só roda se EDUCA-CAPTURE estiver ativo no servidor
  if (!FF_EDUCA_CAPTURE) {
    if (!IS_PROD) console.log("[CAPTURE][PAIR][CLEANUP] skip: FF_EDUCA_CAPTURE=OFF");
    return;
  }

  if (!enabled) {
    console.log("[CAPTURE][PAIR][CLEANUP] desativado por CAPTURE_PAIR_CLEANUP_ENABLED=0");
    return;
  }

  const intervalMs = Number(process.env.CAPTURE_PAIR_CLEANUP_INTERVAL_MS || 60 * 60_000); // 1h
  const keepExpiredDays = Number(process.env.CAPTURE_PAIR_KEEP_EXPIRED_DAYS || 2); // pendentes expirados
  const keepUsedDays = Number(process.env.CAPTURE_PAIR_KEEP_USED_DAYS || 30); // aprovados/usados

  if (!Number.isFinite(intervalMs) || intervalMs < 30_000) {
    console.warn("[CAPTURE][PAIR][CLEANUP] interval inválido. Ajuste CAPTURE_PAIR_CLEANUP_INTERVAL_MS.");
    return;
  }

  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;

    const cutoffExpired = new Date(Date.now() - keepExpiredDays * 24 * 60 * 60_000);
    const cutoffUsed = new Date(Date.now() - keepUsedDays * 24 * 60 * 60_000);

    try {
      const [result] = await pool.query(
        `
        DELETE FROM capture_pair_codes
        WHERE (used_at IS NULL AND expires_at < ?)
           OR (used_at IS NOT NULL AND used_at < ?)
        `,
        [cutoffExpired, cutoffUsed]
      );

      const deleted = Number(result?.affectedRows || 0);

      if (!IS_PROD) {
        console.log(
          `[CAPTURE][PAIR][CLEANUP] ok deleted=${deleted} cutoffExpired=${cutoffExpired.toISOString()} cutoffUsed=${cutoffUsed.toISOString()}`
        );
      } else if (deleted > 0) {
        console.log(`[CAPTURE][PAIR][CLEANUP] ok deleted=${deleted}`);
      }
    } catch (err) {
      console.error("[CAPTURE][PAIR][CLEANUP] erro:", err?.message || err);
    } finally {
      running = false;
    }
  };

  // roda 1x ao subir (depois agenda)
  runOnce();

  setInterval(runOnce, intervalMs).unref?.();

  console.log("[CAPTURE][PAIR][CLEANUP] job ativo", {
    intervalMs,
    keepExpiredDays,
    keepUsedDays,
  });
}


// ============================================================================
// Boot
// ============================================================================
const PORT = process.env.PORT || 3000;

bootstrap()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 API rodando na porta ${PORT}`);
      console.log("🔔 BACKEND BUILD ATIVO — verifique /__build-info");

      // PASSO 3.3 — Job de limpeza de pair_codes (produção)
      startCapturePairCleanupJob();

      if (process.env.NODE_ENV !== "production") {
        console.log("🔔 PINGS/DEBUGS (DEV):");
        console.log("    • /api/visitantes-ping");
        console.log("    • /api/monitoramento/visitantes/ping-public");
        console.log("    • /visitantes-ping-root");
        console.log("    • /api/__overlay-debug");
      }
    });
  })
  .catch((err) => {
    console.error("❌ Erro crítico no bootstrap:", err);
    process.exit(1);
  });
