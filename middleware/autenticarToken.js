// api/middleware/autenticarToken.js
// ============================================================================
// Middleware para validar o token JWT enviado pelo cliente
// O token deve estar no formato: "Authorization: Bearer <token>"
// Adicionados logs detalhados para depuração.
// ============================================================================

import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "superseguro";

export function autenticarToken(req, res, next) {
  // --------------------------------------------------------------------------
  // Log inicial — entrada no middleware
  // --------------------------------------------------------------------------
  console.log("\n[DEBUG autenticarToken] Requisição recebida:");
  console.log("→ URL:", req.originalUrl);
  console.log("→ Método:", req.method);
  console.log("→ Authorization Header:", req.headers["authorization"]);

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Extrai só o token

  if (!token) {
    console.warn("[DEBUG autenticarToken] ❌ Nenhum token fornecido.");
    return res.status(401).json({ message: "Token não fornecido." });
  }

  // --------------------------------------------------------------------------
  // Verifica o token
  // --------------------------------------------------------------------------
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error("[DEBUG autenticarToken] ❌ Erro na verificação do token:", err.message);
      return res.status(403).json({ message: "Token inválido ou expirado." });
    }

    // ------------------------------------------------------------------------
    // Token válido — loga payload
    // ------------------------------------------------------------------------
    console.log("[DEBUG autenticarToken] ✅ Token válido. Payload decodificado:");
    console.log(user); // Mostra o conteúdo do JWT (id, escola_id, perfil, etc.)

    req.user = user; // Payload do JWT
    console.log("[DEBUG autenticarToken] ✅ Middleware concluído — chamando next().\n");
    next();
  });
}
