export function exigirEscopo(escopoEsperado) {
  return (req, res, next) => {
    const scope = req.user?.scope;

    if (!scope) {
      return res.status(403).json({ message: "Token sem escopo definido." });
    }

    if (scope !== escopoEsperado) {
      return res.status(403).json({
        message: `Acesso negado. Escopo necessário: ${escopoEsperado}`,
      });
    }

    next();
  };
}
