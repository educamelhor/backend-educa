// ============================================================================
// server.js — API EDUCA.MELHOR
// ============================================================================
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ⬇️ AJUSTE: caminho correto do pool conforme sua estrutura validada
import pool from "./db.js";

// ------------------------- Rotas --------------------------------------------
// ⚠️ MODULAÇÃO (temporariamente OFF)
// Motivo: evitar quebrar o boot em produção enquanto o módulo está incompleto.
// Quando for retomar: reativar imports + app.use abaixo e validar controllers.
//// import modulacaoRoutes from "./routes/modulacao.js";
//// import modulacaoDiagnosticoRouter from "./routes/modulacao_diagnostico.js";



// ==========================
// OPTIONAL ROUTES (Feature Flags)
// (evita quebrar o boot quando arquivos/módulos ainda estão em construção)
// ==========================
let ocrRouter = null;
let redacoesRouter = null;
let correcoesOpenAI = null;


import gabaritosRoutes from "./routes/gabaritos.js";
import authRouter from "./routes/auth.js";
import gabaritosGeneratorRoutes from "./routes/gabaritosGeneratorRoutes.js";
import turnosRouter from "./routes/turnos.js";
import notasRouter from "./routes/notas.js";
import ferramentasIndexRouter from "./routes/ferramentas/index.js";


// ⚠️ BOLETINS (temporariamente OFF)
// Motivo: dependência pesada (puppeteer) — evitar quebrar boot em produção.
// Reativar quando o ambiente de produção estiver preparado para puppeteer/Chromium.
//// import boletinsRouter from "./routes/boletins.js";




import alunosRouter from "./routes/alunos.js";
import professoresRouter from "./routes/professores.js";
import disciplinasRouter from "./routes/disciplinas.js";
import turmasRouter from "./routes/turmas.js";
import questoesRouter from "./routes/questoes.js";
import questoesUploadRouter from "./routes/questoesUpload.js";
import escolasRouter from "./routes/escolas.js";
import usuariosRouter from "./routes/usuarios.js";
import alunosImpressaoRouter from "./routes/alunos_impressao.js";
import codigosRouter from "./routes/codigos.js";
import cargasHorariasRouter from "./routes/cargasHorarias.js";
import gradeBaseRoutes from "./routes/gradeBase.js";
import gradeSolveRoutes from "./routes/gradeSolve.js";
import disponibilidadesRouter from "./routes/disponibilidades.js";
import preferenciasRouter from "./routes/preferencias.js";
import gradeRunMockRouter from "./routes/gradeRunMock.js";
import gradePublishRouter from "./routes/gradePublish.js";

// ------------------------- ROTAS OPCIONAIS (blindadas por Feature Flags) -----
let appPaisRouter = null;
let responsavelRoutes = null;
let deviceRoutes = null;

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

// Carregamento seguro (NÃO quebra o boot se faltar arquivo)
// Padrão profissional: DEV liga por padrão, PROD desliga por padrão.
// Em produção, só liga se a ENV vier explicitamente.
const DEFAULT_ON_DEV = process.env.NODE_ENV !== "production";

const FF_APP_PAIS = ff("FF_APP_PAIS", DEFAULT_ON_DEV);
const FF_CONFIG_PEDAGOGICA = ff("FF_CONFIG_PEDAGOGICA", DEFAULT_ON_DEV);
const FF_CONTEUDOS_ADMIN = ff("FF_CONTEUDOS_ADMIN", DEFAULT_ON_DEV);

// Monitoramento é pesado/sensível: manter OFF por padrão mesmo em DEV (liga quando for trabalhar nele)
const FF_MONITORAMENTO = ff("FF_MONITORAMENTO", false);

// ✅ NOVAS FLAGS (conforme mapa PROD aprovado)
const FF_GABARITOS = ff("FF_GABARITOS", DEFAULT_ON_DEV);
const FF_GABARITOS_GENERATOR = ff("FF_GABARITOS_GENERATOR", DEFAULT_ON_DEV);
const FF_QUESTOES = ff("FF_QUESTOES", DEFAULT_ON_DEV);
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


