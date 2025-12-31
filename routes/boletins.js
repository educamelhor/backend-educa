// api/routes/boletins.js
// ============================================================================
// Geração de PDF dos BOLETINS via Puppeteer
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
import puppeteer from "puppeteer";
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
 * Lança o Puppeteer com flags seguras no ambiente do servidor.
 */
async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=medium",
    ],
  });
}

/**
 * Tenta navegar para a URL com estratégias de espera diferentes.
 * Aumenta a chance de evitar TimeoutError por conta de requests longas.
 */
async function robustGoto(page, url) {
  const TIMEOUT = 180_000; // 180s
  // 1) Primeira tentativa: 'networkidle0'
  try {
    await page.goto(url, { waitUntil: "networkidle0", timeout: TIMEOUT });
    return;
  } catch (_) {
    // continua para fallback
  }
  // 2) Segunda tentativa: 'networkidle2'
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: TIMEOUT });
    return;
  } catch (_) {
    // continua para fallback
  }
  // 3) Terceira tentativa: 'domcontentloaded'
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
}

/**
 * Espera pelo seletor final de render (#render-completo) com um pequeno delay
 * para estabilizar o layout antes de imprimir.
 */
async function waitRenderComplete(page) {
  // aguarda o seletor de “pronto para imprimir”
  await page.waitForSelector("#render-completo", { timeout: 120_000 });
  // pequeno grace period para fontes/imagens
  await new Promise((r) => setTimeout(r, 800));
}

/**
 * Gera um buffer de PDF em A4, sem margens, com fundo.
 */
async function makePDF(page) {
  return page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
    preferCSSPageSize: true,
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
  const { turma_id } = req.body;
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

    // 2) Monta a URL de impressão
    const url = `${BASE_URL}/print/boletins?turma_id=${encodeURIComponent(
      turma_id
    )}&secret=${encodeURIComponent(PRINT_SECRET)}`;

    let browser;
    try {
      // 3) Browser + Página
      browser = await launchBrowser();
      const page = await browser.newPage();

      // 4) Navega com robustez e espera sinal de render
      await robustGoto(page, url);
      await waitRenderComplete(page);

      // 5) Gera o PDF
      const pdfBuffer = await makePDF(page);

      // 6) Envia resposta
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
    console.error("Erro ao gerar PDF com Puppeteer:", error);
    return res.status(500).json({ error: "Erro ao gerar PDF" });
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
    const url = `${BASE_URL}/print/boletins?turma_id=${encodeURIComponent(
      turma_id
    )}&secret=${encodeURIComponent(PRINT_SECRET)}`;

    let browser;
    try {
      // 4) Browser + nova página
      browser = await launchBrowser();
      const page = await browser.newPage();

      // 5) Injeta token/escola_id no localStorage ANTES do app montar
      await page.evaluateOnNewDocument((tkn, escolaId) => {
        try {
          localStorage.setItem("token", tkn || "");
          if (escolaId) localStorage.setItem("escola_id", String(escolaId));
        } catch {
          // ignore storage errors
        }
      }, token, escola_id);

      // 6) Navega com robustez e espera render final
      await robustGoto(page, url);
      await waitRenderComplete(page);

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
    console.error("Erro ao gerar PDF de turma:", error);
    return res.status(500).json({ error: "Erro ao gerar PDF da turma" });
  }
});

export default router;
