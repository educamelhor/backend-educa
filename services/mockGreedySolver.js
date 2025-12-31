/**
 * EDUCA.MELHOR — Módulo Horários (Mock Greedy Solver)
 * --------------------------------------------------------------------------------------
 * Objetivo
 * - Gerar uma grade horária "mock" de forma determinística e estável.
 * - Respeitar (na medida do possível) regras pedagógicas básicas:
 *      RC01: limite de consecutivas da mesma disciplina na turma.
 *      RC02: limite de ocorrências por dia da mesma disciplina na turma.
 *
 * Observações importantes (para estabilização)
 * - Este arquivo precisa SEMPRE retornar estruturas completas (dias/períodos inicializados),
 *   para evitar erros do tipo: "Cannot read properties of undefined (reading '1')".
 * - Mesmo quando a demanda for 0 ou não houver turmas, retornamos grade_por_turma/grade_por_professor
 *   como objetos (vazios) e métricas coerentes.
 *
 * Compatibilidade esperada com gradeRunMock.js
 * - payload.turmas: array de objetos com turma_id (ou id), ex: { turma_id: 147, ... }
 * - payload.demanda (ou payload.modulacao): lista com {turma_id, disciplina_id, professor_id, aulas_semanais}
 * - payload.disponibilidades: lista com disponibilidade do professor (quando existir)
 * - payload.config_pedagogica.regras.rc01_distribuicao_disciplina / rc02_max_por_dia_disciplina
 * - payload.periodos_por_dia (opcional) — default 6
 *
 * Logs de diagnóstico
 * - Mantém logs [MOCK_SOLVER_RC02] e [MOCK_SOLVER_RC02_CFG_RAW] para rastrear RC02.
 */

// --------------------------------------------------------------------------------------
// Helpers básicos
// --------------------------------------------------------------------------------------

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeObj(v) {
  return v && typeof v === "object" ? v : {};
}

function stableKey(v) {
  // Força chave estável para ordenação (string).
  if (v === null || v === undefined) return "";
  return String(v);
}

function stableSortByKeys(arr, keys) {
  // Ordenação estável: mantém ordem original em empate.
  return (arr || [])
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      for (const k of keys) {
        const av = stableKey(a.item?.[k]);
        const bv = stableKey(b.item?.[k]);
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      return a.idx - b.idx;
    })
    .map((x) => x.item);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function ensurePath(obj, ...keys) {
  let ref = obj;
  for (const k of keys) {
    if (!ref[k]) ref[k] = {};
    ref = ref[k];
  }
  return ref;
}

// --------------------------------------------------------------------------------------
// Leitura das regras RC01/RC02 (com defaults e compatibilidade)
// --------------------------------------------------------------------------------------

function readRc01MaxConsecutivas(configPedagogica) {
  const regras = safeObj(configPedagogica?.regras);
  const rc01 = safeObj(regras?.rc01_distribuicao_disciplina);

  // default do seu contrato pedagógico: 2
  const max = toInt(rc01?.max_consecutivas, 2);
  return clamp(max, 1, 6);
}

