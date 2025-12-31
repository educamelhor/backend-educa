// apps/educa-backend/services/solverPayloadService.js
// =====================================================
// Consolida grade_base, turmas, demanda, modulação,
// disponibilidades e preferencias em 1 payload.
// =====================================================
//
// ✅ PASSO 3.1 — (Novo) Incluir Configurações Pedagógicas no payload do solver
// - Busca em grade_config_pedagogica (regras_json)
// - Injeta em payload.config_pedagogica
// - Mantém compatibilidade: se ano_ref não vier, usa defaults
// =====================================================

import pool from "../db.js";

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function normTurno(t) {
  return String(t || "").trim().toLowerCase();
}
function normAnoRef(v) {
  // Ano ref pode vir como number/string; mantemos string para query e payload
  const s = String(v ?? "").trim();
  return s;
}

// ---------------------- grade_base -------------------
async function fetchGradeBase(escolaId, turno) {
  const [rows] = await pool.query(
    `SELECT dia_semana, periodo_ordem,
            TIME_FORMAT(hora_inicio,'%H:%i') AS hora_inicio,
            TIME_FORMAT(hora_fim,'%H:%i')   AS hora_fim
       FROM grade_base
      WHERE escola_id=? AND turno=?
      ORDER BY dia_semana, periodo_ordem`,
    [escolaId, turno]
  );

  const base = {};
  for (const r of rows) {
    const d = toInt(r.dia_semana);
    if (!base[d]) base[d] = [];
    base[d].push({
      ordem: toInt(r.periodo_ordem),
      inicio: r.hora_inicio,
      fim: r.hora_fim,
    });
  }
  return base; // {1:[{ordem,inicio,fim},...], ...}
}

// ---------------------- turmas -----------------------
async function fetchTurmas(escolaId, turno, turmaIds) {
  const ids = (turmaIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT id, nome, etapa, serie, turno
       FROM turmas
      WHERE escola_id=? AND turno=? AND id IN (${placeholders})
      ORDER BY serie, nome`,
    [escolaId, turno, ...ids]
  );

  return rows.map((r) => ({
    id: toInt(r.id),
    nome: r.nome,
    etapa: r.etapa,
    serie: r.serie,
    turno: r.turno,
  }));
}

// ---------------------- demanda (turma_cargas) -------
async function fetchDemanda(escolaId, turno, turmaIds) {
  const ids = (turmaIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT tc.turma_id, tc.disciplina_id, d.nome AS disciplina_nome, (tc.carga+0) AS carga
       FROM turma_cargas tc
       JOIN turmas t ON t.id = tc.turma_id
       JOIN disciplinas d ON d.id = tc.disciplina_id
      WHERE tc.escola_id=? AND t.turno=? AND tc.turma_id IN (${placeholders})
      ORDER BY t.nome, d.nome`,
    [escolaId, turno, ...ids]
  );

  return rows.map((r) => ({
    turma_id: toInt(r.turma_id),
    disciplina_id: toInt(r.disciplina_id),
    disciplina_nome: r.disciplina_nome,
    carga: toInt(r.carga),
  }));
}

