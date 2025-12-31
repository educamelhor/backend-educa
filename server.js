// ============================================================================
// server.js — API EDUCA.MELHOR
// ============================================================================

import 'dotenv/config';
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ⬇️ AJUSTE: caminho correto do pool conforme sua estrutura validada
import pool from "./db.js";

// ------------------------- Rotas --------------------------------------------
import modulacaoRoutes from "./routes/modulacao.js";
import modulacaoDiagnosticoRouter from "./routes/modulacao_diagnostico.js";
import ocrRouter from "./routes/ocr.js";
import redacoesRouter from "./routes/redacoes.js";
import correcoesOpenAI from "./routes/correcoes_openai.js";
import gabaritosRoutes from "./routes/gabaritos.js";
import authRouter from "./routes/auth.js";
import gabaritosGeneratorRoutes from "./routes/gabaritosGeneratorRoutes.js";
import turnosRouter from "./routes/turnos.js";
import notasRouter from "./routes/notas.js";
import ferramentasIndexRouter from "./routes/ferramentas/index.js";
import boletinsRouter from "./routes/boletins.js";
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
import appPaisRouter from "./routes/app_pais.js";
// import responsavelRoutes from "./modules/app-pais/responsavel/responsavel.routes.js";
// ✅ NOVO — Device
// import deviceRoutes from "./modules/app-pais/device/device.routes.js";

// ✅ NOVO — Configurações Pedagógicas (Horários)
import configPedagogicaRouter from "./routes/config_pedagogica.js";
import conteudosAdminRouter from "./routes/conteudos_admin.js";

// ------------------------- Monitoramento ------------------------------------
import monitoramentoRouter from "./routes/monitoramento.js";
import monitoramentoEventoRouter from "./routes/monitoramento_evento.js";
import monitoramentoOverlayRouter from "./routes/monitoramento_overlay.js";
import monitoramentoAlertaRouter from "./routes/monitoramento_alerta.js";
import monitoramentoPainelRouter from "./routes/monitoramento_painel.js";
import monitoramentoVisitantesRouter from "./routes/monitoramento_visitantes.js";
import monitoramentoCamerasRouter from "./routes/monitoramento_cameras.js";
import monitoramentoEmbeddingsRouter from "./routes/monitoramento_embeddings.js";
import monitoramentoIngestRouter from "./routes/monitoramento_ingest.js";
import monitoramentoStream from "./routes/monitoramento_stream.js";
import monitoramentoUltimosRouter from "./routes/monitoramento_ultimos.js";

// ------------------------- Middlewares globais ------------------------------
import { autenticarToken } from "./middleware/autenticarToken.js";
import { verificarEscola } from "./middleware/verificarEscola.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();

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
      cb(new Error("Não permitido por CORS"));
    },
    credentials: true,
  })
);

app.use((req, res, next) => {
  req.db = pool;
  next();
});

app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "x-access-token",
    ],
  })
);

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

// ✅ HEALTHCHECK simples (DigitalOcean / monitoramento externo)
app.get("/ping", (_req, res) =>
  res.json({
    ok: true,
    service: "backend-educa",
    ts: new Date().toISOString(),
  })
);

app.get("/__build-info", (_req, res) =>
  res.json({
    ok: true,
    msg: "EDUCA BACKEND — BUILD ATIVO",
    ts: new Date().toISOString(),
  })
);


app.get("/api/visitantes-ping", (_req, res) =>
  res.json({
    ok: true,
    message: "router de visitantes acessível — /api/visitantes-ping",
  })
);
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

app.get("/__visitantes-debug", (req, res) => {
  res.json({
    ok: true,
    message: "DEBUG público (root) OK",
    method: req.method,
    url: req.originalUrl,
    ts: new Date().toISOString(),
  });
});
app.post("/__visitantes-debug", (req, res) => {
  res.json({
    ok: true,
    message: "DEBUG público (root) OK — body ecoado",
    method: req.method,
    url: req.originalUrl,
    body: req.body || {},
    ts: new Date().toISOString(),
  });
});
app.get("/api/visitantes-debug", (req, res) => {
  res.json({
    ok: true,
    message: "DEBUG público (/api) OK",
    method: req.method,
    url: req.originalUrl,
    ts: new Date().toISOString(),
  });
});
app.post("/api/visitantes-debug", (req, res) => {
  res.json({
    ok: true,
    message: "DEBUG público (/api) OK — body ecoado",
    method: req.method,
    url: req.originalUrl,
    body: req.body || {},
    ts: new Date().toISOString(),
  });
});

// 🔎 DEBUG específico do OVERLAY (público):
app.get("/api/__overlay-debug", (req, res) => {
  res.json({
    ok: true,
    message: "Overlay debug OK",
    query: req.query,
    ts: new Date().toISOString(),
  });
});

app.use((req, res, next) => {
  console.log("[HEADERS TEST]", req.headers.authorization);
  next();
});