function readRc02Config(configPedagogica) {
  const regras = safeObj(configPedagogica?.regras);

  // Aceita variações de nome (para não quebrar caso você renomeie no frontend/backend)
  const rc02 =
    safeObj(regras?.rc02_max_por_dia_disciplina) ||
    safeObj(regras?.rc02_distribuicao_por_dia) ||
    safeObj(regras?.rc02);

  // Defaults seguros
  const modoRaw = (rc02?.modo || "soft").toString().toLowerCase();
  const modo = ["hard", "soft"].includes(modoRaw) ? modoRaw : "soft";

  const maxPadrao = clamp(toInt(rc02?.max_por_dia_padrao, 2), 1, 6);

  // Por disciplina (disciplina_id => maxPorDia)
  const porDisciplina = safeObj(rc02?.por_disciplina);

  /**
   * strict_cap_mock
   * - Quando true: o mock NÃO pode exceder RC02 mesmo em modo soft (age como "teto duro").
   * - Quando false: no modo soft o mock pode exceder (com penalidade), para melhorar cobertura.
   *
   * Observação: você mostrou prints alternando e o retorno ficando instável (0 turmas/demanda).
   * Isso normalmente é efeito colateral de grade incompleta/erro em runtime. Este flag não deve
   * quebrar nada: ele só altera decisão de alocação.
   */
  const strictCapMock = !!rc02?.strict_cap_mock;

  // “bloqueioHard” foi usado nos seus logs antigos; mantemos compatibilidade.
  const bloqueioHard = rc02?.bloqueio_hard === undefined ? false : !!rc02?.bloqueio_hard;
  const maxHardPadrao = clamp(toInt(rc02?.max_por_dia_padrao_hard, maxPadrao), 1, 6);

  const cfg = {
    modo,
    maxPadrao,
    porDisciplina,
    bloqueioHard,
    maxHardPadrao,
    strictCapMock,
  };

  // Logs compatíveis com seus prints
  console.log("[MOCK_SOLVER_RC02]", {
    RC02_MODO: cfg.modo,
    RC02_MAX_POR_DIA_PADRAO: cfg.maxPadrao,
    RC02_BLOQUEIO_POR_DIA_HARD: cfg.bloqueioHard,
    RC02_MAX_POR_DIA_PADRAO_HARD: cfg.maxHardPadrao,
  });
  console.log("[MOCK_SOLVER_RC02_CFG_RAW]", {
    rc02Obj: rc02 || {},
    RC02_POR_DISCIPLINA: porDisciplina || {},
  });

  return cfg;
}

function getRc02MaxForDisc(rc02Cfg, disciplinaId) {
  const dId = stableKey(disciplinaId);
  const override = rc02Cfg?.porDisciplina?.[dId];
  const max = override !== undefined ? toInt(override, rc02Cfg.maxPadrao) : rc02Cfg.maxPadrao;
  return clamp(max, 1, 6);
}

// --------------------------------------------------------------------------------------
// Estruturas de grade (sempre completas) e contadores
// --------------------------------------------------------------------------------------

function initEmptyGridForEntity(daysCount, periodosPorDia) {
  const grid = {};
  for (let dia = 1; dia <= daysCount; dia++) {
    grid[dia] = {};
    for (let p = 1; p <= periodosPorDia; p++) {
      grid[dia][p] = null;
    }
  }
  return grid;
}

function initGradePorTurma(turmaIds, daysCount, periodosPorDia) {
  const grade = {};
  for (const turmaId of turmaIds) {
    grade[turmaId] = initEmptyGridForEntity(daysCount, periodosPorDia);
  }
  return grade;
}

function initGradePorProfessor(profIds, daysCount, periodosPorDia) {
  const grade = {};
  for (const profId of profIds) {
    grade[profId] = initEmptyGridForEntity(daysCount, periodosPorDia);
  }
  return grade;
}

function countConsecutiveSameDisc(gradeTurma, dia, periodo, disciplinaId) {
  // Conta consecutivas ao redor do slot (apenas para a turma no mesmo dia)
  // Ex.: se for alocar no período 3, e já tem mesma disciplina em 2 e 1, retorna 2 etc.
  let left = 0;
  for (let p = periodo - 1; p >= 1; p--) {
    const cell = gradeTurma?.[dia]?.[p];
    if (!cell || cell.disciplina_id !== disciplinaId) break;
    left++;
  }
  let right = 0;
  for (let p = periodo + 1; p <= Object.keys(gradeTurma?.[dia] || {}).length; p++) {
    const cell = gradeTurma?.[dia]?.[p];
    if (!cell || cell.disciplina_id !== disciplinaId) break;
    right++;
  }
  return left + right + 1;
}

function countDiscInDay(gradeTurma, dia, disciplinaId) {
  let c = 0;
  const row = gradeTurma?.[dia] || {};
  for (const p of Object.keys(row)) {
    const cell = row[p];
    if (cell && cell.disciplina_id === disciplinaId) c++;
  }
  return c;
}

