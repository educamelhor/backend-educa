/**
 * Teste local ISOLADO do roteamento do app_pais.
 * Roda sem DB — apenas testa se as rotas registradas no router
 * respondem corretamente quando montadas com app.use() sem prefixo.
 *
 * Uso: node _test_route_local.mjs
 */
import express from "express";

// Simular o router do app_pais manualmente (sem importar o real, que precisa de DB)
const router = express.Router();
router.get("/api/app-pais/ping", (req, res) => {
  res.json({ ok: true, msg: "ping via router com path completo", url: req.url, baseUrl: req.baseUrl });
});
router.post("/api/app-pais/solicitar-codigo", (req, res) => {
  res.json({ ok: true, msg: "solicitar-codigo via router", body: req.body });
});

const app = express();
app.use(express.json());

// Montar SEM prefixo (modo atual)
app.use(router);

// Também testar com app.get direto
app.get("/api/app-pais/_test-direct", (_req, res) => {
  res.json({ ok: true, msg: "app.get direto funciona" });
});

const PORT = 4567;
const server = app.listen(PORT, async () => {
  console.log(`✅ Server test na porta ${PORT}`);
  console.log(`   Router stack: ${router.stack.length} routes`);

  const fetch = (await import("node-fetch")).default;

  try {
    const r1 = await fetch(`http://localhost:${PORT}/api/app-pais/ping`);
    const j1 = await r1.json();
    console.log("\n📍 GET /api/app-pais/ping:", r1.status, JSON.stringify(j1));

    const r2 = await fetch(`http://localhost:${PORT}/api/app-pais/_test-direct`);
    const j2 = await r2.json();
    console.log("📍 GET /api/app-pais/_test-direct:", r2.status, JSON.stringify(j2));

    const r3 = await fetch(`http://localhost:${PORT}/api/app-pais/solicitar-codigo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cpf: "12345678901" }),
    });
    const j3 = await r3.json();
    console.log("📍 POST /api/app-pais/solicitar-codigo:", r3.status, JSON.stringify(j3));
  } finally {
    server.close();
  }
});
