// ==================================================================================
// backend/routes/gradeRunMock.js
// Rota para rodar o mock solver usando o payload real do solverPayloadService.
// ==================================================================================

import express from "express";
import pool from "../db.js";
import { buildSolverPayload } from "../services/solverPayloadService.js";
import { runGreedySolver } from "../services/mockGreedySolver.js";
import {
  buildBlocosSimultaneosConsolidados,
  calcularDescontoAulasUnidasPorProfessor,
  fetchRestricoesInterTurnosPorCpf,
  normalizarRecursosFisicos,
} from "../services/solverEtapa3Helper.js";

const router = express.Router();

/**
 * Middleware defensivo para garantir escola_id no request.
 * - Prioriza req.user.escola_id (quando autenticado)
 * - Fallback: header x-escola-id (útil em ambiente de teste)
 */
function requireEscola(req, res, next) {
  const escolaId = req.user?.escola_id || Number(req.headers["x-escola-id"]);
  if (!escolaId || Number.isNaN(Number(escolaId))) {
    return res.status(400).json({ error: "escola_id ausente. (req.user.escola_id ou header x-escola-id)" });
  }
  req.escolaId = Number(escolaId);
  return next();
}

/**
 * Normaliza entrada de turno (mantendo compatibilidade com UI).
 * O backend deve trabalhar com valores consistentes: "matutino" | "vespertino" | "noturno" (exemplo).
 */
function normalizeTurno(turno) {
  if (!turno) return null;
  if (typeof turno !== "string") return null;
  const t = turno.trim();
  if (!t) return null;
  return t.toLowerCase();
}

/**
 * Normaliza IDs de turmas (aceita array [1,2] ou string "1,2").
 */
function parseTurmaIds(turma_ids) {
  if (Array.isArray(turma_ids)) {
    return turma_ids
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  if (typeof turma_ids === "string") {
    return turma_ids
      .split(",")
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  return [];
}

/**
 * Helpers de diagnóstico (somente DEV)
 * - Não alteram a lógica do solver; apenas ajudam a localizar a exceção que gera 500.
 */
function isProd() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function safePreview(obj, maxLen = 1200) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + "…(trunc)";
  } catch {
    return "[unserializable]";
  }
}

function pickPayloadStats(payload) {
  const turmas = Array.isArray(payload?.turmas) ? payload.turmas.length : 0;
  const demanda = Array.isArray(payload?.demanda) ? payload.demanda.length : 0;
  const modulacao = Array.isArray(payload?.modulacao) ? payload.modulacao.length : 0;
  const disponibilidades = Array.isArray(payload?.disponibilidades) ? payload.disponibilidades.length : 0;
  const professoresUnique = Array.isArray(payload?.modulacao)
    ? new Set(payload.modulacao.map((m) => m?.professor_id).filter(Boolean)).size
    : 0;

  return { turmas, demanda, modulacao, disponibilidades, professoresUnique };
}

/**
 * Cache (por boot) para detectar se a tabela existe.
 * Evita dependermos de exception (ER_NO_SUCH_TABLE) para controlar fluxo.
 */
let __cfgPedagogicaTableExistsPromise = null;

async function configPedagogicaTableExists() {
  if (__cfgPedagogicaTableExistsPromise) return __cfgPedagogicaTableExistsPromise;

  __cfgPedagogicaTableExistsPromise = (async () => {
    try {
      // SHOW TABLES é simples e confiável (independente de schema/driver).
      const [rows] = await pool.query("SHOW TABLES LIKE 'configuracoes_pedagogicas'");
      const exists = Array.isArray(rows) && rows.length > 0;

      if (!isProd()) {
        console.log("[grade/run-mock] configPedagogicaTableExists:", exists ? "SIM" : "NÃO");
      }

      return exists;
    } catch (e) {
      // Se até isso falhar, não vamos travar o mock; apenas assumimos inexistente.
      if (!isProd()) {
        console.warn("[grade/run-mock] Falha ao verificar existência da tabela configuracoes_pedagogicas:", e?.message || e);
      }
      return false;
    }
  })();

  return __cfgPedagogicaTableExistsPromise;
}

/**
 * Carrega a configuração pedagógica persistida (se existir) para (escola_id, turno, ano_ref, nivel).
 * - Usa comparação NULL-safe do MySQL (<=>) para suportar ano_ref nulo.
 * - Retorna null caso não exista registro.
 * - IMPORTANTE: se a tabela ainda não existir, NÃO deve falhar o mock.
 */