// --------------------------------------------------------------------------------------
// Disponibilidades do professor (se vier vazio, assume "livre")
// --------------------------------------------------------------------------------------

function buildDisponibilidadeIndex(disponibilidades, daysCount, periodosPorDia) {
  // Map: professor_id -> Set("dia|periodo")
  const idx = new Map();

  const list = Array.isArray(disponibilidades) ? disponibilidades : [];

  for (const d of list) {
    const profId = toInt(d.professor_id, 0);
    const dia = toInt(d.dia, toInt(d.dia_semana, 0));
    const periodo = toInt(d.periodo, toInt(d.aula, 0));

    if (!profId || dia < 1 || dia > daysCount || periodo < 1 || periodo > periodosPorDia) continue;

    if (!idx.has(profId)) idx.set(profId, new Set());
    idx.get(profId).add(`${dia}|${periodo}`);
  }

  return idx;
}

function professorPode(dispoIdx, professorId, dia, periodo) {
  // Se não há nenhuma disponibilidade registrada para este professor, assume livre.
  const set = dispoIdx.get(toInt(professorId, 0));
  if (!set) return true;
  return set.has(`${dia}|${periodo}`);
}

// --------------------------------------------------------------------------------------
// Score de slot (greedy) — menor é melhor
// --------------------------------------------------------------------------------------

function computeSlotScore({
  turmaGrade,
  profGrade,
  dia,
  periodo,
  turmaId,
  professorId,
  disciplinaId,
  rc01MaxConsecutivas,
  rc02Cfg,
}) {
  let score = 0;

  // (A) Penaliza slots mais tarde no dia (tende a preencher cedo, estabiliza visualmente)
  score += periodo * 0.5;

  // (B) Penaliza fragmentação no dia: preferir ocupar blocos
  //     Se vizinhos já ocupados, melhor (menos score).
  const leftOcc = periodo > 1 && !!turmaGrade?.[dia]?.[periodo - 1];
  const rightOcc = !!turmaGrade?.[dia]?.[periodo + 1];
  if (leftOcc) score -= 0.7;
  if (rightOcc) score -= 0.4;

  // (C) RC01: consecutivas
  const consec = countConsecutiveSameDisc(turmaGrade, dia, periodo, disciplinaId);
  if (consec > rc01MaxConsecutivas) {
    // Penalidade forte; se insistir, derruba cobertura antes (deixa para último caso)
    score += 1000 + (consec - rc01MaxConsecutivas) * 200;
  }

  // (D) RC02: por dia
  const maxDia = getRc02MaxForDisc(rc02Cfg, disciplinaId);
  const inDay = countDiscInDay(turmaGrade, dia, disciplinaId);

  // Se já atingiu o teto e for estrito, torna inviável
  const strictCap = !!rc02Cfg?.strictCapMock;

  if (inDay >= maxDia) {
    if (strictCap || rc02Cfg.modo === "hard" || (rc02Cfg.bloqueioHard && maxDia === rc02Cfg.maxHardPadrao)) {
      // inviabiliza na prática
      score += 50000;
    } else {
      // modo soft: permite exceder com penalidade crescente
      score += 1500 + (inDay - maxDia + 1) * 400;
    }
  }

  // (E) evita sobrecarga de professor no mesmo dia cedo demais (leve)
  //     Se professor já tem aula no mesmo dia, prefere agrupar (reduz score) para reduzir janelas.
  let profDayCount = 0;
  const profRow = profGrade?.[dia] || {};
  for (const p of Object.keys(profRow)) {
    if (profRow[p]) profDayCount++;
  }
  if (profDayCount > 0) score -= 0.3;

  // (F) desempate estável por dia: preferir segunda/terça (estabiliza)
  score += dia * 0.05;

  return score;
}

// --------------------------------------------------------------------------------------
// Expansão da demanda em aulas unitárias (lista de alocações)
// --------------------------------------------------------------------------------------

function normalizeTurmaIds(payload) {
  const turmas = Array.isArray(payload?.turmas) ? payload.turmas : [];
  const ids = turmas
    .map((t) => toInt(t.turma_id ?? t.id, 0))
    .filter((x) => x > 0);
  return uniq(ids);
}

