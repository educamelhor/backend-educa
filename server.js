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
import plataformaSuporteRouter from "./routes/plataforma_suporte.js";
import gabaritosGeneratorRoutes from "./routes/gabaritosGeneratorRoutes.js";
import gabaritoPdfRouter from "./routes/gabaritoPdf.js";
import gabaritoAvaliacoesRouter from "./routes/gabaritoAvaliacoes.js";
import gabaritoLotesRouter from "./routes/gabaritoLotes.js";
import turnosRouter from "./routes/turnos.js";
import suporteRouter from "./routes/suporte.js";
import notasRouter from "./routes/notas.js";
import avaliacoesRouter from "./routes/avaliacoes.js";
import agentePlanosRouter from "./routes/agente-planos.js";
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
import provasRouter from "./routes/provas.js";
import provaPdfRouter from "./routes/prova_pdf.js";
import escolasRouter from "./routes/escolas.js";
import usuariosRouter, { publicRouter as usuariosPublicRouter } from "./routes/usuarios.js";
import alunosImpressaoRouter from "./routes/alunos_impressao.js";
import codigosRouter from "./routes/codigos.js";
import cargasHorariasRouter from "./routes/cargasHorarias.js";
import registrosOcorrenciasRouter from "./routes/registrosOcorrencias.js";
import conselhoRouter from "./routes/conselho.js";
import responsaveisRouter from "./routes/responsaveis.js";
import termoConsentimentoRouter from "./routes/termo-consentimento.js";
import taceRouter from "./routes/tace.js";
import disciplinarAtasRouter from "./routes/disciplinar-atas.js";
import disciplinarLiberacoesRouter from "./routes/disciplinar-liberacoes.js";
import relatorioDisciplinarRouter from "./routes/relatorio-disciplinar.js";
import disciplinarMetadadosRouter from "./routes/disciplinar-metadados.js";
import listasImpressaoRouter from "./routes/listas-impressao.js";
import gradeBaseRoutes from "./routes/gradeBase.js";
import gradeSolveRoutes from "./routes/gradeSolve.js";
import disponibilidadesRouter from "./routes/disponibilidades.js";
import preferenciasRouter from "./routes/preferencias.js";
import gradeRunMockRouter from "./routes/gradeRunMock.js";
import gradePublishRouter from "./routes/gradePublish.js";
import direcaoRouter from "./routes/direcao.js";
import governancaRouter, { syncPlanosAvaliacao } from "./routes/governanca.js";
import escolaLogosRouter from "./routes/escola_logos.js";
import capaProvasRouter from "./routes/capa_provas.js";
import plataformaGovernancaRouter from "./routes/plataforma_governanca.js";
import frequenciaRouter from "./routes/frequencia.js";
import secretariaRelatoriosRouter from "./routes/secretaria-relatorios.js";
import secretariaRelatoriosPdfRouter from "./routes/secretaria-relatorios-pdf.js";
import pedagogicoRelatoriosRouter from "./routes/pedagogico_relatorios.js";
import appPaisRouterModule, { mountToApp as mountAppPaisToApp } from "./routes/app_pais.js";
import bnccCascadeRouter from "./routes/bncc_cascade.js"; // ✅ import estático — sem feature flag
import bibliotecaRouter from "./routes/biblioteca.js"; // ✅ Módulo BIBLIOTECA
import secretariaAgenteRouter from "./routes/secretaria-agente.js"; // ✅ Agente Secretaria (SEEDF PDF Parser)

// ------------------------- ROTAS OPCIONAIS (blindadas por Feature Flags) -----
// appPaisRouterModule: importado estaticamente acima (não usa safeImportDefault
// porque import() dinâmico no Express 5 retorna namespace object, não monta corretamente)
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
// ✅ CONTEÚDOS ADMIN: módulo em produção — força true independente da variável de ambiente
// (variável FF_CONTEUDOS_ADMIN=false no DO estava bloqueando o carregamento)
const FF_CONTEUDOS_ADMIN = true;

const FF_EDUCA_CAPTURE = ff("FF_EDUCA_CAPTURE", DEFAULT_ON_DEV);

// Monitoramento é pesado/sensível: manter OFF por padrão mesmo em DEV (liga quando for trabalhar nele)
const FF_MONITORAMENTO = ff("FF_MONITORAMENTO", false);

// Agente EducaDF: pesado (Playwright) — OFF por padrão, ligar explicitamente
const FF_AGENTE_EDUCADF = ff("FF_AGENTE_EDUCADF", false);

// ✅ DEBUG: confirma flags efetivas (roda em DEV e PROD para facilitar diagnóstico)
console.log("[FF] FLAGS efetivas:", {
  FF_APP_PAIS,
  FF_CONFIG_PEDAGOGICA,
  FF_CONTEUDOS_ADMIN,
  FF_EDUCA_CAPTURE,
  FF_MONITORAMENTO,
  FF_AGENTE_EDUCADF,
});

if (FF_AGENTE_EDUCADF) {
  agenteEducadfRouter = await safeImportDefault(
    "FF_AGENTE_EDUCADF",
    "./modules/agente/agente.routes.js"
  );
}

// ✅ NOVAS FLAGS (conforme mapa PROD aprovado)
const FF_GABARITOS = ff("FF_GABARITOS", true);           // ✅ pronto para produção
const FF_GABARITOS_GENERATOR = ff("FF_GABARITOS_GENERATOR", true); // ✅ pronto para produção
const FF_QUESTOES = ff("FF_QUESTOES", true);             // ✅ pronto para produção (Banco de Questões + Gemini Vision)

// ✅ Cargas Horárias é CADASTRO BÁSICO (core operacional), independente do solver Urania
const FF_CARGAS_HORARIAS = ff("FF_CARGAS_HORARIAS", DEFAULT_ON_DEV);

// ⚠️ Horários/Grade (Urania/solver) fica separado e pode continuar OFF em produção
const FF_HORARIOS = ff("FF_HORARIOS", DEFAULT_ON_DEV);