async function loadConfigPedagogica({ escolaId, turno, anoRef, nivel }) {
  // 0) Se a tabela não existe, retorna null sem consultar.
  const exists = await configPedagogicaTableExists();
  if (!exists) return null;

  // Observação: manter compatível com o schema atual:
  // tabela: configuracoes_pedagogicas
  // colunas esperadas: escola_id, turno, ano_ref, nivel, config_json, id (ou atualizado_em)
  const sql = `
    SELECT config_json
      FROM configuracoes_pedagogicas
     WHERE escola_id = ?
       AND turno = ?
       AND nivel = ?
       AND ano_ref <=> ?
     ORDER BY id DESC
     LIMIT 1
  `;

  const params = [escolaId, turno, nivel, anoRef ?? null];

  let rows;
  try {
    const [r] = await pool.query(sql, params);
    rows = r;
  } catch (e) {
    // ✅ Segunda camada defensiva: se a tabela sumiu/renomeou, não quebra o mock.
    const noTable =
      e?.code === "ER_NO_SUCH_TABLE" ||
      e?.errno === 1146 ||
      e?.sqlState === "42S02" ||
      String(e?.message || "").toLowerCase().includes("doesn't exist");

    if (noTable) {
      if (!isProd()) {
        console.warn("[grade/run-mock] Tabela configuracoes_pedagogicas não existe (capturado). Seguindo sem config.");
      }
      return null;
    }

    // Outros erros devem subir, pois indicam problema real (conexão, permissão, SQL, etc.)
    throw e;
  }

  if (!rows || rows.length === 0) return null;

  const raw = rows[0].config_json;
  if (!raw) return null;

  // config_json pode vir como string JSON
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ou já pode vir como objeto (dependendo do driver/config)
  if (typeof raw === "object") return raw;

  return null;
}

/**
 * Monta e enriquece o payload completo do solver (usado tanto por /solver-payload
 * para execução via Web Worker no navegador quanto por /run-mock no servidor).
 */
