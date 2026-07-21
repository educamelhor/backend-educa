// ==================================================================================
// backend/routes/gradeRunMock.js
// Rota para rodar o mock solver usando o payload real do solverPayloadService.
// ==================================================================================

import express from "express";
import pool from "../db.js";
import { buildSolverPayload } from "../services/solverPayloadService.js";
import { runGreedySolver } from "../services/mockGreedySolver.js";

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
 * POST /api/grade/run-mock
 * Body (mínimo):
 * - turno: "matutino"
 * - turma_ids: "147,148" (ou [147,148])
 *
 * Campos opcionais (para casar com Configurações Pedagógicas):
 * - ano_ref: 2025
 * - nivel: "fundamental_II"
 */
router.post("/run-mock", requireEscola, async (req, res) => {
  // Trace ID para correlacionar com logs do backend
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

    // Para manter o comportamento correto do vínculo com Configurações Pedagógicas:
    // - ano_ref deve ser propagado, para carregar a configuração correta.
    const anoRef = req.body?.ano_ref === null || req.body?.ano_ref === undefined || req.body?.ano_ref === ""
      ? null
      : Number(req.body?.ano_ref);

    if (anoRef !== null && !Number.isFinite(anoRef)) {
      return res.status(400).json({ error: "ano_ref inválido (ex: 2025)." });
    }

    // nível é parte da chave de configuração pedagógica (como no route config_pedagogica.js)
    const nivel = typeof req.body?.nivel === "string" && req.body.nivel.trim()
      ? req.body.nivel.trim()
      : "fundamental_II";

    // ------------------------- DIAGNÓSTICO (entrada) -------------------------
    if (!isProd()) {
      console.log("[grade/run-mock] traceId=", traceId);
      console.log("[grade/run-mock] escolaId=", req.escolaId, "turno=", turnoNorm, "ano_ref=", anoRef, "nivel=", nivel);
      console.log("[grade/run-mock] turmaIds=", ids);
      console.log("[grade/run-mock] bodyPreview=", safePreview(req.body || {}));
    }

    // 1) Monta o payload-base pelo serviço padrão (já validado no fluxo)
    if (!isProd()) console.log("[grade/run-mock] (1) buildSolverPayload: INÍCIO", "traceId=", traceId);

    const payload = await buildSolverPayload({
      escolaId: req.escolaId,
      turno: turnoNorm,
      turmaIds: ids,
    });

    if (!isProd()) {
      console.log("[grade/run-mock] (1) buildSolverPayload: OK", "traceId=", traceId);
      console.log("[grade/run-mock] payloadStats=", pickPayloadStats(payload));
    }

    // 2) Injeta ano_ref no payload (para rastreio/diagnóstico e compatibilidade do solver)
    payload.ano_ref = anoRef;

    // 3) Força o payload usar a Configuração Pedagógica persistida (se existir),
    // garantindo que RC-01/RC-02 cheguem com "Hard/Soft" e limites corretos no solver.
    if (!isProd()) console.log("[grade/run-mock] (3) loadConfigPedagogica: INÍCIO", "traceId=", traceId);

    const configPersistida = await loadConfigPedagogica({
      escolaId: req.escolaId,
      turno: turnoNorm,
      anoRef,
      nivel,
    });

    if (!isProd()) {
      console.log(
        "[grade/run-mock] (3) loadConfigPedagogica:",
        configPersistida ? "ENCONTRADA" : "NÃO ENCONTRADA",
        "traceId=",
        traceId
      );
      if (configPersistida) console.log("[grade/run-mock] configPedagogicaPreview=", safePreview(configPersistida));
    }

    if (configPersistida) {
      payload.config_pedagogica = configPersistida;
    } else {
      // fallback defensivo: garante estrutura mínima esperada pelo solver
      payload.config_pedagogica = { regras: {} };
    }
    
    if (!payload.config_pedagogica.regras) payload.config_pedagogica.regras = {};

    // 3.5) Injeta regras_gerais (globais da escola) no payload
    try {
      const [[escolaCfg]] = await pool.query(
        'SELECT periodos FROM escola_configuracao_grade WHERE escola_id = ? LIMIT 1',
        [req.escolaId]
      );
      if (escolaCfg && escolaCfg.periodos) {
        let parsedPeriodos = typeof escolaCfg.periodos === 'string' ? JSON.parse(escolaCfg.periodos) : escolaCfg.periodos;
        if (Buffer.isBuffer(escolaCfg.periodos)) parsedPeriodos = JSON.parse(escolaCfg.periodos.toString('utf8'));
        
        if (parsedPeriodos && parsedPeriodos._regras_gerais) {
          payload.config_pedagogica.regras_gerais = parsedPeriodos._regras_gerais;
          
          // Compatibilidade RC01 e RC02 forçada pelas regras gerais
          if (parsedPeriodos._regras_gerais.preferencia_aulas_duplas) {
             payload.config_pedagogica.regras.rc01_distribuicao_disciplina = {
               modo: 'hard', max_consecutivas: 2
             };
          }
          if (parsedPeriodos._regras_gerais.max_aulas_mesmo_dia) {
             payload.config_pedagogica.regras.rc02_max_por_dia_disciplina = {
               modo: 'hard', max_por_dia_padrao: parsedPeriodos._regras_gerais.max_aulas_mesmo_dia, bloqueio_hard: true
             };
          }
        }
      }
    } catch (err) {
      console.warn("[grade/run-mock] Falha ao injetar regras_gerais:", err.message);
    }

    // 4) Executa o solver mock (greedy) com Multi-Start (Monte Carlo)
    if (!isProd()) console.log("[grade/run-mock] (4) runGreedySolver: INÍCIO", "traceId=", traceId);

    let bestResult = null;
    let maxAulas = -1;
    
    // O usuário permitiu que leve mais tempo para atingir 100%. 
    // Vamos rodar o Monte Carlo intensamente por até 15 segundos ou até achar 100%.
    const MAX_TIME_MS = 15000; 
    const startTime = Date.now();
    let iter = 0;
    let perfectFound = false;

    while (Date.now() - startTime < MAX_TIME_MS) {
      // Determina estratégia de ordenação e jitter ciclicamente
      let strategy = "default";
      let isRandomized = iter > 0;
      
      const cycle = iter % 100;
      // 0-19: scarce_first (default, best for 100% load)
      // 20-39: weight_desc (classic greedy)
      // 40-59: reverse_weight
      // 60-79: random
      // 80-99: scarce_first again (very effective)
      
      if (cycle >= 20 && cycle < 40) strategy = "weight_desc";
      else if (cycle >= 40 && cycle < 60) strategy = "reverse_weight";
      else if (cycle >= 60 && cycle < 80) strategy = "random";
      else strategy = "default"; // scarce_first

      const result = runGreedySolver(payload, isRandomized, strategy);
      
      const alocadas = result.metrics.aulas_alocadas || 0;
      const demanda = result.metrics.aulas_demanda || 1;
      
      if (alocadas > maxAulas) {
        maxAulas = alocadas;
        bestResult = result;
      }
      
      // Se alcançou 100% perfeito, para imediatamente
      if (alocadas === demanda) {
        perfectFound = true;
        if (!isProd()) console.log(`[grade/run-mock] Achou grade perfeita na iteração ${iter} com estratégia '${strategy}'! Tempo: ${Date.now() - startTime}ms`);
        break;
      }
      iter++;
    }

    if (!perfectFound && !isProd()) {
      console.log(`[grade/run-mock] Fim do tempo (${MAX_TIME_MS}ms). Total de iterações: ${iter}. Melhor alocação: ${maxAulas}`);
    }

    const result = bestResult;

    if (!isProd()) {
      console.log("[grade/run-mock] (4) runGreedySolver: OK", "traceId=", traceId);
      console.log("[grade/run-mock] resultPreview=", safePreview(result));
    }

    // 5) Analisa utilização dos professores para avisos na UI
    const periodosPorDia = 6;
    const diasSemana = 5;
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
    const warnings_payload = Array.from(profCarga.values())
      .filter(p => p.aulas >= maxSlotsProf - 2)
      .map(p => ({
        professor_id: p.id,
        professor_nome: p.nome,
        aulas_demanda: p.aulas,
        slots_disponiveis: maxSlotsProf,
        utilization_pct: Math.round((p.aulas / maxSlotsProf) * 100),
        is_100_percent: p.aulas >= maxSlotsProf
      }));

    return res.json({
      ok: true,
      traceId,
      warnings_payload,
      payload_summary: {
        escola_id: payload.escola_id || req.escolaId,
        turno: payload.turno || turnoNorm,
        ano_ref: payload.ano_ref ?? null,
        nivel: payload.config_pedagogica?.nivel || nivel,
        turmas: Array.isArray(payload.turmas) ? payload.turmas.length : 0,
        demanda: Array.isArray(payload.demanda) ? payload.demanda.length : 0,
        professores: Array.isArray(payload.modulacao)
          ? new Set(payload.modulacao.map((m) => m.professor_id)).size
          : 0,
      },
      ...result,
    });
  } catch (e) {
    // ------------------------- DIAGNÓSTICO (erro) ----------------------------
    console.error("POST /api/grade/run-mock", e);

    // Em DEV: devolve detalhes (message/stack) para localizar o ponto exato do 500
    if (!isProd()) {
      return res.status(500).json({
        error: "Falha ao executar mock.",
        traceId,
        details: {
          message: e?.message || String(e),
          stack: e?.stack || null,
          name: e?.name || null,
          code: e?.code || null,
        },
      });
    }

    // Em PROD: mantém resposta enxuta
    return res.status(500).json({ error: "Falha ao executar mock." });
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