if (FF_CONFIG_PEDAGOGICA) {
  configPedagogicaRouter = await safeImportDefault(
    "FF_CONFIG_PEDAGOGICA",
    "./routes/config_pedagogica.js"
  );
}

if (FF_CONTEUDOS_ADMIN) {
  conteudosAdminRouter = await safeImportDefault(
    "FF_CONTEUDOS_ADMIN",
    "./routes/conteudos_admin.js"
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
  monitoramentoEmbeddingsRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_embeddings.js");
  monitoramentoIngestRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_ingest.js");
  monitoramentoStream = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_stream.js");
  monitoramentoUltimosRouter = await safeImportDefault("FF_MONITORAMENTO", "./routes/monitoramento_ultimos.js");
} else if (FF_MONITORAMENTO) {
  console.warn("[FF] FF_MONITORAMENTO estava ON, mas foi desativado por falta de ENV obrigatórias.");
}


// ------------------------- Middlewares globais ------------------------------
import { autenticarToken } from "./middleware/autenticarToken.js";
import { verificarEscola } from "./middleware/verificarEscola.js";

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
  "http://190.107.161.46:5173",
  "https://frontend-educa-e86x.vercel.app",
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
app.get("/health", (_req, res) =>
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
  console.log("[FF] MODULAÇÃO temporariamente DESATIVADA no server.js");
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

  // NUNCA logar Authorization em produção
  app.use((req, _res, next) => {
    console.log("[HEADERS TEST] Authorization:", req.headers.authorization);
    next();
  });
}

async function bootstrap() {
  if (appPaisRouter) app.use("/api/app-pais", appPaisRouter);
  if (responsavelRoutes) app.use("/api/app-pais", responsavelRoutes);
  if (deviceRoutes) app.use("/api/app-pais", deviceRoutes);



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


  // ⚠️ MODULAÇÃO (temporariamente OFF)
  // app.use("/api/modulacao", autenticarToken, verificarEscola, modulacaoRoutes);
  // app.use(
  //   "/api/modulacao",
  //   autenticarToken,
  //   verificarEscola,
  //   modulacaoDiagnosticoRouter
  // );


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
  app.use("/api/notas", autenticarToken, verificarEscola, notasRouter);


  // ⚠️ BOLETINS (temporariamente OFF)
  // app.use("/api/boletins", autenticarToken, verificarEscola, boletinsRouter);

  app.use("/api/usuarios", autenticarToken, verificarEscola, usuariosRouter);
  app.use("/api/codigos", autenticarToken, verificarEscola, codigosRouter);


  if (FF_HORARIOS) {
    app.use(
      "/api/cargas-horarias",
      autenticarToken,
      verificarEscola,
      cargasHorariasRouter
    );
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

  if (conteudosAdminRouter) {
    app.use("/api", autenticarToken, verificarEscola, conteudosAdminRouter);
  }

  if (monitoramentoIngestRouter) {
    app.use("/api/monitoramento/ingest", verificarEscola, monitoramentoIngestRouter);
  }

  if (monitoramentoUltimosRouter) {
    app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoUltimosRouter);
  }

  if (monitoramentoEmbeddingsRouter) {
    app.use("/api/monitoramento/embeddings", autenticarToken, verificarEscola, monitoramentoEmbeddingsRouter);
  }

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
    app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoOverlayRouter);
    app.use("/api/monitoramento-overlay", monitoramentoOverlayRouter);
    app.use("/api/monitoramento-public", monitoramentoOverlayRouter);
    app.use("/api/monitoramento-overlay", monitoramentoOverlayRouter);
  }

  if (monitoramentoRouter) {
    app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoRouter);
  }

  if (monitoramentoAlertaRouter) {
    app.use("/api/monitoramento_alerta", monitoramentoAlertaRouter);
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
// Boot
// ============================================================================
const PORT = process.env.PORT || 3000;

bootstrap()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 API rodando na porta ${PORT}`);
      console.log("🔔 BACKEND BUILD ATIVO — verifique /__build-info");

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