async function assembleEnrichedSolverPayload({
  escolaId,
  turnoNorm,
  ids,
  anoRef,
  nivel,
  semestre = null,
  respeitarHorarioManual = true,
}) {
  const payload = await buildSolverPayload({
    escolaId,
    turno: turnoNorm,
    turmaIds: ids,
    anoRef,
    semestre,
    respeitarHorarioManual,
  });

  payload.ano_ref = anoRef;

  const configPersistida = await loadConfigPedagogica({
    escolaId,
    turno: turnoNorm,
    anoRef,
    nivel,
  });

  if (configPersistida) {
    payload.config_pedagogica = {
      ...configPersistida,
      regras_gerais: payload.config_pedagogica?.regras_gerais || configPersistida.regras_gerais || null,
    };
  } else if (!payload.config_pedagogica) {
    payload.config_pedagogica = { regras: {} };
  }

  if (!payload.config_pedagogica.regras) payload.config_pedagogica.regras = {};

  // Injeta regras_gerais (globais da escola) no payload caso ainda não estejam presentes
  try {
    const [[escolaCfg]] = await pool.query(
      "SELECT periodos FROM escola_configuracao_grade WHERE escola_id = ? LIMIT 1",
      [escolaId]
    );
    if (escolaCfg && escolaCfg.periodos) {
      let parsedPeriodos =
        typeof escolaCfg.periodos === "string" ? JSON.parse(escolaCfg.periodos) : escolaCfg.periodos;
      if (Buffer.isBuffer(escolaCfg.periodos)) {
        parsedPeriodos = JSON.parse(escolaCfg.periodos.toString("utf8"));
      }

      if (parsedPeriodos && parsedPeriodos._regras_gerais) {
        payload.config_pedagogica.regras_gerais = {
          ...parsedPeriodos._regras_gerais,
          _intervalos_governanca:
            payload.intervalos_por_turno ||
            payload.config_pedagogica?.regras_gerais?._intervalos_governanca ||
            {},
        };

        if (parsedPeriodos._regras_gerais.preferencia_aulas_duplas) {
          payload.config_pedagogica.regras.rc01_distribuicao_disciplina = {
            modo: "hard",
            max_consecutivas: 2,
          };
        }
        if (parsedPeriodos._regras_gerais.max_aulas_mesmo_dia) {
          payload.config_pedagogica.regras.rc02_max_por_dia_disciplina = {
            modo: "hard",
            max_por_dia_padrao: parsedPeriodos._regras_gerais.max_aulas_mesmo_dia,
            bloqueio_hard: true,
          };
        }
      }
    }
  } catch (err) {
    console.warn("[grade/run-mock] Falha ao injetar regras_gerais:", err.message);
  }

  // Analisa utilização dos professores usando dias_semana e periodos_por_dia reais da escola
  const periodosPorDia = Number(payload.periodos_por_dia) || 6;
  const diasSemana = Array.isArray(payload.dias_semana) && payload.dias_semana.length
    ? payload.dias_semana.length
    : 5;
  const maxSlotsProf = periodosPorDia * diasSemana;

  const dem = Array.isArray(payload.demanda) ? payload.demanda : [];
  const mod = Array.isArray(payload.modulacao) ? payload.modulacao : [];
  const profIndex = new Map();
  for (const m of mod) {
    const k = `${m.turma_id}|${m.disciplina_id}`;
    if (!profIndex.has(k)) profIndex.set(k, { id: m.professor_id, nome: m.professor_nome });
  }
  const profCarga = new Map();
  for (const d of dem) {
    const prof = profIndex.get(`${d.turma_id}|${d.disciplina_id}`);
    if (!prof) continue;
    const prev = profCarga.get(prof.id) || { id: prof.id, nome: prof.nome, aulas: 0 };
    prev.aulas += Number(d.carga || 0);
    profCarga.set(prof.id, prev);
  }
  // ETAPA 3: Recalcula blocos simultâneos, recursos físicos e restrições inter-turnos com regras_gerais consolidadas
  const regrasGeraisFinais = payload.config_pedagogica?.regras_gerais || {};
  payload.blocos_simultaneos = buildBlocosSimultaneosConsolidados({
    agrupamentos: payload.agrupamentos || [],
    demanda: dem,
    modulacao: mod,
    turmas: payload.turmas || [],
    regrasGerais: regrasGeraisFinais,
    turnoNorm,
  });
  payload.recursos_fisicos = normalizarRecursosFisicos(regrasGeraisFinais);

  if (regrasGeraisFinais?.interturno_regras || !payload.restricoes_interturno) {
    const profIdsPayload = Array.from(new Set(mod.map((m) => Number(m.professor_id)).filter(Boolean)));
    payload.restricoes_interturno = await fetchRestricoesInterTurnosPorCpf(pool, {
      escolaId,
      turnoNorm,
      profIds: profIdsPayload,
      horariosPorTurno: payload.horarios_por_turno || {},
      diasSemana: payload.dias_semana || [1, 2, 3, 4, 5],
      periodosPorDia,
      regrasGerais: regrasGeraisFinais,
    });
  }

  const descontosUnidasMap = calcularDescontoAulasUnidasPorProfessor(payload.blocos_simultaneos);

  const warnings_payload = Array.from(profCarga.values())
    .map((p) => {
      const desc = Number(descontosUnidasMap.get(Number(p.id))?.desconto_slots) || 0;
      const aulasFisicas = Math.max(0, p.aulas - desc);
      return { ...p, aulas_fisicas: aulasFisicas, desconto_turmas_unidas: desc };
    })
    .filter((p) => p.aulas_fisicas >= maxSlotsProf - 2)
    .map((p) => ({
      professor_id: p.id,
      professor_nome: p.nome,
      aulas_demanda: p.aulas_fisicas,
      aulas_moduladas_brutas: p.aulas,
      desconto_turmas_unidas: p.desconto_turmas_unidas,
      slots_disponiveis: maxSlotsProf,
      utilization_pct: Math.round((p.aulas_fisicas / maxSlotsProf) * 100),
      is_100_percent: p.aulas_fisicas >= maxSlotsProf,
    }));

  const slotsFixosNoEscopo = Array.isArray(payload.slots_fixos)
    ? payload.slots_fixos.filter((s) => s.in_scope !== false).length
    : 0;

  const payload_summary = {
    escola_id: payload.escola_id || escolaId,
    turno: payload.turno || turnoNorm,
    ano_ref: payload.ano_ref ?? null,
    semestre: payload.semestre || 1,
    vigencia: payload.vigencia || null,
    nivel: payload.config_pedagogica?.nivel || nivel,
    dias_semana: payload.dias_semana || [1, 2, 3, 4, 5],
    periodos_por_dia: periodosPorDia,
    turmas: Array.isArray(payload.turmas) ? payload.turmas.length : 0,
    demanda: Array.isArray(payload.demanda) ? payload.demanda.length : 0,
    professores: Array.isArray(payload.modulacao)
      ? new Set(payload.modulacao.map((m) => m.professor_id)).size
      : 0,
    slots_fixos_count: slotsFixosNoEscopo,
    blocos_simultaneos_count: Array.isArray(payload.blocos_simultaneos) ? payload.blocos_simultaneos.length : 0,
    recursos_fisicos_count: Array.isArray(payload.recursos_fisicos) ? payload.recursos_fisicos.length : 0,
    professores_multiturno_count: Array.isArray(payload.restricoes_interturno?.resumo_professores_multiturno)
      ? payload.restricoes_interturno.resumo_professores_multiturno.length
      : 0,
  };

  return { payload, warnings_payload, payload_summary };
}

