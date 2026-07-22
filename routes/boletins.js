// api/routes/boletins.js
// ============================================================================
// Geração de PDF dos BOLETINS via Playwright
// - Rotas:
//     POST /api/boletins/gerar        → (fluxo clássico, com validação de escola)
//     POST /api/boletins/gerar-turma  → (boletins da turma inteira, injeta token/localStorage)
// - Robusteza:
//     • Fallbacks no page.goto (diferentes waitUntil)
//     • Espera explícita pelo #render-completo (com grace period)
//     • Fechamento garantido do browser (try/finally)
//     • Variáveis de ambiente para BASE_URL e PRINT_SECRET
// - Segurança/escopo:
//     • Confere se a turma pertence à escola do usuário (req.user.escola_id)
// ============================================================================

import express from "express";
import { chromium } from "playwright";
import pool from "../db.js";

const router = express.Router();

// -----------------------------------------------------------------------------
// Middleware simples para validar que req.user.escola_id existe
// (assume que algum auth middleware anterior já populou req.user)
// -----------------------------------------------------------------------------
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ error: "Acesso negado: escola não definida." });
  }
  next();
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Lança o Chromium com flags seguras no ambiente do servidor.
 */
async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
}

/**
 * Tenta navegar para a URL com estratégias de espera diferentes.
 * Aumenta a chance de evitar TimeoutError por conta de requests longas.
 */
async function robustGoto(page, url) {
  const TIMEOUT = 180_000; // 180s
  // 1) Primeira tentativa: 'domcontentloaded'
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    return;
  } catch (_) {
    // continua para fallback
  }
  // 2) Segunda tentativa: 'load'
  try {
    await page.goto(url, { waitUntil: "load", timeout: TIMEOUT });
    return;
  } catch (_) {
    // continua para fallback
  }
  // 3) Terceira tentativa: 'networkidle'
  await page.goto(url, { waitUntil: "networkidle", timeout: TIMEOUT });
}

/**
 * Espera pelo seletor final de render (#render-completo) com um pequeno delay
 * para estabilizar o layout antes de imprimir.
 */
async function waitRenderComplete(page) {
  // Aguarda o elemento #render-completo ser inserido no DOM.
  // Usamos state:'attached' porque o elemento tem display:none por design
  // (o padrão 'visible' nunca seria satisfeito e causaria timeout).
  await page.waitForSelector("#render-completo", {
    state: "attached",
    timeout: 120_000,
  });
  // Grace period para fontes/imagens terminarem de renderizar
  await new Promise((r) => setTimeout(r, 1200));
}

/**
 * Ativa o modo de mídia CSS 'print' na página.
 * SEM isso, as regras @media print do CSS Module são IGNORADAS pelo Playwright,
 * causando página em branco (min-height:100vh) e conteúdo sem centralizar.
 */
async function enablePrintMedia(page) {
  await page.emulateMedia({ media: "print" });
}

/**
 * Gera um buffer de PDF em A4 landscape, com margens ajustadas.
 * - top 22mm: margem superior generosa para compensar área não imprimível.
 * - bottom 8mm: evita espaço em branco excessivo no rodapé.
 * - left/right 18mm: margens laterais elegantes (colunas compactadas no CSS).
 * - preferCSSPageSize: respeita o @page do CSS Module.
 */
async function makePDF(page) {
  return page.pdf({
    format: "A4",
    landscape: true,
    printBackground: true,
    margin: { top: "22mm", bottom: "8mm", left: "18mm", right: "18mm" },
    preferCSSPageSize: false, // usa format+landscape acima
  });
}

// -----------------------------------------------------------------------------
// Utiliza BASE_URL e PRINT_SECRET do ambiente (com defaults seguros em dev)
// -----------------------------------------------------------------------------
const BASE_URL = process.env.PRINT_BASE_URL || "http://localhost:5173";
const PRINT_SECRET = process.env.PRINT_SECRET || "123456";

