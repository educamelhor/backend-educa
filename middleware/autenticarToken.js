import jwt from "jsonwebtoken";

export function autenticarToken(req, res, next) {
  try {
    const authHeader = req.headers?.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;

    if (!token) {
      return res.status(401).json({ ok: false, message: "Token não informado." });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("❌ JWT_SECRET não configurado no ambiente.");
      return res.status(500).json({ ok: false, message: "Configuração do servidor inválida." });
    }

    const payload = jwt.verify(token, secret);
    req.user = payload;

    return next();
  } catch (err) {
    const isProd = process.env.NODE_ENV === "production";
    if (!isProd) {
      console.error("❌ JWT inválido:", err?.message || err);
    }
    return res.status(401).json({ ok: false, message: "Token inválido ou expirado." });
  }
}
