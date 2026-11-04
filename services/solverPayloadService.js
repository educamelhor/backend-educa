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
    `SELECT id, nome, etapa, serie, turno, regime
       FROM turmas
      WHERE escola_id=? AND LOWER(turno)=LOWER(?) AND id IN (${placeholders})
      ORDER BY serie, nome`,
    [escolaId, turno, ...ids]
  );

  return rows.map((r) => ({
    id: toInt(r.id),
    nome: r.nome,
    etapa: r.etapa,
    serie: r.serie,
    turno: r.turno,
    regime: r.regime || "anual",
  }));
}

// ---------------------- demanda (turma_cargas) -------
async function fetchDemanda(escolaId, turno, turmaIds, semestre = 1) {
  const ids = (turmaIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];

  const semNum = toInt(semestre, 1) || 1;
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT tc.turma_id, tc.disciplina_id, d.nome AS disciplina_nome, SUM(tc.carga+0) AS carga
       FROM turma_cargas tc
       JOIN turmas t ON t.id = tc.turma_id
       JOIN disciplinas d ON d.id = tc.disciplina_id
      WHERE tc.escola_id=?
        AND LOWER(t.turno)=LOWER(?)
        AND tc.turma_id IN (${placeholders})
        AND (LOWER(COALESCE(t.regime, 'anual')) <> 'semestral' OR tc.semestre IS NULL OR tc.semestre = 0 OR tc.semestre = ?)
      GROUP BY tc.turma_id, tc.disciplina_id, d.nome
      ORDER BY t.nome, d.nome`,
    [escolaId, turno, ...ids, semNum]
  );

  return rows.map((r) => ({
    turma_id: toInt(r.turma_id),
    disciplina_id: toInt(r.disciplina_id),
    disciplina_nome: r.disciplina_nome,
    carga: toInt(r.carga),
  }));
}

// ---------------------- modulação --------------------
async function fetchModulacao(escolaId, turmaIds, semestre = 1) {
  const ids = (turmaIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];

  const semNum = toInt(semestre, 1) || 1;
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT m.professor_id, m.turma_id, m.disciplina_id, m.aulas, m.semestre, p.nome AS professor_nome
       FROM modulacao m
       JOIN professores p ON p.id = m.professor_id
       LEFT JOIN turmas t ON t.id = m.turma_id
      WHERE m.escola_id=?
        AND m.turma_id IN (${placeholders})
        AND (LOWER(COALESCE(t.regime, 'anual')) <> 'semestral' OR m.semestre IS NULL OR m.semestre = 0 OR m.semestre = ?)`,
    [escolaId, ...ids, semNum]
  );

  return rows.map((r) => ({
    professor_id: toInt(r.professor_id),
    turma_id: toInt(r.turma_id),
    disciplina_id: toInt(r.disciplina_id),
    aulas: toInt(r.aulas, 0),
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
     WHERE escola_id=? AND LOWER(turno)=LOWER(?)`;
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
        periodo: ordemNum,
        status: String(it?.status || r.status_padrao || "livre").toLowerCase(),
      });
    }
  }
  return out; // [{professor_id,dia,ordem,periodo,status}]
}

// ---------------------- preferencias -----------------
async function fetchPreferencias(escolaId, turno, profIdsOpt = []) {
  let sql = `
    SELECT professor_id,
           prefere_aula_unica,
           evitar_janela_interna,
           COALESCE(JSON_EXTRACT(regras_json,'$'), JSON_OBJECT()) AS regras_json
      FROM grade_preferencias_professor
     WHERE LOWER(turno)=LOWER(?)`;
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
    // Mixin the top-level flags so the solver can read them easily
    obj.prefere_aula_unica = !!r.prefere_aula_unica;
    obj.evitar_janela_interna = !!r.evitar_janela_interna;
    map.set(toInt(r.professor_id), obj);
  }
  return map; // Map<prof_id, regras_json>
}

// ---------------------- config da escola (turnos, dias, periodos, regras_gerais) -----
async function fetchEscolaConfigGrade(escolaId, turnoNorm) {
  try {
    const [[row]] = await pool.query(
      `SELECT turnos, dias_semana, periodos
         FROM escola_configuracao_grade
        WHERE escola_id = ?
        LIMIT 1`,
      [escolaId]
    );
    if (!row) {
      return {
        dias_semana: [1, 2, 3, 4, 5],
        periodos_por_dia: 6,
        regras_gerais: null,
      };
    }

    const parseSafe = (raw, fb) => {
      try {
        if (typeof raw === "string") return JSON.parse(raw);
        if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
        if (raw && typeof raw === "object") return raw;
      } catch {}
      return fb;
    };

    const diasSemana = parseSafe(row.dias_semana, [1, 2, 3, 4, 5]);
    const periodosObj = parseSafe(row.periodos, {});
    const regrasGerais = periodosObj?._regras_gerais || null;
    const periodosPorDia = toInt(periodosObj?.[turnoNorm], 0) || 6;

    return {
      dias_semana: Array.isArray(diasSemana) && diasSemana.length ? diasSemana.map(Number) : [1, 2, 3, 4, 5],
      periodos_por_dia: periodosPorDia,
      regras_gerais: regrasGerais,
    };
  } catch {
    return {
      dias_semana: [1, 2, 3, 4, 5],
      periodos_por_dia: 6,
      regras_gerais: null,
    };
  }
}

// ---------------------- slots fixos (Horário Manual / locked=1) -------------
async function fetchSlotsFixos(escolaId, turnoNorm, turmaIds) {
  try {
    const [resultados] = await pool.query(
      `SELECT id, status
         FROM grade_resultado
        WHERE escola_id = ? AND turno = ? AND status IN ('rascunho', 'publicado')
        ORDER BY FIELD(status, 'rascunho', 'publicado')`,
      [escolaId, turnoNorm]
    );
    if (!resultados || resultados.length === 0) return [];

    const idsSet = new Set((turmaIds || []).map(Number).filter(n => Number.isFinite(n) && n > 0));

    for (const res of resultados) {
      const [slots] = await pool.query(
        `SELECT
           gs.turma_id,
           gs.dia_semana AS dia,
           gs.periodo_ordem AS ordem,
           gs.disciplina_id,
           gs.professor_id,
           gs.origem,
           gs.locked
         FROM grade_slot gs
        WHERE gs.resultado_id = ?
          AND (gs.locked = 1 OR gs.origem = 'manual')`,
        [res.id]
      );
      if (slots && slots.length > 0) {
        return slots.map(s => {
          const tid = toInt(s.turma_id);
          return {
            turma_id: tid,
            dia: toInt(s.dia),
            ordem: toInt(s.ordem),
            disciplina_id: toInt(s.disciplina_id),
            professor_id: toInt(s.professor_id),
            origem: s.origem || "manual",
            locked: true,
            in_scope: idsSet.size === 0 || idsSet.has(tid),
          };
        });
      }
    }
    return [];
  } catch {
    return [];
  }
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
export async function buildSolverPayload({
  escolaId,
  turno,
  turmaIds,
  anoRef,
  ano_ref,
  semestre = 1,
  respeitarHorarioManual = true,
}) {
  const turnoNorm = normTurno(turno);

  // aceitamos anoRef (camel) e ano_ref (snake) para robustez
  const anoRefNorm = normAnoRef(anoRef ?? ano_ref);

  const [
    grade_base,
    turmas,
    demanda,
    modulacao,
    escolaCfg,
    config_pedagogica,
    slots_fixos,
  ] = await Promise.all([
    fetchGradeBase(escolaId, turnoNorm),
    fetchTurmas(escolaId, turnoNorm, turmaIds),
    fetchDemanda(escolaId, turnoNorm, turmaIds, semestre),
    fetchModulacao(escolaId, turmaIds, semestre),
    fetchEscolaConfigGrade(escolaId, turnoNorm),
    fetchConfigPedagogica(escolaId, turnoNorm, anoRefNorm, "fundamental_II"),
    respeitarHorarioManual ? fetchSlotsFixos(escolaId, turnoNorm, turmaIds) : Promise.resolve([]),
  ]);

  const profIds = Array.from(new Set(modulacao.map((m) => m.professor_id)));
  const [disponibilidades, preferenciasMap] = await Promise.all([
    fetchDisponibilidades(escolaId, turnoNorm, profIds),
    fetchPreferencias(escolaId, turnoNorm, profIds),
  ]);

  // Se escola_configuracao_grade possui regras_gerais, aplica sobre config_pedagogica
  if (escolaCfg.regras_gerais) {
    config_pedagogica.regras_gerais = escolaCfg.regras_gerais;
    if (!config_pedagogica.regras) config_pedagogica.regras = {};
    if (escolaCfg.regras_gerais.preferencia_aulas_duplas) {
      config_pedagogica.regras.rc01_distribuicao_disciplina = {
        modo: "hard",
        max_consecutivas: 2,
      };
    }
    if (escolaCfg.regras_gerais.max_aulas_mesmo_dia) {
      config_pedagogica.regras.rc02_max_por_dia_disciplina = {
        modo: "hard",
        max_por_dia_padrao: escolaCfg.regras_gerais.max_aulas_mesmo_dia,
        bloqueio_hard: true,
      };
    }
  }

  return {
    escola_id: escolaId,
    turno: turnoNorm,
    ano_ref: anoRefNorm || null,
    semestre: toInt(semestre, 1) || 1,
    dias_semana: escolaCfg.dias_semana,
    periodos_por_dia: escolaCfg.periodos_por_dia,

    // ✅ regras pedagógicas consolidadas para o solver
    config_pedagogica, // { nivel, regras, regras_gerais }

    grade_base, // { dia: [{ordem,inicio,fim}, ...], ... }
    turmas, // [{ id,nome,etapa,serie,turno,regime }]
    demanda, // [{ turma_id,disciplina_id,disciplina_nome,carga }]
    modulacao, // [{ professor_id,turma_id,disciplina_id,aulas,professor_nome }]
    disponibilidades, // [{ professor_id,dia,ordem,periodo,status }]
    preferencias: Object.fromEntries(preferenciasMap), // { [profId]: regras_json }
    slots_fixos, // [{ turma_id,dia,ordem,disciplina_id,professor_id,origem,locked }]
  };
}

export default { buildSolverPayload };