function normalizeDemandas(payload) {
  const dem = Array.isArray(payload?.demanda) ? payload.demanda : [];
  const mod = Array.isArray(payload?.modulacao) ? payload.modulacao : [];

  // Índice: (turma_id|disciplina_id) -> professor_id
  const profIndex = new Map();
  for (const m of mod) {
    const turmaId = toInt(m.turma_id ?? m.turmaId, 0);
    const discId = toInt(m.disciplina_id ?? m.disciplinaId, 0);
    const profId = toInt(m.professor_id ?? m.professorId, 0);
    if (turmaId > 0 && discId > 0 && profId > 0) {
      const k = `${turmaId}|${discId}`;
      // mantém o primeiro (determinismo)
      if (!profIndex.has(k)) profIndex.set(k, profId);
    }
  }

  // Se existir demanda (turma_cargas), usamos ela e “completamos” professor_id via modulação
  if (dem.length) {
    return dem
      .map((x) => {
        const turma_id = toInt(x.turma_id ?? x.turmaId, 0);
        const disciplina_id = toInt(x.disciplina_id ?? x.disciplinaId, 0);

        const professor_id =
          toInt(x.professor_id ?? x.professorId, 0) ||
          profIndex.get(`${turma_id}|${disciplina_id}`) ||
          0;

        const aulas_semanais = clamp(
          toInt(x.aulas_semanais ?? x.aulasSemanais ?? x.qtd ?? x.carga ?? 0, 0),
          0,
          60
        );

        return { turma_id, disciplina_id, professor_id, aulas_semanais };
      })
      .filter(
        (x) =>
          x.turma_id > 0 &&
          x.disciplina_id > 0 &&
          x.professor_id > 0 && // agora vem da modulação
          x.aulas_semanais > 0
      );
  }

  // Fallback: se não houver demanda, tenta usar payload.modulacao (legado)
  return mod
    .map((x) => ({
      turma_id: toInt(x.turma_id ?? x.turmaId, 0),
      disciplina_id: toInt(x.disciplina_id ?? x.disciplinaId, 0),
      professor_id: toInt(x.professor_id ?? x.professorId, 0),
      aulas_semanais: clamp(toInt(x.aulas_semanais ?? x.aulasSemanais ?? x.qtd ?? x.carga ?? 0, 0), 0, 60),
    }))
    .filter(
      (x) =>
        x.turma_id > 0 &&
        x.disciplina_id > 0 &&
        x.professor_id > 0 &&
        x.aulas_semanais > 0
    );
}

function expandDemandasToLessons(demandas) {
  const lessons = [];
  for (const d of demandas) {
    for (let i = 0; i < d.aulas_semanais; i++) {
      lessons.push({
        turma_id: d.turma_id,
        disciplina_id: d.disciplina_id,
        professor_id: d.professor_id,
        // índice local ajuda a manter determinismo
        seq: i + 1,
      });
    }
  }

  // Ordena estável: primeiro maior carga (para garantir cobertura), depois por ids
  const countKey = new Map();
  for (const d of demandas) {
    const k = `${d.turma_id}|${d.disciplina_id}|${d.professor_id}`;
    countKey.set(k, d.aulas_semanais);
  }

  return lessons
    .map((l, idx) => ({ ...l, __idx: idx, __peso: countKey.get(`${l.turma_id}|${l.disciplina_id}|${l.professor_id}`) || 0 }))
    .sort((a, b) => {
      // maior peso primeiro
      if (b.__peso !== a.__peso) return b.__peso - a.__peso;
      // depois, determinístico
      if (a.turma_id !== b.turma_id) return a.turma_id - b.turma_id;
      if (a.disciplina_id !== b.disciplina_id) return a.disciplina_id - b.disciplina_id;
      if (a.professor_id !== b.professor_id) return a.professor_id - b.professor_id;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.__idx - b.__idx;
    })
    .map(({ __idx, __peso, ...rest }) => rest);
}

