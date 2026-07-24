import jwt from "jsonwebtoken";
import { getPermissoesPorPerfil } from "../routes/rbacMatrix.js";

export function autenticarToken(req, res, next) {
  try {
    // ── CORS preflight: OPTIONS nunca carrega token por especificação HTTP ──
    if (req.method === "OPTIONS") return next();

    // ── API KEY do Agente IA (alternativa ao JWT para o sub-agente) ──────────
    // O agente usa o header: X-Agent-Key: <AGENT_API_KEY>
    // Configurado como variável de ambiente AGENT_API_KEY no DO App Platform
    const agentKey = req.headers["x-agent-key"];
    if (agentKey) {
      const validKey = process.env.AGENT_API_KEY;
      if (validKey && agentKey === validKey) {
        req.user = {
          id: 0,
          nome: "Agente IA — EDUCA.MELHOR",
          perfil: "SUPER_ADMIN",
          scope: "plataforma",
          permissoes: ["plataforma.visualizar", "master.escrever"],
          perfis: ["SUPER_ADMIN"],
          escola_id: null,
          is_agent: true,
        };
        return next();
      }
      // Chave informada mas inválida — rejeita imediatamente
      return res.status(401).json({ ok: false, message: "Chave de agente inválida." });
    }

    // ── Fluxo JWT normal (usuários humanos) ──────────────────────────────────
    const authHeader = req.headers?.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : (req.query?.token || null);

    if (!token) {
      return res.status(401).json({ ok: false, message: "Token não informado." });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("❌ JWT_SECRET não configurado no ambiente.");
      return res.status(500).json({ ok: false, message: "Configuração do servidor inválida." });
    }

    const payload = jwt.verify(token, secret);

    // ✅ Normaliza escopo:
    // - Tokens novos da plataforma vêm com scope="plataforma"
    // - Tokens antigos (escolares) ficam como scope="escola"
    req.user = {
      ...payload,
      scope: payload?.scope || "escola",
    };

    // ─────────────────────────────────────────────────────────────
    // RBAC: normalização para evitar undefined no restante do backend
    // ─────────────────────────────────────────────────────────────
    if (!Array.isArray(req.user.permissoes)) req.user.permissoes = [];
    if (!Array.isArray(req.user.perfis)) req.user.perfis = [];

    // ─────────────────────────────────────────────────────────────
    // RBAC (fallback): se token vier sem permissoes, deriva do perfil
    // ─────────────────────────────────────────────────────────────
    if (req.user.permissoes.length === 0 && req.user.perfil) {
      req.user.permissoes = getPermissoesPorPerfil(req.user.perfil);
    }

    return next();
  } catch (err) {
    const isProd = process.env.NODE_ENV === "production";
    if (!isProd) {
      console.error("❌ JWT inválido:", err?.message || err);
    }
    return res.status(401).json({ ok: false, message: "Token inválido ou expirado." });
  }
}
