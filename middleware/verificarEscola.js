// api/middleware/verificarEscola.js

/**
 * Middleware para garantir que o usuário logado está vinculado a uma escola
 */
export function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}