app.use("/api/app-pais", appPaisRouter);
// app.use("/api/app-pais", responsavelRoutes);

// ✅ NOVO — Device
// app.use("/api/app-pais", deviceRoutes);


// ============================================================================
// Monitoramento — STREAM (RTSP→MJPEG) SEM middleware global de auth
//  - O próprio arquivo monitoramento_stream.js protege /stream/:id.mjpeg
//  - /stream/ping continua público para diagnóstico
// ============================================================================
app.use("/api/monitoramento", monitoramentoStream);

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
app.use("/api/modulacao", autenticarToken, verificarEscola, modulacaoRoutes);
app.use(
  "/api/modulacao",
  autenticarToken,
  verificarEscola,
  modulacaoDiagnosticoRouter
);
app.use("/api/questoes", autenticarToken, verificarEscola, questoesRouter);
app.use(
  "/api/questoes",
  autenticarToken,
  verificarEscola,
  questoesUploadRouter
);
app.use("/api/escolas", autenticarToken, verificarEscola, escolasRouter);
app.use("/api/ocr", autenticarToken, verificarEscola, ocrRouter);
app.use("/api/redacoes", autenticarToken, verificarEscola, redacoesRouter);
app.use(
  "/api/correcoes_openai",
  autenticarToken,
  verificarEscola,
  correcoesOpenAI
);
app.use("/api/gabaritos", autenticarToken, verificarEscola, gabaritosRoutes);
app.use(
  "/api/gabaritos-generator",
  autenticarToken,
  verificarEscola,
  gabaritosGeneratorRoutes
);
app.use("/api/turnos", autenticarToken, verificarEscola, turnosRouter);
app.use("/api/notas", autenticarToken, verificarEscola, notasRouter);
app.use("/api/boletins", autenticarToken, verificarEscola, boletinsRouter);
app.use("/api/usuarios", autenticarToken, verificarEscola, usuariosRouter);
app.use("/api/codigos", autenticarToken, verificarEscola, codigosRouter);
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

// ✅ NOVO — Configurações Pedagógicas (protegido)
app.use(
  "/api/config-pedagogica",
  autenticarToken,
  verificarEscola,
  configPedagogicaRouter
);

// ✅ NOVO — Conteúdos (ADMIN / Pedagógico)
app.use(
  "/api",
  autenticarToken,
  verificarEscola,
  conteudosAdminRouter
);


// ============================================================================
// Monitoramento — ajuste para permitir o worker sem JWT
// ============================================================================
app.use("/api/monitoramento/ingest", verificarEscola, monitoramentoIngestRouter);

// Demais módulos (protegidos)
app.use(
  "/api/monitoramento",
  autenticarToken,
  verificarEscola,
  monitoramentoUltimosRouter
);
app.use(
  "/api/monitoramento/embeddings",
  autenticarToken,
  verificarEscola,
  monitoramentoEmbeddingsRouter
);
app.use(
  "/api/monitoramento/cameras",
  autenticarToken,
  verificarEscola,
  monitoramentoCamerasRouter
);
app.use(
  "/api/monitoramento",
  autenticarToken,
  verificarEscola,
  monitoramentoVisitantesRouter
);
app.use(
  "/api/monitoramento",
  autenticarToken,
  verificarEscola,
  monitoramentoPainelRouter
);
app.use(
  "/api/monitoramento_painel",
  autenticarToken,
  verificarEscola,
  monitoramentoPainelRouter
);
app.use(
  "/api/monitoramento",
  autenticarToken,
  verificarEscola,
  monitoramentoEventoRouter
);
app.use(
  "/api/monitoramento",
  autenticarToken,
  verificarEscola,
  monitoramentoOverlayRouter
);
app.use("/api/monitoramento", autenticarToken, verificarEscola, monitoramentoRouter);

// ============================================================================
// Alertas (SSE) e públicas diversas
// ============================================================================
app.use("/api/monitoramento_alerta", monitoramentoAlertaRouter);
app.use("/api", alunosImpressaoRouter);
app.use("/api/monitoramento-overlay", monitoramentoOverlayRouter);
app.use("/api/monitoramento-public", monitoramentoOverlayRouter);

// ============================================================================
// 404
// ============================================================================
app.use((req, res) => res.status(404).json({ message: "Rota não encontrada." }));

// ============================================================================
// Boot
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
  console.log("🔔 BACKEND BUILD ATIVO — verifique /__build-info");
  console.log("🔔 PINGS/DEBUGS PÚBLICOS:");
  console.log("    • /__visitantes-debug (GET/POST)");
  console.log("    • /api/visitantes-debug (GET/POST)");
  console.log("    • /api/visitantes-ping");
  console.log("    • /api/monitoramento/visitantes/ping-public");
  console.log("    • /visitantes-ping-root");
  console.log("    • /api/__overlay-debug");
});