// ---------------------- modulação --------------------
async function fetchModulacao(escolaId, turmaIds) {
  const ids = (turmaIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT m.professor_id, m.turma_id, m.disciplina_id, p.nome AS professor_nome
       FROM modulacao m
       JOIN professores p ON p.id = m.professor_id
      WHERE m.escola_id=? AND m.turma_id IN (${placeholders})`,
    [escolaId, ...ids]
  );

  return rows.map((r) => ({
    professor_id: toInt(r.professor_id),
    turma_id: toInt(r.turma_id),
    disciplina_id: toInt(r.disciplina_id),
    professor_nome: r.professor_nome,
  }));
}

// ---------------------- disponibilidades -------------
async function fetchDisponibilidades(escolaId, turno, profIdsOpt = []) {
  let sql = `
    SELECT professor_id,
           dia_semana AS dia,
           COALESCE(status,'livre') AS status_padrao,
           periodos AS periodos_json
      FROM grade_disponibilidades
     WHERE escola_id=? AND turno=?`;
  const params = [escolaId, turno];

  if (Array.isArray(profIdsOpt) && profIdsOpt.length) {
    const placeholders = profIdsOpt.map(() => "?").join(",");
    sql += ` AND professor_id IN (${placeholders})`;
    params.push(...profIdsOpt);
  }

  const [rows] = await pool.query(sql, params);

  const out = [];
  for (const r of rows) {
    let arr = [];
    try {
      if (typeof r.periodos_json === "string") {
        arr = JSON.parse(r.periodos_json || "[]");
      } else if (r.periodos_json && Buffer.isBuffer(r.periodos_json)) {
        arr = JSON.parse(r.periodos_json.toString("utf8") || "[]");
      } else if (Array.isArray(r.periodos_json)) {
        arr = r.periodos_json;
      } else if (r.periodos_json && typeof r.periodos_json === "object") {
        arr = r.periodos_json;
      }
    } catch {
      arr = [];
    }

    for (const it of arr) {
      const ordemNum = toInt(it?.ordem, NaN);
      if (!Number.isFinite(ordemNum)) continue;
      out.push({
        professor_id: toInt(r.professor_id),
        dia: toInt(r.dia),
        ordem: ordemNum,
        status: String(it?.status || r.status_padrao || "livre"),
      });
    }
  }
  return out; // [{professor_id,dia,ordem,status}]
}

// ---------------------- preferencias -----------------
async function fetchPreferencias(escolaId, turno, profIdsOpt = []) {
  let sql = `
    SELECT professor_id,
           COALESCE(JSON_EXTRACT(regras_json,'$'), JSON_OBJECT()) AS regras_json
      FROM grade_preferencias_professor
     WHERE turno=?`;
  const params = [turno];

  if (Array.isArray(profIdsOpt) && profIdsOpt.length) {
    const placeholders = profIdsOpt.map(() => "?").join(",");
    sql += ` AND professor_id IN (${placeholders})`;
    params.push(...profIdsOpt);
  }

  sql += ` AND professor_id IN (SELECT id FROM professores WHERE escola_id=?)`;
  params.push(escolaId);

  const [rows] = await pool.query(sql, params);

  const map = new Map();
  for (const r of rows) {
    let obj = {};
    try {
      obj =
        typeof r.regras_json === "string"
          ? JSON.parse(r.regras_json || "{}")
          : r.regras_json || {};
    } catch {
      obj = {};
    }
    map.set(toInt(r.professor_id), obj);
  }
  return map; // Map<prof_id, regras_json>
}

// ---------------------- config pedagógica (novo) -----
function defaultConfigPedagogica() {
  return {
    nivel: "fundamental_II",
    regras: {
      // RC-01 (já existente no front)
      rc01_distribuicao_disciplina: {
        modo: "soft", // soft | hard
        max_consecutivas: 2,
      },

      // RC-02 (novo)
      rc02_max_aulas_por_dia_disciplina: {
        modo: "soft", // soft | hard
        max_por_dia_padrao: 3,
        por_disciplina: {},
      },
    },
  };
}

async function fetchConfigPedagogica(escolaId, turnoNorm, anoRefNorm, nivel = "fundamental_II") {
  // Se ano não foi informado no fluxo, retornamos defaults para manter compatibilidade.
  if (!anoRefNorm) return defaultConfigPedagogica();

  const [rows] = await pool.query(
    `SELECT nivel, regras_json
       FROM grade_config_pedagogica
      WHERE escola_id=? AND turno=? AND ano_ref=? AND nivel=?
      LIMIT 1`,
    [escolaId, turnoNorm, anoRefNorm, nivel]
  );

  if (!rows?.length) return defaultConfigPedagogica();

  const row = rows[0] || {};
  let regras = {};
  try {
    regras =
      typeof row.regras_json === "string"
        ? JSON.parse(row.regras_json || "{}")
        : row.regras_json || {};
  } catch {
    regras = {};
  }

  // Mescla com defaults para compatibilidade (caso falte RC-01 ou RC-02 no BD)
  const def = defaultConfigPedagogica();
  return {
    nivel: row.nivel || def.nivel,
    regras: {
      ...(def.regras || {}),
      ...(regras || {}),
    },
  };
}

// ---------------------- builder público --------------
export async function buildSolverPayload({ escolaId, turno, turmaIds, anoRef, ano_ref }) {
  const turnoNorm = normTurno(turno);

  // aceitamos anoRef (camel) e ano_ref (snake) para robustez
  const anoRefNorm = normAnoRef(anoRef ?? ano_ref);

  const grade_base = await fetchGradeBase(escolaId, turnoNorm);
  const turmas = await fetchTurmas(escolaId, turnoNorm, turmaIds);
  const demanda = await fetchDemanda(escolaId, turnoNorm, turmaIds);
  const modulacao = await fetchModulacao(escolaId, turmaIds);

  const profIds = Array.from(new Set(modulacao.map((m) => m.professor_id)));
  const disponibilidades = await fetchDisponibilidades(escolaId, turnoNorm, profIds);
  const preferenciasMap = await fetchPreferencias(escolaId, turnoNorm, profIds);

  // ✅ novo: contrato/config pedagógica (regras RC-01/RC-02 etc.)
  const config_pedagogica = await fetchConfigPedagogica(
    escolaId,
    turnoNorm,
    anoRefNorm,
    "fundamental_II"
  );

  return {
    escola_id: escolaId,
    turno: turnoNorm,
    ano_ref: anoRefNorm || null,

    // ✅ regras pedagógicas consolidadas para o solver
    config_pedagogica, // { nivel, regras }

    grade_base, // { dia: [{ordem,inicio,fim}, ...], ... }
    turmas, // [{ id,nome,etapa,serie,turno }]
    demanda, // [{ turma_id,disciplina_id,disciplina_nome,carga }]
    modulacao, // [{ professor_id,turma_id,disciplina_id,professor_nome }]
    disponibilidades, // [{ professor_id,dia,ordem,status }]
    preferencias: Object.fromEntries(preferenciasMap), // { [profId]: regras_json }
  };
}

export default { buildSolverPayload };
