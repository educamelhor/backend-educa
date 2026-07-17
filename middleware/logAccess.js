/**
 * middleware/logAccess.js
 * Registra cada requisição autenticada na tabela access_log.
 * Usado de forma seletiva (não em TODA rota) — apenas nos endpoints de login/confirmação.
 */

/**
 * Registra um acesso na tabela access_log.
 * Pode ser chamado diretamente em endpoints de login (não é middleware de rota).
 *
 * @param {import("mysql2/promise").Pool} db - pool de conexão
 * @param {object} params
 * @param {number} params.usuario_id
 * @param {number} params.escola_id
 * @param {string} [params.perfil]
 * @param {string} [params.ip]
 * @param {string} [params.user_agent]
 * @param {string} [params.action] - "login" | "token_refresh" | "api_call"
 */
export async function registrarAcesso(db, { usuario_id, escola_id, perfil, ip, user_agent, action = "login" }) {
  if (!usuario_id || !escola_id) return;

  try {
    await db.query(
      `INSERT INTO access_log (usuario_id, escola_id, perfil, ip, user_agent, action)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        usuario_id,
        escola_id,
        perfil || null,
        ip ? String(ip).slice(0, 45) : null,
        user_agent ? String(user_agent).slice(0, 512) : null,
        action || "login",
      ]
    );
  } catch (err) {
    // Nunca deve quebrar o fluxo principal — log e segue
    console.error("[ACCESS_LOG] Erro ao registrar acesso:", err?.message);
  }
}