// ============================================================================
// ROTA 1: POST /api/boletins/gerar
// - Fluxo consolidado (gera PDF a partir de uma turma)
// ============================================================================
router.post("/gerar", verificarEscola, async (req, res) => {
  const { turma_id, ano } = req.body;
  const { escola_id } = req.user;

  if (!turma_id) {
    return res.status(400).json({ error: "turma_id obrigatório" });
  }

  try {
    // 1) Verifica se a turma pertence à escola do usuário
    const [[turma]] = await pool.query(
      "SELECT id FROM turmas WHERE id = ? AND escola_id = ?",
      [turma_id, escola_id]
    );
    if (!turma) {
      return res.status(403).json({
        error: "Turma não encontrada ou não pertence à sua escola.",
      });
    }

    // 2) Token do header (Authorization: Bearer <token>)
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");

    // 3) Monta a URL de impressão (inclui ano se fornecido)
    const requestOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
    const finalBaseUrl = process.env.PRINT_BASE_URL || requestOrigin || BASE_URL;
    const anoParam = ano ? `&ano=${encodeURIComponent(ano)}` : "";
    const url = `${finalBaseUrl}/print/boletins?turma_id=${encodeURIComponent(
      turma_id
    )}&secret=${encodeURIComponent(PRINT_SECRET)}${anoParam}`;

    let browser;
    try {
      // 4) Browser + Página
      browser = await launchBrowser();
      const page = await browser.newPage();

      // 5) Injeta token e escola_id no localStorage ANTES de navegar
      //    → Evita que o React redirecione para /login por falta de autenticação
      await page.addInitScript(({ token, escola_id }) => {
        try {
          localStorage.setItem("token", token || "");
          if (escola_id) localStorage.setItem("escola_id", String(escola_id));
        } catch (e) {
          // ignore storage errors (sandboxed environments)
        }
      }, { token, escola_id });

      // 5b) Ativa @media print — sem isso as regras print do CSS Module
      //     (min-height:unset, margens, etc.) são IGNORADAS pelo Playwright.
      await enablePrintMedia(page);

      // 6) Navega com robustez e espera sinal de render
      await robustGoto(page, url);
      await waitRenderComplete(page);

      // 6b) Garante que o modo print está ativo após a navegação
      //     (navegar pode fazer reset da emulação em alguns browsers)
      await enablePrintMedia(page);

      // 7) Gera o PDF
      const pdfBuffer = await makePDF(page);

      // 8) Envia resposta
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
          "Content-Disposition",
          `attachment; filename=Boletins_Turma_${turma_id}.pdf`
      );
      res.send(pdfBuffer);
    } finally {
      if (browser) await browser.close();
    }
  } catch (error) {
    console.error("Erro ao gerar PDF com Playwright:", error);
    return res.status(500).json({ error: "Erro ao gerar PDF", message: error.message, stack: error.stack });
  }
});

// ============================================================================
// ROTA 2: POST /api/boletins/gerar-turma
// - Gera boletins da turma inteira
// - Injeta token e escola_id no localStorage ANTES do front carregar
// ============================================================================
router.post("/gerar-turma", verificarEscola, async (req, res) => {
  const { turma_id } = req.body;
  const { escola_id } = req.user;

  if (!turma_id) {
    return res.status(400).json({ error: "turma_id obrigatório" });
  }

  try {
    // 1) Confere turma x escola
    const [[turma]] = await pool.query(
      "SELECT id FROM turmas WHERE id = ? AND escola_id = ?",
      [turma_id, escola_id]
    );
    if (!turma) {
      return res.status(403).json({
        error: "Turma não encontrada ou não pertence à sua escola.",
      });
    }

    // 2) Token do header (Authorization: Bearer <token>)
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");

    // 3) URL de impressão
    const requestOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
    const finalBaseUrl = process.env.PRINT_BASE_URL || requestOrigin || BASE_URL;
    const url = `${finalBaseUrl}/print/boletins?turma_id=${encodeURIComponent(
      turma_id
    )}&secret=${encodeURIComponent(PRINT_SECRET)}`;

    let browser;
    try {
      // 4) Browser + nova página
      browser = await launchBrowser();
      const page = await browser.newPage();

      // 5) Injeta token/escola_id no localStorage ANTES do app montar
      await page.addInitScript(({ token, escola_id }) => {
        try {
          localStorage.setItem("token", token || "");
          if (escola_id) localStorage.setItem("escola_id", String(escola_id));
        } catch (e) {
          // ignore storage errors
        }
      }, { token, escola_id });

      // 5b) Ativa @media print (mesmo motivo da rota /gerar)
      await enablePrintMedia(page);

      // 6) Navega com robustez e espera render final
      await robustGoto(page, url);
      await waitRenderComplete(page);

      // 6b) Re-aplica print media após navegação
      await enablePrintMedia(page);

      // 7) Gera PDF
      const pdfBuffer = await makePDF(page);

      // 8) Envia resultado
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
          "Content-Disposition",
          `attachment; filename=Boletins_Turma_${turma_id}.pdf`
      );
      res.send(pdfBuffer);
    } finally {
      if (browser) await browser.close();
    }
  } catch (error) {
    console.error("Erro ao gerar PDF de turma com Playwright:", error);
    return res.status(500).json({ error: "Erro ao gerar PDF da turma", message: error.message, stack: error.stack });
  }
});

export default router;