// --------------------------------------------------------------------------------------
// Solver principal
// --------------------------------------------------------------------------------------

/**
 * runGreedySolver(payload)
 * @param {object} payload
 * @returns {{
 *   ok: boolean,
 *   traceId: any,
 *   payload_summary: object,
 *   grade_por_turma: object,
 *   grade_por_professor: object,
 *   metrics: object
 * }}
 */
export function runGreedySolver(payload) {
  const daysCount = 5;

  // periodos_por_dia pode vir no payload; default 6 (fundamental II matutino)
  const periodosPorDia = clamp(toInt(payload?.periodos_por_dia, 6), 1, 10);

  const configPedagogica = payload?.config_pedagogica || payload?.configPedagogica || null;

  const rc01MaxConsecutivas = readRc01MaxConsecutivas(configPedagogica);
  const rc02Cfg = readRc02Config(configPedagogica);

  const turmaIds = normalizeTurmaIds(payload);
  const demandasNorm = normalizeDemandas(payload);
  const lessons = expandDemandasToLessons(demandasNorm);

  const professoresIds = uniq(lessons.map((l) => l.professor_id));

  // Grades sempre completas por turma/professor (mesmo que vazias, mas com keys ao alocar)
  const gradePorTurma = initGradePorTurma(turmaIds, daysCount, periodosPorDia);
  const gradePorProfessor = initGradePorProfessor(professoresIds, daysCount, periodosPorDia);

  // Index de disponibilidade (se não houver, assume livre)
  const dispoIdx = buildDisponibilidadeIndex(payload?.disponibilidades, daysCount, periodosPorDia);

  // Alocação
  let alocadas = 0;

  // ------------------------------------------------------------------------------------
  // Diagnóstico (PASSO 2.1)
  // ------------------------------------------------------------------------------------
  // Objetivo: identificar quais aulas não foram alocadas e o motivo provável, para permitir
  // ajustes finos (repair / repriorização) sem regressão do padrão já estabilizado.
  const diagnosticoNaoAlocadas = [];
  const diagnosticoContadores = {
    SEM_SLOT_LIVRE_TURMA: 0,
    COLISAO_PROFESSOR: 0,
    SEM_DISPONIBILIDADE_PROFESSOR: 0,
    OUTRO: 0,
  };

  function diagInc(motivo) {
    const k = motivo && diagnosticoContadores[motivo] !== undefined ? motivo : "OUTRO";
    diagnosticoContadores[k] = (diagnosticoContadores[k] || 0) + 1;
  }

  function inferirMotivoNaoAlocacao({ turmaGrade, profGrade, professorId }) {
    // Como o RC01/RC02 entram como penalidade no score (não como filtro),
    // a não alocação ocorre tipicamente por:
    // - turma sem slot livre
    // - colisão total do professor
    // - indisponibilidade total do professor (quando há agenda/grade de disponibilidade)
    let anyTurmaLivre = false;
    let anyTurmaProfLivre = false;
    let anyTurmaProfLivreEDisponivel = false;

    for (let dia = 1; dia <= daysCount; dia++) {
      for (let periodo = 1; periodo <= periodosPorDia; periodo++) {
        const turmaOcupado = !!turmaGrade?.[dia]?.[periodo];
        if (!turmaOcupado) {
          anyTurmaLivre = true;

          const profOcupado = !!profGrade?.[dia]?.[periodo];
          if (!profOcupado) {
            anyTurmaProfLivre = true;

            if (professorPode(dispoIdx, professorId, dia, periodo)) {
              anyTurmaProfLivreEDisponivel = true;
              break;
            }
          }
        }
      }
      if (anyTurmaProfLivreEDisponivel) break;
    }

    if (!anyTurmaLivre) return "SEM_SLOT_LIVRE_TURMA";
    if (!anyTurmaProfLivre) return "COLISAO_PROFESSOR";
    if (!anyTurmaProfLivreEDisponivel) return "SEM_DISPONIBILIDADE_PROFESSOR";
    return "OUTRO";
  }

  for (const lesson of lessons) {
    const turmaId = lesson.turma_id;
    const disciplinaId = lesson.disciplina_id;
    const professorId = lesson.professor_id;

    // Segurança: se a turma não existir na lista (payload inconsistente), inicializa on-the-fly
    if (!gradePorTurma[turmaId]) {
      gradePorTurma[turmaId] = initEmptyGridForEntity(daysCount, periodosPorDia);
    }
    if (!gradePorProfessor[professorId]) {
      gradePorProfessor[professorId] = initEmptyGridForEntity(daysCount, periodosPorDia);
    }

    const turmaGrade = gradePorTurma[turmaId];
    const profGrade = gradePorProfessor[professorId];

    let best = null;

    for (let dia = 1; dia <= daysCount; dia++) {
      for (let periodo = 1; periodo <= periodosPorDia; periodo++) {
        // (1) Slot livre na turma e no professor
        if (turmaGrade?.[dia]?.[periodo]) continue;
        if (profGrade?.[dia]?.[periodo]) continue;

        // (2) Disponibilidade
        if (!professorPode(dispoIdx, professorId, dia, periodo)) continue;

        // (3) Calcula score
        const score = computeSlotScore({
          turmaGrade,
          profGrade,
          dia,
          periodo,
          turmaId,
          professorId,
          disciplinaId,
          rc01MaxConsecutivas,
          rc02Cfg,
        });

        if (best === null || score < best.score) {
          best = { dia, periodo, score };
        }
      }
    }

    if (best) {
      const cellTurma = { disciplina_id: disciplinaId, professor_id: professorId };
      const cellProf = { turma_id: turmaId, disciplina_id: disciplinaId };

      // Garantia de estrutura (evita undefined)
      ensurePath(gradePorTurma, turmaId, best.dia);
      ensurePath(gradePorProfessor, professorId, best.dia);

      gradePorTurma[turmaId][best.dia][best.periodo] = cellTurma;
      gradePorProfessor[professorId][best.dia][best.periodo] = cellProf;

      alocadas++;
    } else {
      // Registra diagnóstico da aula não alocada (PASSO 2.1)
      const motivo = inferirMotivoNaoAlocacao({
        turmaGrade,
        profGrade,
        professorId,
      });

      diagnosticoNaoAlocadas.push({
        turma_id: turmaId,
        disciplina_id: disciplinaId,
        professor_id: professorId,
        motivo,
      });
      diagInc(motivo);
    }
  }

  const demandaTotal = lessons.length;

  // Cobertura robusta: evita 10000% etc.
  const cobertura =
    demandaTotal > 0 ? Math.round((alocadas / demandaTotal) * 100) : 100;

  // payload_summary coerente (não depender do frontend)
  const payloadSummary = {
    escola_id: payload?.escola_id ?? payload?.escolaId ?? null,
    turno: payload?.turno ?? null,
    ano_ref: payload?.ano_ref ?? null,
    nivel: payload?.nivel ?? payload?.config_pedagogica?.nivel ?? null,
    turmas: turmaIds.length,
    demanda: demandaTotal,
    professores: professoresIds.length,
  };

  return {
    ok: true,
    traceId: null,
    payload_summary: payloadSummary,
    grade_por_turma: gradePorTurma,
    grade_por_professor: gradePorProfessor,
    diagnostico: {
      nao_alocadas: diagnosticoNaoAlocadas,
      contadores: diagnosticoContadores,
    },
    metrics: {
      aulas_alocadas: alocadas,
      aulas_demanda: demandaTotal,
      cobertura,
      rc01_max_consecutivas: rc01MaxConsecutivas,
      rc02: {
        modo: rc02Cfg.modo,
        max_por_dia_padrao: rc02Cfg.maxPadrao,
        bloqueio_hard: rc02Cfg.bloqueioHard,
        strict_cap_mock: rc02Cfg.strictCapMock,
      },
      periodos_por_dia: periodosPorDia,
    },
  };
}

// --------------------------------------------------------------------------------------
// Default export (compatibilidade caso alguém importe sem destructuring)
// --------------------------------------------------------------------------------------
export default { runGreedySolver };
