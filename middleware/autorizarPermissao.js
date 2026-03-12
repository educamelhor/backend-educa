import pool from "../db.js";

export function autorizarPermissao(permOuLista) {
  return async (req, res, next) => {
let perms = req?.user?.permissoes || [];

if (req?.user?.usuarioId || req?.user?.id || req?.user?.usuario_id) {
  try {
    const [rows] = await pool.query(
      `
      SELECT rp.chave
      FROM rbac_usuario_permissoes up
      JOIN rbac_permissoes rp ON rp.id = up.permissao_id
      WHERE up.usuario_id = ?
      `,
      [req.user.usuarioId ?? req.user.id ?? req.user.usuario_id]
    );

    const permsDb = rows.map((r) => r.chave);

    // ✅ merge token perms + db perms (sem duplicar)
    perms = Array.from(new Set([...(Array.isArray(perms) ? perms : []), ...permsDb]));

    // cache no request
    req.user.permissoes = perms;
  } catch (err) {
    console.error("[RBAC] falha ao carregar permissões do usuário:", err.message);
  }
}
    const requiredRaw = Array.isArray(permOuLista) ? permOuLista : [permOuLista];

    // Aceita compatibilidade: "modulo.acao" e "modulo:acao"
    const required = requiredRaw.flatMap((p) => {
      const s = String(p || "");
      if (s.includes(".")) return [s, s.replace(/\./g, ":")];
      if (s.includes(":")) return [s, s.replace(/:/g, ".")];
      return [s];
    });

    // ✅ DEBUG RBAC (DEV) — remover após validar
    if (process.env.NODE_ENV !== "production") {
      console.log("[RBAC DEBUG] userId:", req?.user?.usuarioId ?? req?.user?.id ?? req?.user?.usuario_id);
      console.log("[RBAC DEBUG] perfil:", req?.user?.perfil, "escola_id:", req?.user?.escola_id);
      console.log("[RBAC DEBUG] perms carregadas:", Array.isArray(perms) ? perms : "(não array)");
      console.log("[RBAC DEBUG] required:", required);
    }

    const ok =
      Array.isArray(perms) &&
      required.some((p) => perms.includes(p));

    // ─────────────────────────────────────────────────────────────
    // Auditoria RBAC (fail-safe)
    // ─────────────────────────────────────────────────────────────
    try {
      await pool.query(
        `
        INSERT INTO rbac_auditoria
          (usuario_id, escola_id, perfil, metodo, rota,
           permissao_requerida, decisao, ip, user_agent, detalhe)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          req?.user?.usuarioId ?? req?.user?.id ?? null,
          req?.user?.escola_id || null,
          req?.user?.perfil || null,
          req.method,
          ((req.baseUrl || "") + (req.path || (String(req.originalUrl || "").split("?")[0]))).slice(0, 255),
          required.join(","),
          ok ? "ALLOW" : "DENY",
          req.ip || null,
          req.headers?.["user-agent"] || null,
          ok ? null : "Permissão ausente no contexto",
        ]
      );
    } catch (err) {
      // ❗ Nunca bloquear o fluxo por falha de auditoria
      console.error("[RBAC_AUDITORIA] falha ao registrar:", err.message);
    }

    // ─────────────────────────────────────────────────────────────
    // Decisão final
    // ─────────────────────────────────────────────────────────────
    if (ok) return next();

    return res.status(403).json({
      erro: "Acesso negado",
      required,
      perfil: req?.user?.perfil || null,
    });
  };
}