/**
 * POST /api/grade/solver-payload
 * Retorna o payload enriquecido completo em < 200ms para o motor Solver 2.0
 * rodar em um Web Worker dedicado no navegador do cliente (sem timeout HTTP).
 */
router.post("/solver-payload", requireEscola, async (req, res) => {
  try {
    const turnoNorm = normalizeTurno(req.body?.turno);
    if (!turnoNorm) {
      return res.status(400).json({ error: "turno inválido (ex: 'matutino')." });
    }

    const ids = parseTurmaIds(req.body?.turma_ids);
    if (!ids.length) {
      return res.status(400).json({ error: "turma_ids inválido (ex: '147,148' ou [147,148])." });
    }

    const anoRef =
      req.body?.ano_ref === null || req.body?.ano_ref === undefined || req.body?.ano_ref === ""
        ? null
        : Number(req.body?.ano_ref);

    const nivel =
      typeof req.body?.nivel === "string" && req.body.nivel.trim()
        ? req.body.nivel.trim()
        : "fundamental_II";

    const semestre = req.body?.semestre ? Number(req.body.semestre) : null;
    const respeitarHorarioManual = req.body?.respeitar_horario_manual !== false;

    const { payload, warnings_payload, payload_summary } = await assembleEnrichedSolverPayload({
      escolaId: req.escolaId,
      turnoNorm,
      ids,
      anoRef,
      nivel,
      semestre,
      respeitarHorarioManual,
    });

    return res.json({
      ok: true,
      payload,
      warnings_payload,
      payload_summary,
    });
  } catch (e) {
    console.error("POST /api/grade/solver-payload", e);
    return res.status(500).json({
      error: "Falha ao montar payload do solver.",
      details: !isProd() ? e?.message : undefined,
    });
  }
});

/**
 * POST /api/grade/run-mock
 * Body (mínimo):
 * - turno: "matutino"
 * - turma_ids: "147,148" (ou [147,148])
 *
 * Campos opcionais:
 * - ano_ref: 2026
 * - nivel: "fundamental_II"
 * - semestre: 1 | 2
 * - respeitar_horario_manual: true | false
 */
router.post("/run-mock", requireEscola, async (req, res) => {
  const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const turnoNorm = normalizeTurno(req.body?.turno);
    if (!turnoNorm) {
      return res.status(400).json({ error: "turno inválido (ex: 'matutino')." });
    }

    const ids = parseTurmaIds(req.body?.turma_ids);
    if (!ids.length) {
      return res.status(400).json({ error: "turma_ids inválido (ex: '147,148' ou [147,148])." });
    }

    const anoRef =
      req.body?.ano_ref === null || req.body?.ano_ref === undefined || req.body?.ano_ref === ""
        ? null
        : Number(req.body?.ano_ref);

    if (anoRef !== null && !Number.isFinite(anoRef)) {
      return res.status(400).json({ error: "ano_ref inválido (ex: 2026)." });
    }

    const nivel =
      typeof req.body?.nivel === "string" && req.body.nivel.trim()
        ? req.body.nivel.trim()
        : "fundamental_II";

    const semestre = req.body?.semestre ? Number(req.body.semestre) : null;
    const respeitarHorarioManual = req.body?.respeitar_horario_manual !== false;

    const { payload, warnings_payload, payload_summary } = await assembleEnrichedSolverPayload({
      escolaId: req.escolaId,
      turnoNorm,
      ids,
      anoRef,
      nivel,
      semestre,
      respeitarHorarioManual,
    });

    let bestResult = null;
    let maxQualidade = -Infinity;

    const MAX_TIME_MS = 8500;
    const startTime = Date.now();
    let iter = 0;
    let perfectFound = false;

    const strategies = [
      "dsatur_slack",
      "group_turma",
      "scarce_first",
      "dsatur_slack",
      "weight_desc",
      "reverse_weight",
      "random",
    ];

    while (Date.now() - startTime < MAX_TIME_MS) {
      const strategy = strategies[iter % strategies.length];
      const isRandomized = iter > 0;

      const result = runGreedySolver(payload, isRandomized, strategy);

      const alocadas = result.metrics.aulas_alocadas || 0;
      const demanda = result.metrics.aulas_demanda || 1;
      const qScore = result.metrics.qualidade_score ?? alocadas * 1000000;

      if (qScore > maxQualidade) {
        maxQualidade = qScore;
        bestResult = result;
      }

      if (
        alocadas >= demanda &&
        (result.metrics.violacoes_separadas_mesmo_dia || 0) === 0 &&
        (result.metrics.violacoes_max_dia || 0) === 0
      ) {
        perfectFound = true;
        if (!isProd()) {
          console.log(
            `[grade/run-mock] Achou grade 100% na iteração ${iter} com estratégia '${strategy}'! Tempo: ${Date.now() - startTime}ms`
          );
        }
        break;
      }
      iter++;
    }

    const result = bestResult || runGreedySolver(payload, false, "dsatur_slack");

    return res.json({
      ok: true,
      traceId,
      warnings_payload,
      payload_summary,
      solver_telemetry: {
        iteracoes: iter + 1,
        tempo_ms: Date.now() - startTime,
        perfeito: perfectFound,
      },
      ...result,
    });
  } catch (e) {
    console.error("POST /api/grade/run-mock", e);

    if (!isProd()) {
      return res.status(500).json({
        error: "Falha ao executar solver.",
        traceId,
        details: {
          message: e?.message || String(e),
          stack: e?.stack || null,
          name: e?.name || null,
          code: e?.code || null,
        },
      });
    }

    return res.status(500).json({ error: "Falha ao executar solver." });
  }
});

