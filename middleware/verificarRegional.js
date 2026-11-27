// middleware/verificarRegional.js
// ============================================================================
// Isolamento Territorial Estrito — Coordenações Regionais de Ensino (CRE / SEEDF)
// Garante que apenas tokens autenticados com scope="cre" e regional_id válido
// acessem as rotas /api/cre/*, bloqueando tokens escolares ou de outras esferas.
// ============================================================================

import pool from "../db.js";

export const CARGOS_CRE_LABELS = Object.freeze({
  coordenador_regional: "Coordenador(a) Geral da Regional",
  chefe_unieb: "Chefe de Educação Básica (UNIEB)",
  chefe_uniplat: "Chefe de Planejamento e Tecnologia (UNIPLAT)",
  chefe_unigep: "Chefe de Gestão de Pessoas (UNIGEP)",
  chefe_uniae: "Chefe de Infraestrutura e Apoio (UNIAE)",
  chefe_uniag: "Chefe de Administração Geral (UNIAG)",
});

export const MODULOS_CRE_VALIDOS = new Set([
  "cre",
  "cre.gabinete",
  "cre.uniag",
]);

let _regionalModulosTableEnsured = false;

export async function ensureRegionalModulosTable(dbConn = pool) {
  if (_regionalModulosTableEnsured) return;
  try {
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS regional_cargo_modulos (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        regional_id    INT NOT NULL,
        cargo_regional VARCHAR(60) NOT NULL,
        modulo         VARCHAR(100) NOT NULL,
        ativo          TINYINT(1) NOT NULL DEFAULT 0,
        updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_rcm (regional_id, cargo_regional, modulo),
        INDEX idx_rcm_reg_cargo (regional_id, cargo_regional)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    _regionalModulosTableEnsured = true;
  } catch (err) {
    _regionalModulosTableEnsured = true;
    if (!String(err?.message || "").includes("already exists")) {
      console.warn("[verificarRegional] Aviso auto-migrate regional_cargo_modulos:", err?.message);
    }
  }
}

export function resolveModulosCre(cargoRegional) {
  const cargo = String(cargoRegional || "coordenador_regional").toLowerCase().trim();
  // Padrão seguro quando o CEO ainda não customizou aquela CRE/cargo no banco
  if (cargo === "coordenador_regional" || cargo === "chefe_uniag") {
    return ["cre", "cre.gabinete", "cre.uniag"];
  }
  return ["cre", "cre.gabinete"];
}

export async function resolveModulosCreDinamico(dbConn, regionalId, cargoRegional) {
  const cargo = String(cargoRegional || "coordenador_regional").toLowerCase().trim();
  const regIdNum = Number(regionalId);
  if (!regIdNum || Number.isNaN(regIdNum) || regIdNum <= 0) {
    return resolveModulosCre(cargo);
  }
  try {
    const conn = dbConn || pool;
    await ensureRegionalModulosTable(conn);
    const [rows] = await conn.query(
      "SELECT modulo, ativo FROM regional_cargo_modulos WHERE regional_id = ? AND cargo_regional = ?",
      [regIdNum, cargo]
    );
    if (!rows || rows.length === 0) {
      return resolveModulosCre(cargo);
    }
    const ativos = rows
      .filter((r) => Number(r.ativo) === 1 && MODULOS_CRE_VALIDOS.has(r.modulo))
      .map((r) => r.modulo);
    const temFilho = ativos.some((m) => m.startsWith("cre."));
    if (temFilho && !ativos.includes("cre")) {
      ativos.unshift("cre");
    }
    if (!temFilho) {
      return [];
    }
    return [...new Set(ativos)];
  } catch (err) {
    console.warn("[verificarRegional] Fallback padrão em resolveModulosCreDinamico:", err?.message);
    return resolveModulosCre(cargo);
  }
}

export async function verificarRegional(req, res, next) {
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
    req.modulos_cre = await resolveModulosCreDinamico(req.db || pool, regionalId, cargoRegional);

    return next();
  } catch (err) {
    console.error("❌ Erro em verificarRegional:", err?.message || err);
    return res.status(500).json({ ok: false, message: "Erro ao validar contexto regional." });
  }
}

export function exigirCargoRegional(...cargosPermitidos) {
  const permitidos = new Set(cargosPermitidos.map((c) => String(c).toLowerCase().trim()));
  permitidos.add("coordenador_regional");

  return (req, res, next) => {
    const cargoAtual = String(req.cargo_regional || req.user?.cargo_regional || "").toLowerCase().trim();
    const modulosCre = Array.isArray(req.modulos_cre) ? req.modulos_cre : null;

    // Se o CEO modulou explicitamente no banco, respeita o módulo 'cre.uniag' para rotas UNIAG
    if (permitidos.has("chefe_uniag") && modulosCre) {
      if (modulosCre.includes("cre.uniag")) return next();
      return res.status(403).json({
        ok: false,
        message: "Módulo UNIAG não habilitado para o seu cargo nesta Regional.",
      });
    }

    if (!permitidos.has(cargoAtual)) {
      return res.status(403).json({
        ok: false,
        message: "Seu cargo regional não possui permissão para acessar esta unidade orgânica.",
      });
    }
    return next();
  };
}
