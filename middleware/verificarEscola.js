export function verificarEscola(req, res, next) {
  try {
    const fromHeader = req.headers?.["x-escola-id"];
    const fromQuery = req.query?.escola_id;
    const fromBody = req.body?.escola_id;

    const fromToken =
      req.user?.escola_id ??
      req.user?.escolaId ??
      req.user?.school_id ??
      req.user?.schoolId;

    const escolaIdRaw = fromHeader ?? fromQuery ?? fromBody ?? fromToken;
    const escola_id = Number(escolaIdRaw);

    if (!escolaIdRaw || Number.isNaN(escola_id) || escola_id <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Escola não informada. Envie x-escola-id, escola_id (query/body) ou inclua no token.",
      });
    }

    req.escola_id = escola_id;

    // ✅ compatibilidade: partes do sistema (multer/uploads) esperam escola_id em req.user
    if (req.user && (req.user.escola_id == null)) {
      req.user.escola_id = escola_id;
    }

    return next();

  } catch (err) {
    console.error("❌ Erro ao verificar escola:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Erro ao verificar escola." });
  }
}