/**
 * POST /api/grade/debug-payload
 * Retorna o payload do solver SEM executar o motor.
 * Útil para diagnosticar problemas de dados.
 */
router.post("/debug-payload", requireEscola, async (req, res) => {
  try {
    const turnoNorm = normalizeTurno(req.body?.turno);
    if (!turnoNorm) return res.status(400).json({ error: "turno inválido." });

    const ids = parseTurmaIds(req.body?.turma_ids);
    if (!ids.length) return res.status(400).json({ error: "turma_ids inválido." });

    const payload = await buildSolverPayload({
      escolaId: req.escolaId,
      turno: turnoNorm,
      turmaIds: ids,
    });

    // Contagens de carga por professor
    const dem = Array.isArray(payload?.demanda) ? payload.demanda : [];
    const mod = Array.isArray(payload?.modulacao) ? payload.modulacao : [];
    const periodosPorDia = 6;
    const diasSemana = 5;
    const maxSlots = periodosPorDia * diasSemana;

    // Build profIndex (turma|disc -> profId)
    const profIndex = new Map();
    for (const m of mod) {
      const k = `${m.turma_id}|${m.disciplina_id}`;
      if (!profIndex.has(k)) profIndex.set(k, m.professor_id);
    }

    // Carga total por professor
    const cargaPorProf = new Map();
    for (const d of dem) {
      const profId = d.professor_id || profIndex.get(`${d.turma_id}|${d.disciplina_id}`) || 0;
      if (!profId) continue;
      const atual = cargaPorProf.get(profId) || { professor_id: profId, nome: "?", aulas: 0, turmas: [] };
      atual.aulas += Number(d.carga || 0);
      atual.turmas.push(d.turma_id);
      cargaPorProf.set(profId, atual);
    }

    // Enriquece com nome do professor via modulacao
    for (const m of mod) {
      const entry = cargaPorProf.get(m.professor_id);
      if (entry && entry.nome === "?") entry.nome = m.professor_nome || "?";
    }

    const profSobrecarregados = Array.from(cargaPorProf.values())
      .sort((a, b) => b.aulas - a.aulas)
      .map(p => ({
        ...p,
        turmas: [...new Set(p.turmas)],
        sobrecarga: p.aulas > maxSlots,
        maxSlots,
      }));

    return res.json({
      ok: true,
      turmas_count: payload.turmas?.length || 0,
      demanda_count: dem.length,
      modulacao_count: mod.length,
      disponibilidades_count: payload.disponibilidades?.length || 0,
      max_slots_por_professor: maxSlots,
      professores_carga: profSobrecarregados,
      sobrecarga_total: profSobrecarregados.filter(p => p.sobrecarga).length,
    });
  } catch (e) {
    console.error("POST /api/grade/debug-payload", e);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
