// middleware/verificarRegional.js
// ============================================================================
// Isolamento Territorial Estrito — Coordenações Regionais de Ensino (CRE / SEEDF)
// Garante que apenas tokens autenticados com scope="cre" e regional_id válido
// acessem as rotas /api/cre/*, bloqueando tokens escolares ou de outras esferas.
// ============================================================================

export const CARGOS_CRE_LABELS = Object.freeze({
  coordenador_regional: "Coordenador(a) Geral da Regional",
  chefe_unieb: "Chefe de Educação Básica (UNIEB)",
  chefe_uniplat: "Chefe de Planejamento e Tecnologia (UNIPLAT)",
  chefe_unigep: "Chefe de Gestão de Pessoas (UNIGEP)",
  chefe_uniae: "Chefe de Infraestrutura e Apoio (UNIAE)",
  chefe_uniag: "Chefe de Administração Geral (UNIAG)",
});

export function resolveModulosCre(cargoRegional) {
  const cargo = String(cargoRegional || "coordenador_regional").toLowerCase().trim();
  // Passo 1 do Piloto CRE: escopo enxuto restrito a Gabinete + UNIAG
  if (cargo === "coordenador_regional" || cargo === "chefe_uniag") {
    return ["cre", "cre.gabinete", "cre.uniag"];
  }
  return ["cre", "cre.gabinete"];
}

export function verificarRegional(req, res, next) {
  try {
    if (req.method === "OPTIONS") return next();

    const scope = String(req.user?.scope || "").toLowerCase().trim();
    if (scope !== "cre") {
      return res.status(403).json({
        ok: false,
        message: "Acesso negado. Este ambiente é exclusivo de Coordenações Regionais de Ensino (CRE).",
      });
    }

    const regionalId = Number(req.user?.regional_id);
    if (!regionalId || Number.isNaN(regionalId) || regionalId <= 0) {
      return res.status(403).json({
        ok: false,
        message: "Regional não identificada no token de autenticação.",
      });
    }

    const cargoRegional = String(req.user?.cargo_regional || "coordenador_regional")
      .toLowerCase()
      .trim();

    req.regional_id = regionalId;
    req.cargo_regional = cargoRegional;
    req.cargo_label = CARGOS_CRE_LABELS[cargoRegional] || "Gestor(a) Regional";

    return next();
  } catch (err) {
    console.error("❌ Erro em verificarRegional:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Erro ao validar contexto regional." });
  }
}

export function exigirCargoRegional(...cargosPermitidos) {
  const permitidos = new Set(cargosPermitidos.map((c) => String(c).toLowerCase().trim()));
  // O Coordenador Geral da Regional (Gabinete) sempre possui supervisão hierárquica sobre as unidades da CRE
  permitidos.add("coordenador_regional");

  return (req, res, next) => {
    const cargoAtual = String(req.cargo_regional || req.user?.cargo_regional || "").toLowerCase().trim();
    if (!permitidos.has(cargoAtual)) {
      return res.status(403).json({
        ok: false,
        message: "Seu cargo regional não possui permissão para acessar esta unidade orgânica.",
      });
    }
    return next();
  };
}