// IMPORTANTE: appPaisRouter DEVE ser atribuído incondicionalmente aqui
// (antes do middleware na ~linha 405). O bloco if abaixo só valida ENVs.
appPaisRouter = appPaisRouterModule;
if (FF_APP_PAIS && requireEnvForFeature("FF_APP_PAIS", ["APP_PAIS_JWT_SECRET"])) {
  console.log("[FF] FF_APP_PAIS: router carregado. Stack:", appPaisRouter?.stack?.length);
} else {
  appPaisRouter = null; // desativa se flag off ou ENV faltar
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

// ✅ CONTEÚDOS ADMIN: carregamento obrigatório (módulo em produção)
conteudosAdminRouter =
  (await safeImportDefault("CONTEUDOS_ADMIN", "./routes/conteudos_admin.js")) ||
  (await safeImportDefault("CONTEUDOS_ADMIN", "./conteudos_admin.js")) ||
  (await safeImportDefault("CONTEUDOS_ADMIN", "./api/routes/conteudos_admin.js"));

if (conteudosAdminRouter) {
  console.log("[FF] Conteúdos Admin: router carregado com sucesso. Rotas:", conteudosAdminRouter?.stack?.length);
} else {
  console.warn("[FF] Conteúdos Admin: FALHA ao carregar. Rotas /api/conteudos/* ficarão com 404.");
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
    const router = mod?.default ?? mod;
    console.log(`[FF] ${flagName}: carregado com sucesso (${importPath}). Router ok: ${!!router}`);
    return router;
  } catch (err) {
    // ✅ Sempre loga — inclusive em PROD — para diagnóstico de falhas silenciosas
    console.error(
      `[FF] ${flagName}: FALHA ao carregar (${importPath}). Erro: ${err?.message || err}`
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

// Padrões dinâmicos aceitos (regex) — cobre previews do Vercel e domínio da escola
const corsAllowedPatterns = [
  /^https:\/\/.*\.vercel\.app$/,           // qualquer preview/deploy Vercel
  /^https:\/\/sistemaeducamelhor\.com\.br$/, // domínio principal
];

const extra = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const whitelist = [...new Set([...defaultWhitelist, ...extra])];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (whitelist.includes(origin)) return cb(null, true);
      if (corsAllowedPatterns.some((re) => re.test(origin))) return cb(null, true);

      const err = new Error(`Não permitido por CORS: ${origin}`);
      err.status = 403;
      return cb(err);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-escola-id",
      "x-perfil",
      "x-request-id",
      "x-worker-token",
    ],
    optionsSuccessStatus: 204,
  })
);

// Responde preflight OPTIONS globalmente antes de qualquer rota (Express 5: usar /{*any})
app.options("/{*any}", cors());

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

// ✅ Diagnóstico público: estado do conteudosAdminRouter
app.get("/__diag/conteudos", (_req, res) =>
  res.json({
    ok: true,
    FF_CONTEUDOS_ADMIN,
    conteudosAdminRouterLoaded: !!conteudosAdminRouter,
    routerType: conteudosAdminRouter ? typeof conteudosAdminRouter : null,
    stackLength: conteudosAdminRouter?.stack?.length ?? null,
    ts: new Date().toISOString(),
  })
);

// Health check público (root) — inclui /ping para DigitalOcean App Platform
app.get(["/ping", "/health", "/healthz"], (_req, res) =>
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

// ============================================================================
// EDUCA-CAPTURE — Páginas públicas (sem autenticação)
// Usadas como Support URL e Privacy Policy URL no App Store Connect
// ============================================================================
app.get("/capture/privacidade", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Política de Privacidade — EDUCA-CAPTURE</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:0 auto;padding:24px 16px;color:#1a1a1a;line-height:1.7}
    h1{color:#2D6CDF;font-size:1.6rem;border-bottom:2px solid #2D6CDF;padding-bottom:8px}
    h2{color:#1a4a9f;font-size:1.1rem;margin-top:28px}
    .badge{background:#2D6CDF;color:#fff;padding:4px 10px;border-radius:20px;font-size:.8rem;font-weight:600}
    footer{margin-top:48px;font-size:.85rem;color:#666;border-top:1px solid #ddd;padding-top:16px}
  </style>
</head>
<body>
  <p><span class="badge">EDUCA-CAPTURE</span></p>
  <h1>Política de Privacidade</h1>
  <p><strong>Última atualização:</strong> Maio de 2026</p>

  <h2>1. O que é o EDUCA-CAPTURE?</h2>
  <p>O EDUCA-CAPTURE é um aplicativo exclusivo do ecossistema <strong>EDUCA.MELHOR</strong> destinado exclusivamente a funcionários autorizados de instituições de ensino (gestores, secretários e coordenadores). Sua única finalidade é capturar e transmitir fotos de alunos <strong>diretamente para a plataforma EDUCA.MELHOR</strong>, sem armazenar nenhuma imagem no dispositivo.</p>

  <h2>2. Dados Coletados</h2>
  <ul>
    <li><strong>Fotos dos alunos:</strong> capturadas pela câmera do dispositivo e enviadas imediatamente ao servidor da escola. <em>Nenhuma foto é salva no aparelho.</em></li>
    <li><strong>Identificador do dispositivo (Device UID):</strong> gerado para autenticação do aparelho na escola. Não contém dados pessoais.</li>
    <li><strong>Logs de auditoria:</strong> data/hora e ID do aluno fotografado, para rastreabilidade conforme a LGPD.</li>
  </ul>

  <h2>3. Finalidade do Tratamento</h2>
  <p>Os dados são tratados exclusivamente para identificação visual dos alunos na plataforma da escola (lista de chamada, boletins e comunicados aos responsáveis), conforme consentimento coletado pela instituição de ensino.</p>

  <h2>4. Compartilhamento de Dados</h2>
  <p>Os dados <strong>não são compartilhados com terceiros</strong>. As fotos são armazenadas nos servidores da EDUCA.MELHOR (DigitalOcean Spaces — infraestrutura no Brasil) e acessíveis apenas pela escola contratante.</p>

  <h2>5. Retenção e Exclusão</h2>
  <p>As fotos permanecem enquanto o aluno estiver ativo na escola. Ao solicitar exclusão à instituição de ensino ou através de <a href="https://sistemaeducamelhor.com.br/excluir-conta">sistemaeducamelhor.com.br/excluir-conta</a>, os dados são removidos permanentemente.</p>

  <h2>6. Segurança</h2>
  <p>O aplicativo utiliza autenticação de dispositivo por token criptografado (Device Token), aprovação obrigatória pelo gestor da escola e comunicação exclusiva via HTTPS.</p>

  <h2>7. Direitos do Titular (LGPD)</h2>
  <p>Responsáveis legais pelos alunos podem solicitar acesso, correção ou exclusão dos dados fotográficos diretamente à instituição de ensino ou pelo e-mail <a href="mailto:privacidade@educamelhor.com.br">privacidade@educamelhor.com.br</a>.</p>

  <h2>8. Contato</h2>
  <p>EDUCA.MELHOR — Tecnologia Educacional<br/>
  E-mail: <a href="mailto:suporte@educamelhor.com.br">suporte@educamelhor.com.br</a><br/>
  Site: <a href="https://sistemaeducamelhor.com.br">sistemaeducamelhor.com.br</a></p>

  <footer>© 2026 EDUCA.MELHOR — Todos os direitos reservados. Este aplicativo é distribuído exclusivamente para instituições de ensino cadastradas.</footer>
</body>
</html>`);
});

// Suporte EDUCA-CAPTURE (redirect para a página de privacidade com contato)
app.get("/capture/suporte", (_req, res) => {
  res.redirect(301, "/capture/privacidade");
});


app.get("/api/visitantes-ping", (_req, res) =>
  res.json({
    ok: true,
    message: "router de visitantes acessível — /api/visitantes-ping",
  })
);

// ─── APP_PAIS: registrado em bootstrap() (ver função abaixo) ────────────────────


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
  // Migrations automáticas (idempotentes) — executam no boot
  // ============================================================================
  try {
    // [2026-04-22] Cancelamento de questão em lote no módulo Gabarito
    const [cols] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gabarito_avaliacoes' AND COLUMN_NAME = 'questoes_canceladas'
    `);
    if (cols.length === 0) {
      await pool.query(`
        ALTER TABLE gabarito_avaliacoes
          ADD COLUMN questoes_canceladas JSON DEFAULT NULL
          COMMENT 'Questoes anuladas em lote: [{numero, modo (bonificar|desconsiderar), motivo, cancelado_em, cancelado_por}]'
      `);
      console.log("[MIGRATION] Coluna 'questoes_canceladas' adicionada em 'gabarito_avaliacoes' ✅");
    }
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao aplicar migration questoes_canceladas (não crítico):", migErr.message);
  }

  // [2026-05-11] Data de aplicação da prova bimestral no módulo Gabarito
  try {
    const [colsDataApl] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gabarito_avaliacoes' AND COLUMN_NAME = 'data_aplicacao'
    `);
    if (colsDataApl.length === 0) {
      await pool.query(`
        ALTER TABLE gabarito_avaliacoes
          ADD COLUMN data_aplicacao DATE DEFAULT NULL
          COMMENT 'Data de aplicação da prova bimestral — definida pela direção ao criar o gabarito'
      `);
      console.log("[MIGRATION] Coluna 'data_aplicacao' adicionada em 'gabarito_avaliacoes' ✅");
    }
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao aplicar migration data_aplicacao (não crítico):", migErr.message);
  }

  // [2026-04-24] Tabela de OTP codes do App Pais
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_pais_codigos (
        id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
        responsavel_id INT UNSIGNED   NOT NULL,
        codigo        VARCHAR(6)      NOT NULL,
        canal         VARCHAR(10)     NOT NULL DEFAULT 'email',
        destino       VARCHAR(255)    NOT NULL,
        expiracao     DATETIME        NOT NULL,
        usado_em      DATETIME        DEFAULT NULL,
        criado_em     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_resp_codigo (responsavel_id, codigo),
        INDEX idx_expiracao   (expiracao)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Codigos OTP de acesso para responsaveis no App Pais'
    `);
    console.log("[MIGRATION] Tabela app_pais_codigos garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar app_pais_codigos (não crítico):", migErr.message);
  }

  // [2026-04-25] Rastreabilidade de quem REGISTROU a ocorrência disciplinar
  try {
    const [colsReg] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ocorrencias_disciplinares'
        AND COLUMN_NAME = 'usuario_registro_id'
    `);
    if (colsReg.length === 0) {
      await pool.query(`
        ALTER TABLE ocorrencias_disciplinares
          ADD COLUMN usuario_registro_id INT NULL DEFAULT NULL
          COMMENT 'ID do usuario que criou o registro (rastreabilidade)'
      `);
      console.log("[MIGRATION] Coluna 'usuario_registro_id' adicionada em 'ocorrencias_disciplinares' ✅");
    }
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao aplicar migration usuario_registro_id (não crítico):", migErr.message);
  }

  // [2026-05-16] Bônus Mérito: garantir coluna updated_at em ocorrencias_disciplinares
  try {
    const [colsUpd] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ocorrencias_disciplinares'
        AND COLUMN_NAME = 'updated_at'
    `);
    if (colsUpd.length === 0) {
      await pool.query(`
        ALTER TABLE ocorrencias_disciplinares
          ADD COLUMN updated_at DATETIME NULL DEFAULT NULL
          ON UPDATE CURRENT_TIMESTAMP
          COMMENT 'Última atualização do registro'
      `);
      console.log("[MIGRATION] Coluna 'updated_at' adicionada em 'ocorrencias_disciplinares' ✅");
    }
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao aplicar migration updated_at (não crítico):", migErr.message);
  }

  // [2026-05-26] Rastreabilidade Disciplinar — usuario_impressao_id + usuario_edicao_id
  try {
    const [colsRastreio] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ocorrencias_disciplinares'
        AND COLUMN_NAME IN ('usuario_impressao_id', 'usuario_edicao_id')
    `);
    const existentes = new Set(colsRastreio.map(c => c.COLUMN_NAME));
    const adds = [];
    if (!existentes.has('usuario_impressao_id'))
      adds.push(`ADD COLUMN usuario_impressao_id INT NULL DEFAULT NULL
        COMMENT 'ID do usuario que imprimiu o PDF do registro (rastreabilidade)'`);
    if (!existentes.has('usuario_edicao_id'))
      adds.push(`ADD COLUMN usuario_edicao_id INT NULL DEFAULT NULL
        COMMENT 'ID do usuario que editou o registro pela ultima vez (rastreabilidade)'`);
    if (adds.length > 0) {
      await pool.query(`ALTER TABLE ocorrencias_disciplinares ${adds.join(', ')}`);
      console.log("[MIGRATION] Colunas de rastreabilidade disciplinar adicionadas ✅");
    }
    // Índices (idempotentes — ignora ER_DUP_KEYNAME)
    for (const [col, idx] of [
      ['usuario_impressao_id', 'idx_usuario_impressao'],
      ['usuario_edicao_id',    'idx_usuario_edicao'],
    ]) {
      if (!existentes.has(col)) {
        try {
          await pool.query(`ALTER TABLE ocorrencias_disciplinares ADD INDEX ${idx} (${col})`);
        } catch (e) {
          if (e.code !== 'ER_DUP_KEYNAME') throw e;
        }
      }
    }
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao aplicar migration rastreabilidade disciplinar (não crítico):", migErr.message);
  }

  // [2026-05-23] Módulo Liberação Antecipada — tabela liberacoes_alunos
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS liberacoes_alunos (
        id                              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        escola_id                       INT           NOT NULL,
        aluno_id                        INT           NOT NULL,
        turma_id                        INT           DEFAULT NULL,
        data_hora_saida                 DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        motivo                          VARCHAR(255)  NOT NULL,
        observacao                      TEXT          DEFAULT NULL,
        responsavel_cadastrado_id       INT           DEFAULT NULL
          COMMENT 'FK responsaveis.id — preenchido quando o responsável é cadastrado',
        responsavel_nome_avulso         VARCHAR(255)  DEFAULT NULL
          COMMENT 'Nome quando não é responsável cadastrado',
        responsavel_parentesco_avulso   VARCHAR(50)   DEFAULT NULL,
        responsavel_telefone_avulso     VARCHAR(30)   DEFAULT NULL,
        registrado_por                  VARCHAR(255)  DEFAULT NULL,
        criado_em                       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_escola        (escola_id),
        INDEX idx_aluno         (aluno_id),
        INDEX idx_turma         (turma_id),
        INDEX idx_data          (data_hora_saida),
        INDEX idx_escola_data   (escola_id, data_hora_saida)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Registro de liberações antecipadas de alunos — Módulo Disciplinar'
    `);
    console.log("[MIGRATION] Tabela liberacoes_alunos garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar liberacoes_alunos (não crítico):", migErr.message);
  }

  // [2026-05-30] Logos institucionais das escolas
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS escola_logos (
        id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id     INT NOT NULL,
        label         VARCHAR(100) NOT NULL,
        posicao       ENUM('esquerda','direita','nenhuma') NOT NULL DEFAULT 'nenhuma',
        usos          JSON,
        key_original  VARCHAR(300),
        key_header    VARCHAR(300),
        key_thumb     VARCHAR(300),
        url_header    VARCHAR(500),
        url_thumb     VARCHAR(500),
        ordem         TINYINT DEFAULT 0,
        ativo         TINYINT(1) DEFAULT 1,
        criado_em     DATETIME DEFAULT CURRENT_TIMESTAMP,
        atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_escola (escola_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Logos institucionais das escolas gerenciadas pelo Diretor'
    `);
    console.log('[MIGRATION] Tabela escola_logos garantida ✅');
  } catch (migErr) {
    console.warn('[MIGRATION] Erro ao criar escola_logos (nao critico):', migErr.message);
  }

  // [2026-05-30] Capas de provas para geração de PDF
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS capa_provas (
        id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id    INT NOT NULL,
        titulo       VARCHAR(200) NOT NULL,
        area         ENUM('EXATAS','HUMANAS','LINGUAGENS','NATUREZA','GERAL') NOT NULL DEFAULT 'GERAL',
        serie        VARCHAR(50),
        turno        VARCHAR(50),
        bimestre     TINYINT NOT NULL DEFAULT 1,
        ano          YEAR NOT NULL,
        template_id  TINYINT NOT NULL DEFAULT 1,
        instrucoes   TEXT,
        qr_token     VARCHAR(64) NOT NULL,
        criado_por   INT,
        ativo        TINYINT(1) DEFAULT 1,
        criado_em    DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_qr_token (qr_token),
        INDEX idx_escola (escola_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Capas de provas geradas por escola'
    `);
    console.log('[MIGRATION] Tabela capa_provas garantida ✅');
  } catch (migErr) {
    console.warn('[MIGRATION] Erro ao criar capa_provas:', migErr.message);
  }

  // [2026-04-26] EDUCA-SCAN: expandir ENUM 'origem' em gabarito_respostas
  try {
    // Verifica se 'scan_mobile' já está no ENUM antes de alterar
    const [[enumRow]] = await pool.query(`
      SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'gabarito_respostas'
        AND COLUMN_NAME = 'origem'
      LIMIT 1
    `);
    if (enumRow && !String(enumRow.COLUMN_TYPE).includes('scan_mobile')) {
      await pool.query(`
        ALTER TABLE gabarito_respostas
          MODIFY COLUMN origem ENUM('omr','manual','scan_mobile') DEFAULT 'omr'
          COMMENT 'Origem: omr=scanner/batch, manual=digitação, scan_mobile=app celular'
      `);
      console.log("[MIGRATION] ENUM 'origem' em gabarito_respostas expandido (+ scan_mobile) ✅");
    }
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao expandir ENUM 'origem' (não crítico):", migErr.message);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // [2026-05-01] Banco Global de Questões — correta_texto + temas + tabelas
  // ─────────────────────────────────────────────────────────────────────────────

  // 1) Colunas novas em questoes: correta_texto (gabarito por conteúdo) + temas (JSON)
  try {
    const [colsQ] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'questoes'
        AND COLUMN_NAME IN ('correta_texto','temas','global_id','publicada_globalmente')
    `);
    const existentes = new Set(colsQ.map((c) => c.COLUMN_NAME));
    const addCols = [];
    if (!existentes.has("correta_texto"))
      addCols.push(`ADD COLUMN correta_texto TEXT DEFAULT NULL
        COMMENT 'Texto da alternativa correta — usado para gabarito por conteúdo em permutações'`);
    if (!existentes.has("temas"))
      addCols.push(`ADD COLUMN temas JSON DEFAULT NULL
        COMMENT 'Temas/conteúdos da questão: ex. ["Biologia Celular","Metabolismo"]'`);
    if (!existentes.has("global_id"))
      addCols.push(`ADD COLUMN global_id INT DEFAULT NULL
        COMMENT 'ID em questoes_banco_global se a questão foi publicada'`);
    if (!existentes.has("publicada_globalmente"))
      addCols.push(`ADD COLUMN publicada_globalmente TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '1 = questão publicada no banco global'`);
    if (addCols.length > 0)
      await pool.query(`ALTER TABLE questoes ${addCols.join(", ")}`);
    console.log("[MIGRATION] Colunas do banco global em questoes garantidas ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao alterar tabela questoes (não crítico):", migErr.message);
  }

  // 2) Tabela questoes_banco_global (banco público multi-escola)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questoes_banco_global (
        id                  INT          NOT NULL AUTO_INCREMENT,
        conteudo_bruto      TEXT         NOT NULL
          COMMENT 'Enunciado da questão',
        latex_formatado     TEXT         DEFAULT NULL,
        tipo                VARCHAR(20)  NOT NULL DEFAULT 'objetiva',
        nivel               VARCHAR(20)  NOT NULL DEFAULT 'medio',
        serie               VARCHAR(50)  DEFAULT NULL,
        disciplina          VARCHAR(100) DEFAULT NULL,
        habilidade_bncc     VARCHAR(100) DEFAULT NULL,
        temas               JSON         DEFAULT NULL
          COMMENT 'Array de temas: ["Célula","DNA"]',
        alternativas_json   JSON         DEFAULT NULL
          COMMENT '[{letra, texto}] — ordem original',
        correta             VARCHAR(5)   DEFAULT NULL
          COMMENT 'Letra da alternativa correta (Versão A)',
        correta_texto       TEXT         DEFAULT NULL
          COMMENT 'Texto da alternativa correta — invariante à permutação',
        texto_apoio         TEXT         DEFAULT NULL,
        fonte               VARCHAR(255) DEFAULT NULL,
        explicacao          TEXT         DEFAULT NULL,
        tags                TEXT         DEFAULT NULL,
        escola_id_origem    INT          DEFAULT NULL
          COMMENT 'Escola que publicou',
        professor_id_origem INT          DEFAULT NULL
          COMMENT 'Professor que publicou',
        uso_count           INT          NOT NULL DEFAULT 0
          COMMENT 'Total de usos em qualquer escola do sistema',
        status              ENUM('publicada','revisao','removida') NOT NULL DEFAULT 'publicada',
        publicada_em        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizada_em       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_disciplina  (disciplina),
        INDEX idx_nivel       (nivel),
        INDEX idx_uso         (uso_count),
        INDEX idx_status      (status),
        INDEX idx_escola_orig (escola_id_origem)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Banco Global EDUCA.MELHOR — questoes publicadas acessíveis por todas as escolas'
    `);
    console.log("[MIGRATION] Tabela questoes_banco_global garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar questoes_banco_global (não crítico):", migErr.message);
  }

  // 3) Tabela questoes_uso_escola (banco específico por escola + ranking global)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questoes_uso_escola (
        id                INT      NOT NULL AUTO_INCREMENT,
        questao_global_id INT      NOT NULL
          COMMENT 'FK questoes_banco_global.id',
        escola_id         INT      NOT NULL,
        professor_id      INT      DEFAULT NULL,
        contexto          VARCHAR(50) DEFAULT NULL
          COMMENT 'prova | exercicio | atividade',
        contexto_id       INT      DEFAULT NULL
          COMMENT 'ID da prova/atividade que usou a questão',
        usado_em          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_escola          (escola_id),
        INDEX idx_questao         (questao_global_id),
        INDEX idx_escola_questao  (escola_id, questao_global_id),
        INDEX idx_professor       (professor_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Rastreamento de uso: escola×questao — gera banco específico por escola'
    `);
    console.log("[MIGRATION] Tabela questoes_uso_escola garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar questoes_uso_escola (não crítico):", migErr.message);
  }

  // [2026-05-19] Modulação Inteligente: carga de disciplina por etapa+turno por escola
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disciplina_carga_segmento (
        id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
        escola_id     INT             NOT NULL,
        disciplina_id INT             NOT NULL,
        etapa         VARCHAR(80)     NOT NULL COMMENT 'Ex: Fundamental, Médio, Técnico',
        turno         VARCHAR(50)     NOT NULL COMMENT 'Ex: Matutino, Vespertino, Noturno',
        carga         INT UNSIGNED    NOT NULL DEFAULT 1 COMMENT 'Nº de aulas por turma por semana',
        criado_em     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_disc_seg (escola_id, disciplina_id, etapa, turno),
        INDEX idx_escola_disc (escola_id, disciplina_id),
        INDEX idx_escola_etapa (escola_id, etapa, turno)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Modulação inteligente: aulas por disciplina × etapa × turno por escola'
    `);
    console.log("[MIGRATION] Tabela disciplina_carga_segmento garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar disciplina_carga_segmento (não crítico):", migErr.message);
  }

  // [2026-05-20] Plano de Avaliação Pedagógica — controle de status por professor/escola/ano
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plano_avaliacao (
        id            INT           NOT NULL AUTO_INCREMENT,
        escola_id     INT           NOT NULL,
        professor_id  INT           NOT NULL,
        ano_letivo    INT           NOT NULL,
        status        ENUM('nao_iniciado','rascunho','enviado','aprovado','revisao')
                      NOT NULL DEFAULT 'nao_iniciado',
        observacoes   TEXT          DEFAULT NULL,
        criado_em     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                      ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_escola_prof_ano (escola_id, professor_id, ano_letivo),
        INDEX idx_escola_ano (escola_id, ano_letivo),
        INDEX idx_professor  (professor_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Plano de Avaliação Pedagógica — status de entrega por professor, escola e ano letivo'
    `);
    console.log("[MIGRATION] Tabela plano_avaliacao garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar plano_avaliacao (não crítico):", migErr.message);
  }

  // ============================================================================
  // [2026-05-23 v2] MÓDULO BIBLIOTECA — Acervo Universal + Estoque por Escola
  //   biblioteca_acervo       → catálogo universal (sem escola_id)
  //   biblioteca_acervo_escola → exemplares por escola
  //
  // ⚠️ NUNCA usar DROP TABLE aqui — essa migration roda a cada restart/deploy!
  //    Usar apenas CREATE TABLE IF NOT EXISTS + ALTER TABLE para evoluir schema.
  // ============================================================================

  // ── Garante tabela universal de livros ──────────────────────────────────────
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS biblioteca_acervo (
        id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
        isbn           VARCHAR(20)  DEFAULT NULL,
        titulo         VARCHAR(500) NOT NULL,
        autor          VARCHAR(500) DEFAULT NULL,
        editora        VARCHAR(300) DEFAULT NULL,
        ano_publicacao INT          DEFAULT NULL COMMENT 'Apenas o ano (4 dígitos)',
        genero         VARCHAR(200) DEFAULT NULL,
        categoria      ENUM('infantil','juvenil','adulto','didatico','paradidatico','referencia','outro')
                       NOT NULL DEFAULT 'juvenil',
        sinopse        TEXT         DEFAULT NULL,
        num_paginas    INT          DEFAULT NULL,
        capa_url       TEXT         DEFAULT NULL,
        criado_em      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_titulo (titulo(100))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Catálogo universal de livros — compartilhado entre todas as escolas'
    `);
    console.log('[MIGRATION] Tabela biblioteca_acervo garantida ✅');
  } catch (migErr) {
    console.warn('[MIGRATION] Erro ao criar biblioteca_acervo (não crítico):', migErr.message);
  }

  // ── Evolução de schema: remover escola_id se ainda existir (versão antiga) ──
  try {
    const [[cols]] = await pool.query(`
      SELECT COUNT(*) AS tem
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'biblioteca_acervo'
        AND COLUMN_NAME  = 'escola_id'
    `);
    if (cols.tem > 0) {
      // Remove índices dependentes antes de dropar a coluna
      await pool.query(`ALTER TABLE biblioteca_acervo DROP INDEX IF EXISTS idx_escola`).catch(() => {});
      await pool.query(`ALTER TABLE biblioteca_acervo DROP COLUMN escola_id`);
      console.log('[MIGRATION] biblioteca_acervo: coluna escola_id removida (migração para universal) ✅');
    }
  } catch (migErr) {
    console.warn('[MIGRATION] biblioteca_acervo evolução schema (não crítico):', migErr.message);
  }

  // ── Garante UNIQUE em isbn (se não existir) ──────────────────────────────────
  try {
    const [[ukRow]] = await pool.query(`
      SELECT COUNT(*) AS tem
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'biblioteca_acervo'
        AND INDEX_NAME   = 'uk_isbn'
    `);
    if (ukRow.tem === 0) {
      // Remove duplicatas por isbn antes de criar o unique (segurança)
      await pool.query(`
        DELETE ba1 FROM biblioteca_acervo ba1
        INNER JOIN biblioteca_acervo ba2
          ON ba1.isbn = ba2.isbn AND ba1.isbn IS NOT NULL AND ba1.id > ba2.id
      `).catch(() => {});
      await pool.query(`ALTER TABLE biblioteca_acervo ADD UNIQUE KEY uk_isbn (isbn)`);
      console.log('[MIGRATION] biblioteca_acervo: índice uk_isbn adicionado ✅');
    }
  } catch (migErr) {
    console.warn('[MIGRATION] biblioteca_acervo uk_isbn (não crítico):', migErr.message);
  }

  // ── Garante tabela de estoque por escola ─────────────────────────────────────
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS biblioteca_acervo_escola (
        id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
        acervo_id              INT UNSIGNED NOT NULL,
        escola_id              INT          NOT NULL,
        exemplares             INT          NOT NULL DEFAULT 1,
        exemplares_disponiveis INT          NOT NULL DEFAULT 1,
        ativo                  TINYINT(1)   NOT NULL DEFAULT 1,
        criado_em              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_acervo_escola (acervo_id, escola_id),
        INDEX idx_escola (escola_id),
        CONSTRAINT fk_bae_acervo FOREIGN KEY (acervo_id)
          REFERENCES biblioteca_acervo(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Estoque de exemplares por escola — acervo escolar'
    `);
    console.log('[MIGRATION] Tabela biblioteca_acervo_escola garantida ✅');
  } catch (migErr) {
    console.warn('[MIGRATION] Erro ao criar biblioteca_acervo_escola (não crítico):', migErr.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS biblioteca_emprestimos (
        id                        INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id                 INT NOT NULL,
        livro_id                  INT UNSIGNED NOT NULL,
        aluno_id                  INT NOT NULL,
        data_emprestimo           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        data_prevista_devolucao   DATE DEFAULT NULL,
        data_devolucao            DATETIME DEFAULT NULL,
        status                    ENUM('ativo','devolvido','atrasado') NOT NULL DEFAULT 'ativo',
        registrado_por            VARCHAR(255) DEFAULT NULL,
        observacao                TEXT DEFAULT NULL,
        PRIMARY KEY (id),
        INDEX idx_escola (escola_id),
        INDEX idx_livro (livro_id),
        INDEX idx_aluno (aluno_id),
        INDEX idx_status (status),
        INDEX idx_escola_aluno (escola_id, aluno_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Controle de empréstimos da biblioteca escolar'
    `);
    console.log("[MIGRATION] Tabela biblioteca_emprestimos garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar biblioteca_emprestimos (não crítico):", migErr.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS biblioteca_resenhas (
        id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id        INT NOT NULL,
        livro_id         INT UNSIGNED NOT NULL,
        aluno_id         INT NOT NULL,
        turma_id         INT DEFAULT NULL,
        resumo           TEXT DEFAULT NULL,
        resenha          TEXT DEFAULT NULL,
        favorito         VARCHAR(1000) DEFAULT NULL,
        avaliacao        TINYINT DEFAULT NULL COMMENT '1-5 estrelas',
        respostas_json   JSON DEFAULT NULL COMMENT 'Perguntas respondidas [{pergunta, resposta}]',
        status           ENUM('rascunho','enviado','aprovado','destaque') NOT NULL DEFAULT 'enviado',
        pontuacao        DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        aprovado_por     VARCHAR(255) DEFAULT NULL,
        criado_em        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_escola (escola_id),
        INDEX idx_livro (livro_id),
        INDEX idx_aluno (aluno_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Resenhas e atividades do Leitor Destaque'
    `);
    console.log("[MIGRATION] Tabela biblioteca_resenhas garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar biblioteca_resenhas (não crítico):", migErr.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS biblioteca_concurso (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id   INT NOT NULL,
        titulo      VARCHAR(500) NOT NULL,
        descricao   TEXT DEFAULT NULL,
        data_inicio DATE DEFAULT NULL,
        data_fim    DATE DEFAULT NULL,
        status      ENUM('rascunho','ativo','encerrado') NOT NULL DEFAULT 'rascunho',
        regras_json JSON DEFAULT NULL,
        criado_em   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_escola (escola_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Concursos e culminâncias de leitura'
    `);
    console.log("[MIGRATION] Tabela biblioteca_concurso garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar biblioteca_concurso (não crítico):", migErr.message);
  }

  // [2026-06-08] Registro de Conselho de Classe — comentários por aluno com rastreabilidade
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS registro_conselho (
        id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        escola_id        INT           NOT NULL,
        aluno_codigo     VARCHAR(30)   NOT NULL,
        turma_id         INT           DEFAULT NULL,
        texto            TEXT          NOT NULL,
        usuario_id       INT           DEFAULT NULL,
        usuario_nome     VARCHAR(255)  NOT NULL DEFAULT 'Usuário',
        usuario_perfil   VARCHAR(100)  NOT NULL DEFAULT 'professor',
        criado_em        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        editado_em       DATETIME      DEFAULT NULL,
        editado_por_nome VARCHAR(255)  DEFAULT NULL,
        PRIMARY KEY (id),
        INDEX idx_escola_aluno (escola_id, aluno_codigo),
        INDEX idx_turma        (turma_id),
        INDEX idx_criado       (criado_em)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Registros de Conselho de Classe por aluno — rastreabilidade por usuário'
    `);
    console.log("[MIGRATION] Tabela registro_conselho garantida ✅");
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao criar registro_conselho (não crítico):", migErr.message);
  }

  // [2026-06-08 v2] Evolução: adiciona colunas de edição em registro_conselho (se já existia)
  try {
    const [[colEditadoEm]] = await pool.query(`
      SELECT COUNT(*) AS tem FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'registro_conselho' AND COLUMN_NAME = 'editado_em'
    `);
    if (colEditadoEm.tem === 0) {
      await pool.query(`ALTER TABLE registro_conselho ADD COLUMN editado_em DATETIME DEFAULT NULL AFTER criado_em`);
      await pool.query(`ALTER TABLE registro_conselho ADD COLUMN editado_por_nome VARCHAR(255) DEFAULT NULL AFTER editado_em`);
      console.log("[MIGRATION] registro_conselho: colunas editado_em + editado_por_nome adicionadas ✅");
    }
  } catch (migErr) {
    console.warn("[MIGRATION] registro_conselho evolução schema (não crítico):", migErr.message);
  }

  // [2026-05-29] Item de governanca para o Boletim Manual do Professor
  try {
    const [[existItem]] = await pool.query(
      "SELECT 1 FROM governanca_itens WHERE chave = 'escola.permitir_boletim_manual' LIMIT 1"
    );
    if (!existItem) {
      await pool.query(`
        INSERT INTO governanca_itens 
          (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem, ativo)
        VALUES 
          (2, 'escola.permitir_boletim_manual', 'Professor pode lancar notas e faltas no boletim manualmente', 'boolean', NULL, '0', 4, 1)
      `);
      console.log("[MIGRATION] Item de governanca 'escola.permitir_boletim_manual' inserido em 'governanca_itens' ✅");
    }
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao aplicar migration 'escola.permitir_boletim_manual' (nao critico):", migErr.message);
  }

  // [2026-05-29] Item de governanca para Excecoes de Avaliacao Bimestral por disciplina
  try {
    const [[existItemExc]] = await pool.query(
      "SELECT 1 FROM governanca_itens WHERE chave = 'escola.avaliacao_padrao_bimestral.excecoes' LIMIT 1"
    );
    if (!existItemExc) {
      await pool.query(`
        INSERT INTO governanca_itens 
          (categoria_id, chave, descricao, tipo, opcoes_json, valor_padrao, ordem, ativo)
        VALUES 
          (7, 'escola.avaliacao_padrao_bimestral.excecoes', 'Disciplinas de excecao que nao adotam avaliacao padrao bimestral', 'text', NULL, '[]', 8, 1)
      `);
      console.log("[MIGRATION] Item de governanca 'escola.avaliacao_padrao_bimestral.excecoes' inserido em 'governanca_itens' ✅");
    }
  } catch (migErr) {
    console.warn("[MIGRATION] Erro ao aplicar migration 'escola.avaliacao_padrao_bimestral.excecoes' (nao critico):", migErr.message);
  }

  // [2026-05-29] One-time Sync: Sincroniza todos os planos de avaliação de todas as escolas ativas no boot
  try {
    const [escolas] = await pool.query("SELECT id FROM escolas");
    console.log(`[BOOT-SYNC-PAPs] Iniciando sincronizacao em lote para ${escolas.length} escolas...`);
    for (const esc of escolas) {
      await syncPlanosAvaliacao(pool, esc.id);
    }
    console.log("[BOOT-SYNC-PAPs] Sincronizacao em lote concluida com sucesso! ");
  } catch (syncErr) {
    console.warn("[BOOT-SYNC-PAPs] Falha na sincronizacao em lote no boot:", syncErr.message);
  }


  // ============================================================================
  // Plataforma (CEO/Admin Global) — rotas públicas próprias (NÃO dependem de escola)
  // ============================================================================
  app.use("/api/auth-plataforma", authPlataformaRouter);
  app.use("/api/plataforma", autenticarToken, exigirEscopo("plataforma"), plataformaRouter);
  app.use("/api/plataforma/usage", autenticarToken, exigirEscopo("plataforma"), plataformaUsageRouter);
  app.use("/api/plataforma/suporte", autenticarToken, exigirEscopo("plataforma"), plataformaSuporteRouter);
  app.use("/api/plataforma/governanca", autenticarToken, exigirEscopo("plataforma"), plataformaGovernancaRouter);


  // ─── APP_PAIS ──────────────────────────────────────────────────────────────────
  // IMPORTANTE: montar com appPaisRouterModule (import estático) diretamente,
  // SEM if-block e SEM a variável `appPaisRouter`. Routes relativas (/ping, /me...)
  // + app.use(prefix, router) funciona corretamente em Express 5 neste contexto.
  app.use("/api/app-pais", appPaisRouterModule);
  console.log("[FF] FF_APP_PAIS: router montado em /api/app-pais ✅ stack:", appPaisRouterModule.stack?.length);

  if (responsavelRoutes) app.use(responsavelRoutes);
  if (deviceRoutes) app.use(deviceRoutes);

  if (captureRoutes) {
    app.use("/api/capture", captureRoutes);
    console.log("[FF] FF_EDUCA_CAPTURE: router montado em /api/capture ✅");
  } else {
    console.error("[FF] FF_EDUCA_CAPTURE: captureRoutes é NULL — rota /api/capture NÃO montada ❌");
  }



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
    // ✅ EDUCA.PROVA — Montador de Provas
    app.use("/api/provas", autenticarToken, verificarEscola, provasRouter);
    // ✅ EDUCA.PROVA — Geração de HTML/PDF (Playwright)
    app.use("/api/provas", autenticarToken, verificarEscola, provaPdfRouter);
  } else {
    console.log("[FF] Questões desativado");
  }

  app.use("/api/escolas", autenticarToken, verificarEscola, escolasRouter);

  // ✅ MÓDULO BIBLIOTECA
  app.use("/api/biblioteca", bibliotecaRouter);

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
  // ✅ Agente EDUCA — Exportar PAP para EDUCADF (Playwright)
  app.use("/api/agente-planos", autenticarToken, verificarEscola, agentePlanosRouter);


  // ⚠️ BOLETINS (temporariamente OFF)
  // app.use("/api/boletins", autenticarToken, verificarEscola, boletinsRouter);

  // ✅ Rotas públicas de usuários (cadastro) — sem token, mas exige escola
  app.use("/api/usuarios", verificarEscola, usuariosPublicRouter);

  // 🔒 Rotas protegidas de usuários
  app.use("/api/usuarios", autenticarToken, verificarEscola, usuariosRouter);
  app.use("/api/codigos", autenticarToken, verificarEscola, codigosRouter);
  app.use("/api/registros-ocorrencias", autenticarToken, verificarEscola, registrosOcorrenciasRouter);
  app.use("/api/responsaveis", autenticarToken, verificarEscola, responsaveisRouter);

  // ✅ Registros de Conselho de Classe — comentários rastreáveis por aluno
  app.use("/api/conselho", autenticarToken, verificarEscola, conselhoRouter);
  app.use("/api/termo-consentimento", autenticarToken, verificarEscola, termoConsentimentoRouter);
  app.use("/api/tace", autenticarToken, verificarEscola, taceRouter);
  app.use("/api/disciplinar-atas", autenticarToken, verificarEscola, disciplinarAtasRouter);
  app.use("/api/disciplinar-liberacoes", autenticarToken, verificarEscola, disciplinarLiberacoesRouter);
  app.use("/api/relatorio-disciplinar", autenticarToken, verificarEscola, relatorioDisciplinarRouter);
  app.use("/api/disciplinar-metadados", autenticarToken, verificarEscola, disciplinarMetadadosRouter);
  app.use("/api/listas-impressao", autenticarToken, verificarEscola, listasImpressaoRouter);
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

  // ✅ Governança — Configurações da escola (Diretor / Vice-Diretor)
  app.use("/api/governanca", autenticarToken, verificarEscola, governancaRouter);

  // ✅ Logos institucionais — Gerenciamento pelo Diretor / Vice-Diretor
  app.use("/api/escola-logos", autenticarToken, verificarEscola, escolaLogosRouter);

  // ✅ Capas de Provas — Geração de PDF com templates e QR Code
  app.use("/api/capa-provas", autenticarToken, verificarEscola, capaProvasRouter);

  // ✅ BNCC cascade — import estático, sem feature flag, sem risco de 404 por falha de módulo
  app.use("/api", autenticarToken, verificarEscola, bnccCascadeRouter);

  // ✅ MÓDULO FREQUÊNCIA — Atestados, Busca Ativa, Relatórios, Conselho Tutelar
  app.use("/api/frequencia", autenticarToken, verificarEscola, frequenciaRouter);

  // ✅ RELATÓRIOS DA SECRETARIA — Matrículas, Idades, Turmas, Gênero
  app.use("/api/secretaria/relatorios", autenticarToken, verificarEscola, secretariaRelatoriosRouter);

  // ✅ PDF RELATÓRIOS DA SECRETARIA
  app.use("/api/secretaria/relatorios/pdf", autenticarToken, verificarEscola, secretariaRelatoriosPdfRouter);

  // ✅ AGENTE AUTÔNOMO DA SECRETARIA (SEEDF PDF Parser real)
  app.use("/api/secretaria/agente", autenticarToken, verificarEscola, secretariaAgenteRouter);

  // ✅ Relatórios Pedagógicos (Plano de Avaliação, etc.)
  app.use("/api/pedagogico/relatorios", autenticarToken, verificarEscola, pedagogicoRelatoriosRouter);

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
    // ✅ Injeta pool do server.js (evita re-import dinâmico que falha em produção com host errado)
    app.use("/api/monitoramento/ingest", (req, _res, next) => { req.db = pool; next(); }, monitoramentoIngestRouter);
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
