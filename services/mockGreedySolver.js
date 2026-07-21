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
  regrasGerais,
  turno,
  preferenciasProfessor,
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
  if (consec >= rc01MaxConsecutivas) {
    // Penalidade EXTREMA; bloqueia a 3ª aula consecutiva.
    score += 100000;
  }

  // (C.2) Preferências e Aulas Germinadas (Duplas)
  const leftSame = periodo > 1 && turmaGrade?.[dia]?.[periodo - 1]?.disciplina_id === disciplinaId;
  const rightSame = turmaGrade?.[dia]?.[periodo + 1]?.disciplina_id === disciplinaId;

  if (preferenciasProfessor?.prefere_aula_unica) {
    // Se ele prefere aula única, tentamos evitar colocar na mesma disciplina logo após ou antes.
    if (leftSame || rightSame) {
      score += 2000; // Penalidade forte, tenta espalhar ao invés de grudar
    }
  } else {
    // POR PADRÃO, AULAS SÃO GERMINADAS (DUPLAS)!
    // O algoritmo deve dar um bônus imenso se estiver colocando encostado em outra aula da mesma matéria.
    // Assim as peças se atraem magneticamente e formam pares.
    if (leftSame || rightSame) {
      if (consec < rc01MaxConsecutivas) {
        score -= 2500; // Bônus magnético para colar as aulas!
      }
    } else {
      // Se a aula está sendo alocada isolada (sem encostar), aplicamos uma leve penalidade.
      // O solver vai preferir o slot que dá os -2500.
      score += 500;
    }
  }

  // (D) RC02: por dia
  const maxDia = getRc02MaxForDisc(rc02Cfg, disciplinaId);
  const inDay = countDiscInDay(turmaGrade, dia, disciplinaId);

  // Se já atingiu o teto e for estrito, torna inviável
  const strictCap = !!rc02Cfg?.strictCapMock;

  if (inDay >= maxDia) {
    if (strictCap || rc02Cfg.modo === "hard" || (rc02Cfg.bloqueioHard && maxDia === rc02Cfg.maxHardPadrao)) {
      // inviabiliza na prática
      score += 100000;
    } else {
      // modo soft: alterado para ser muito mais rigoroso!
      // URÂNIA dificilmente perdoa uma 3ª aula no dia. Então mesmo no soft, custará muito caro.
      score += 20000 + (inDay - maxDia + 1) * 5000;
    }
  }

  // (E) evita sobrecarga de professor no mesmo dia cedo demais (leve)
  //     Se professor já tem aula no mesmo dia, prefere agrupar (reduz score) para reduzir janelas.
  let profDayCount = 0;
  let hasEarlyClasses = false;
  let hasLateClasses = false;
  const profRow = profGrade?.[dia] || {};
  for (const p of Object.keys(profRow)) {
    if (profRow[p]) {
      profDayCount++;
      if (Number(p) < periodo) hasEarlyClasses = true;
      if (Number(p) > periodo) hasLateClasses = true;
    }
  }
  if (profDayCount > 0) score -= 0.3;

  // (E.2) Preferência: Evitar janela interna (evitar_janela_interna)
  // Se o professor já tem aula ANTES deste período, mas NÃO imediatamente antes, 
  // OU tem aula DEPOIS, mas NÃO imediatamente depois, estamos possivelmente criando (ou preenchendo) uma janela.
  // Uma forma mais segura de evitar janelas: preferir slots adjacentes ao bloco já existente dele.
  if (preferenciasProfessor?.evitar_janela_interna) {
    const profLeftOcc = periodo > 1 && !!profGrade?.[dia]?.[periodo - 1];
    const profRightOcc = !!profGrade?.[dia]?.[periodo + 1];
    
    // Se ele já dá aula no dia, mas o novo slot não encosta em nenhuma aula existente, é janela.
    if (profDayCount > 0 && !profLeftOcc && !profRightOcc) {
      // Slot está flutuando longe das aulas já alocadas neste dia!
      // Se há aulas antes e depois, ele está PREENCHENDO uma janela (isso é MUITO BOM).
      if (hasEarlyClasses && hasLateClasses) {
        score -= 5000; // Forte bônus: tapa-buraco!
      } else {
        score += 3000; // Forte penalidade: está criando uma nova ilha separada.
      }
    } else if (profDayCount > 0 && (profLeftOcc || profRightOcc)) {
      // Está grudado no bloco, o que é ótimo!
      score -= 500;
    }
  }

  // (F) desempate estável por dia: preferir segunda/terça (estabiliza)
  score += dia * 0.05;

  if (regrasGerais) {
    // (G) Recreio separando aula dupla
    // Se a aula anterior (periodo - 1) é a mesma disciplina, essa é uma aula dupla.
    // Vamos checar se cruzou o recreio.
    if (!regrasGerais.aulas_duplas_separar_recreio) {
      const rcApos = regrasGerais.recreio_apos_periodo || {};
      const rcAtual = rcApos[turno] || rcApos.matutino || 3;
      
      // Se o período atual (segunda aula) é (rcAtual + 1) E a aula anterior era mesma disciplina, cruzou o recreio.
      if (periodo === rcAtual + 1) {
        const discAnterior = turmaGrade?.[dia]?.[periodo - 1]?.disciplina_id;
        if (discAnterior == disciplinaId) {
          score += 100000; // BLOQUEIO!
        }
      }
    }

    // (H) Disciplinas Excludentes no mesmo dia (ex: Mat e Geo)
    if (regrasGerais.disciplinas_excludentes?.length > 0) {
      const todayClasses = Object.values(turmaGrade?.[dia] || {}).map(c => String(c?.disciplina_id));
      for (const par of regrasGerais.disciplinas_excludentes) {
        if (String(disciplinaId) === String(par[0]) && todayClasses.includes(String(par[1]))) {
          score += 50000; // Forte penalidade para evitar mistura no dia
        }
        if (String(disciplinaId) === String(par[1]) && todayClasses.includes(String(par[0]))) {
          score += 50000;
        }
      }
    }
  }

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

function expandDemandasToLessons(demandas, randomize = false, strategy = "default") {
  const lessons = [];
  for (const d of demandas) {
    for (let i = 0; i < d.aulas_semanais; i++) {
      lessons.push({
        turma_id: d.turma_id,
        disciplina_id: d.disciplina_id,
        professor_id: d.professor_id,
        seq: i + 1,
        // Random jitter to break ties Se randomize is true
        __jitter: randomize ? Math.random() : 0,
        // Jitter forte para estratégia "random"
        __strongJitter: Math.random(),
      });
    }
  }

  // Pre-computa pesos e cargas globais
  const countKey = new Map();
  const profTotalLoad = new Map();
  // Jitter por grupo (prof+turma) para que toda a turma de um prof seja shuffled junto
  const groupJitter = new Map();
  for (const d of demandas) {
    const k = `${d.turma_id}|${d.disciplina_id}|${d.professor_id}`;
    const gk = `${d.professor_id}|${d.turma_id}`;
    countKey.set(k, d.aulas_semanais);
    profTotalLoad.set(d.professor_id, (profTotalLoad.get(d.professor_id) || 0) + d.aulas_semanais);
    if (!groupJitter.has(gk)) groupJitter.set(gk, Math.random());
  }

  return lessons
    .map((l, idx) => ({ 
      ...l, 
      __idx: idx, 
      __peso: countKey.get(`${l.turma_id}|${l.disciplina_id}|${l.professor_id}`) || 0,
      __profLoad: profTotalLoad.get(l.professor_id) || 0,
      __groupJitter: groupJitter.get(`${l.professor_id}|${l.turma_id}`) || 0,
    }))
    .sort((a, b) => {
      if (strategy === "random") {
        return a.__strongJitter - b.__strongJitter;
      }

      if (strategy === "group_turma") {
        // Agrupa por professor (mais carregado primeiro) e dentro do prof, embaralha GRUPOS de turma
        // assim todas as aulas de (prof+turma) ficam juntas - ideal para germinação
        if (b.__profLoad !== a.__profLoad) return b.__profLoad - a.__profLoad;
        // Dentro do mesmo prof: shuffle por grupo (prof+turma), cada iteração tem ordem diferente
        const gA = `${a.professor_id}|${a.turma_id}`;
        const gB = `${b.professor_id}|${b.turma_id}`;
        if (gA !== gB) return a.__groupJitter - b.__groupJitter;
        // Dentro do grupo: menor carga primeiro (mais difíceis de encaixar)
        if (a.__peso !== b.__peso) return a.__peso - b.__peso;
        return a.seq - b.seq;
      }

      if (strategy === "reverse_weight") {
        // Menor peso primeiro (turmas com 1 aula, ex: Artes, Prática)
        if (a.__peso !== b.__peso) return a.__peso - b.__peso;
      } else if (strategy === "weight_desc") {
        // Maior peso primeiro, sem considerar carga do professor
        if (b.__peso !== a.__peso) return b.__peso - a.__peso;
      } else {
        // default: "scarce_first" (prof_load_desc)
        // Professor mais sobrecarregado primeiro (ex: 30/30)
        if (b.__profLoad !== a.__profLoad) return b.__profLoad - a.__profLoad;
        // DENTRO DO MESMO PROFESSOR: menor carga (mais difíceis = menos opções) vêm primeiro.
        // Ex: ARTES (2) antes de MATEMÁTICA (5), pois ARTES tem menos slots disponíveis.
        if (a.__peso !== b.__peso) return a.__peso - b.__peso;
      }
      
      // Empates
      if (randomize) {
         if (a.__jitter !== b.__jitter) return a.__jitter - b.__jitter;
      }
      
      // depois, determinístico
      if (a.turma_id !== b.turma_id) return a.turma_id - b.turma_id;
      if (a.disciplina_id !== b.disciplina_id) return a.disciplina_id - b.disciplina_id;
      if (a.professor_id !== b.professor_id) return a.professor_id - b.professor_id;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.__idx - b.__idx;
    })
    .map(({ __idx, __peso, __profLoad, __jitter, __strongJitter, __groupJitter, ...rest }) => rest);
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
export function runGreedySolver(payload, randomize = false, strategy = "default") {
  const daysCount = 5;

  // periodos_por_dia pode vir no payload; default 6 (fundamental II matutino)
  const periodosPorDia = clamp(toInt(payload?.periodos_por_dia, 6), 1, 10);

  const configPedagogica = payload?.config_pedagogica || payload?.configPedagogica || null;

  const rc01MaxConsecutivas = readRc01MaxConsecutivas(configPedagogica);
  const rc02Cfg = readRc02Config(configPedagogica);
  const regrasGerais = configPedagogica?.regras_gerais || null;
  const turno = payload?.turno || "matutino";

  const turmaIds = normalizeTurmaIds(payload);
  const demandasNorm = normalizeDemandas(payload);
  const lessons = expandDemandasToLessons(demandasNorm, randomize, strategy);

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
          regrasGerais,
          turno,
          preferenciasProfessor: payload?.preferencias?.[professorId] || {},
        });

        if (best === null || score < best.score) {
          best = { dia, periodo, score };
        }
      }
    }

    if (best) {
      // Salva o professor_id original na turma para persistência correta!
      const cellTurma = { disciplina_id: disciplinaId, professor_id: professorId };
      const cellProf = { turma_id: turmaId, disciplina_id: disciplinaId };

      // Garantia de estrutura (evita undefined)
      ensurePath(gradePorTurma, turmaId, best.dia);
      ensurePath(gradePorProfessor, professorId, best.dia);

      gradePorTurma[turmaId][best.dia][best.periodo] = cellTurma;
      gradePorProfessor[professorId][best.dia][best.periodo] = cellProf;

      alocadas++;
    } else {
      // ─────────────────────────────────────────────────────────────
      // PASSO DE REPAIR / SWAP LOCAL (Backtracking raso)
      // ─────────────────────────────────────────────────────────────
      let swapped = trySingleSwap(
        gradePorTurma, gradePorProfessor, dispoIdx, 
        turmaId, professorId, disciplinaId, 
        daysCount, periodosPorDia
      );

      if (!swapped) {
        swapped = tryDoubleSwap(
          gradePorTurma, gradePorProfessor, dispoIdx, 
          turmaId, professorId, disciplinaId, 
          daysCount, periodosPorDia
        );
      }

      if (!swapped) {
        swapped = tryTripleSwap(
          gradePorTurma, gradePorProfessor, dispoIdx,
          turmaId, professorId, disciplinaId,
          daysCount, periodosPorDia
        );
      }

      if (swapped) {
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
  }

  const demandaTotal = lessons.length;

  // Cobertura robusta: evita 10000% e arredondamentos enganosos para 100%
  let cobertura = 100;
  if (demandaTotal > 0) {
    cobertura = (alocadas / demandaTotal) * 100;
    cobertura = alocadas < demandaTotal ? Math.floor(cobertura) : 100;
  }

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
// Triple Swap: busca em cadeia de 3 níveis para resolver deadlocks complexos
// --------------------------------------------------------------------------------------

/**
 * tryTripleSwap: quando professores estão 100% lotados, single e double swap não bastam.
 * Esta função tenta uma cadeia de 3 movimentos:
 *   Queremos colocar ProfA em (Turma T, slot d/p).
 *   Turma T está ocupada por ProfB em d/p.
 *   ProfB quer ir para (Turma T, d2/p2), mas ProfC está lá.
 *   ProfC quer ir para (Turma T, d3/p3), mas ProfD está lá.
 *   ProfD pode ir para (Turma T, d4/p4) que está livre.
 *   → Rotação: ProfD→d4/p4, ProfC→d3/p3, ProfB→d2/p2, ProfA→d/p.
 */
function tryTripleSwap(
  gradePorTurma, gradePorProfessor, dispoIdx,
  turmaId, professorId, disciplinaId,
  daysCount, periodosPorDia
) {
  const turmaGrade = gradePorTurma[turmaId] || {};
  const profGrade  = gradePorProfessor[professorId] || {};

  for (let d = 1; d <= daysCount; d++) {
    for (let p = 1; p <= periodosPorDia; p++) {
      // ProfA (professorId) está livre no slot d/p
      if (profGrade?.[d]?.[p]) continue;
      if (!professorPode(dispoIdx, professorId, d, p)) continue;

      const cellB = turmaGrade?.[d]?.[p];
      if (!cellB) continue; // turma também livre → double swap já teria resolvido
      const profB = cellB.professor_id;
      const discB = cellB.disciplina_id;

      // Procura d2/p2 onde ProfB está livre mas turma está ocupada por ProfC
      for (let d2 = 1; d2 <= daysCount; d2++) {
        for (let p2 = 1; p2 <= periodosPorDia; p2++) {
          if (d2 === d && p2 === p) continue;
          if (gradePorProfessor[profB]?.[d2]?.[p2]) continue;
          if (!professorPode(dispoIdx, profB, d2, p2)) continue;

          const cellC = gradePorTurma[turmaId]?.[d2]?.[p2];
          if (!cellC) continue; // livre → double swap teria resolvido
          const profC = cellC.professor_id;
          const discC = cellC.disciplina_id;

          // Procura d3/p3 onde ProfC está livre mas turma está ocupada por ProfD
          for (let d3 = 1; d3 <= daysCount; d3++) {
            for (let p3 = 1; p3 <= periodosPorDia; p3++) {
              if (d3 === d && p3 === p) continue;
              if (d3 === d2 && p3 === p2) continue;
              if (gradePorProfessor[profC]?.[d3]?.[p3]) continue;
              if (!professorPode(dispoIdx, profC, d3, p3)) continue;

              const cellD = gradePorTurma[turmaId]?.[d3]?.[p3];
              if (!cellD) continue; // livre → double swap teria resolvido
              const profD = cellD.professor_id;
              const discD = cellD.disciplina_id;

              // Procura d4/p4 onde ProfD está livre E turma também está livre
              for (let d4 = 1; d4 <= daysCount; d4++) {
                for (let p4 = 1; p4 <= periodosPorDia; p4++) {
                  if (d4 === d && p4 === p) continue;
                  if (d4 === d2 && p4 === p2) continue;
                  if (d4 === d3 && p4 === p3) continue;
                  if (gradePorTurma[turmaId]?.[d4]?.[p4]) continue;
                  if (gradePorProfessor[profD]?.[d4]?.[p4]) continue;
                  if (!professorPode(dispoIdx, profD, d4, p4)) continue;

                  // ✅ Rotação tripla encontrada!
                  // 1. Move ProfD: d3/p3 → d4/p4
                  clearSlot(gradePorTurma, gradePorProfessor, turmaId, profD, d3, p3);
                  setSlot(gradePorTurma, gradePorProfessor, turmaId, profD, d4, p4, discD);

                  // 2. Move ProfC: d2/p2 → d3/p3
                  clearSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2);
                  setSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d3, p3, discC);

                  // 3. Move ProfB: d/p → d2/p2
                  clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d, p);
                  setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2, discB);

                  // 4. Coloca ProfA em d/p
                  setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, d, p, disciplinaId);

                  return true;
                }
              }
            }
          }
        }
      }
    }
  }

  return false;
}

// --------------------------------------------------------------------------------------
// Default export (compatibilidade caso alguém importe sem destructuring)
// --------------------------------------------------------------------------------------
export default { runGreedySolver };
function inferirMotivoNaoAlocacao({ turmaGrade, profGrade, professorId, periodosPorDia, daysCount }) {
  let isProfLotado = true;
  let isTurmaLotada = true;
  
  if (profGrade) {
    for(let d=1; d<= (daysCount || 5); d++){
      for(let p=1; p<= (periodosPorDia || 6); p++){
        if (!profGrade[d]?.[p]) isProfLotado = false;
      }
    }
  }
  
  if (turmaGrade) {
    for(let d=1; d<= (daysCount || 5); d++){
      for(let p=1; p<= (periodosPorDia || 6); p++){
        if (!turmaGrade[d]?.[p]) isTurmaLotada = false;
      }
    }
  }

  if (isProfLotado) return "COLISAO_PROFESSOR";
  if (isTurmaLotada) return "TURMA_SEM_HORARIO";
  return "SEM_SLOT_LIVRE_TURMA"; // A intersecção é vazia
}
function clearSlot(gradePorTurma, gradePorProfessor, turmaId, profId, d, p) {
  if (gradePorTurma[turmaId]?.[d]) gradePorTurma[turmaId][d][p] = null;
  if (gradePorProfessor[profId]?.[d]) gradePorProfessor[profId][d][p] = null;
}

function setSlot(gradePorTurma, gradePorProfessor, turmaId, profId, d, p, discId, originalProfId = profId) {
  ensurePath(gradePorTurma, turmaId, d);
  ensurePath(gradePorProfessor, profId, d);
  gradePorTurma[turmaId][d][p] = { disciplina_id: discId, professor_id: originalProfId };
  gradePorProfessor[profId][d][p] = { turma_id: turmaId, disciplina_id: discId };
}

function trySingleSwap(
  gradePorTurma, gradePorProfessor, dispoIdx, 
  turmaId, professorId, disciplinaId, 
  daysCount, periodosPorDia
) {
  const turmaGrade = gradePorTurma[turmaId] || {};
  const profGrade = gradePorProfessor[professorId] || {};

  // Caso 1: Turma A Livre, Professor A está ocupado numa Turma B nesse slot.
  // Solucao: move a aula de Turma B para outro slot livre, liberando o slot para a nova aula.
  for (let d = 1; d <= daysCount; d++) {
    for (let p = 1; p <= periodosPorDia; p++) {
      if (!turmaGrade?.[d]?.[p]) {
        const cellProf = profGrade?.[d]?.[p];
        if (cellProf) {
          const turmaB = cellProf.turma_id;
          const discB = cellProf.disciplina_id;
          // O professor que está REALMENTE no slot é o professorId (pois está em profGrade)
          const profBId = professorId; // é o mesmo professor que tem esta aula em TurmaB
          
          for (let d2 = 1; d2 <= daysCount; d2++) {
            for (let p2 = 1; p2 <= periodosPorDia; p2++) {
              if (d2 === d && p2 === p) continue;
              // Slot d2,p2 deve estar livre PARA TURMA B e PARA o professor
              if (!gradePorTurma[turmaB]?.[d2]?.[p2] && 
                  !gradePorProfessor[profBId]?.[d2]?.[p2] &&
                  professorPode(dispoIdx, profBId, d2, p2)) {
                
                // Mover a aula de TurmaB do slot (d,p) para (d2,p2)
                clearSlot(gradePorTurma, gradePorProfessor, turmaB, profBId, d, p);
                setSlot(gradePorTurma, gradePorProfessor, turmaB, profBId, d2, p2, discB);
                
                // Agora (d,p) está livre para o professor A: colocar nova aula de TurmaA
                setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, d, p, disciplinaId);
                
                return true;
              }
            }
          }
        }
      }
    }
  }

  // Caso 2: Turma A Ocupada com Prof B, Professor A está livre nesse slot.
  // Solucao: move a aula de ProfB para outro slot livre, liberando o slot para a nova aula.
  for (let d = 1; d <= daysCount; d++) {
    for (let p = 1; p <= periodosPorDia; p++) {
      if (!profGrade?.[d]?.[p] && professorPode(dispoIdx, professorId, d, p)) {
        const cellTurma = turmaGrade?.[d]?.[p];
        if (cellTurma) {
          const profB = cellTurma.professor_id;
          const discB = cellTurma.disciplina_id;
          
          for (let d2 = 1; d2 <= daysCount; d2++) {
            for (let p2 = 1; p2 <= periodosPorDia; p2++) {
              if (d2 === d && p2 === p) continue;
              // Slot d2,p2 deve estar livre PARA TURMA A e PARA profB
              if (!gradePorTurma[turmaId]?.[d2]?.[p2] && 
                  !gradePorProfessor[profB]?.[d2]?.[p2] &&
                  professorPode(dispoIdx, profB, d2, p2)) {
                
                // Mover a aula de ProfB do slot (d,p) para (d2,p2)
                clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d, p);
                setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2, discB);
                
                // Agora (d,p) está livre: colocar nova aula
                setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, d, p, disciplinaId);
                
                return true;
              }
            }
          }
        }
      }
    }
  }

  return false;
}

function tryDoubleSwap(
  gradePorTurma, gradePorProfessor, dispoIdx, 
  turmaId, professorId, disciplinaId, 
  daysCount, periodosPorDia
) {
  const turmaGrade = gradePorTurma[turmaId] || {};
  const profGrade = gradePorProfessor[professorId] || {};

  // Turma ocupada com Prof B e Professor A livre (SEM_SLOT_LIVRE_TURMA)
  // Tentativa: mover ProfC de d2,p2 para d3,p3, liberando d2,p2 para ProfB,
  // que libera d,p para o ProfessorA.
  for (let d = 1; d <= daysCount; d++) {
    for (let p = 1; p <= periodosPorDia; p++) {
      if (!profGrade?.[d]?.[p] && professorPode(dispoIdx, professorId, d, p)) {
        const cellTurma = turmaGrade?.[d]?.[p];
        if (cellTurma) {
          const profB = cellTurma.professor_id;
          const discB = cellTurma.disciplina_id;
          
          for (let d2 = 1; d2 <= daysCount; d2++) {
            for (let p2 = 1; p2 <= periodosPorDia; p2++) {
              if (d === d2 && p === p2) continue;
              
              // profB está livre em d2,p2
              if (!gradePorProfessor[profB]?.[d2]?.[p2] && professorPode(dispoIdx, profB, d2, p2)) {
                const cellTurma2 = gradePorTurma[turmaId]?.[d2]?.[p2];
                // A turma está ocupada por profC em d2,p2
                if (cellTurma2) {
                  const profC = cellTurma2.professor_id;
                  const discC = cellTurma2.disciplina_id;
                  
                  // Tentar mover profC de d2,p2 para d3,p3
                  for (let d3 = 1; d3 <= daysCount; d3++) {
                    for (let p3 = 1; p3 <= periodosPorDia; p3++) {
                      if (d3 === d && p3 === p) continue;
                      if (d3 === d2 && p3 === p2) continue;
                      
                      // d3,p3 deve estar livre tanto para a turma quanto para profC
                      if (!gradePorTurma[turmaId]?.[d3]?.[p3] && 
                          !gradePorProfessor[profC]?.[d3]?.[p3] &&
                          professorPode(dispoIdx, profC, d3, p3)) {
                        
                        // 1. Move profC de d2,p2 para d3,p3
                        clearSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2);
                        setSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d3, p3, discC);
                        
                        // 2. Move profB de d,p para d2,p2
                        clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d, p);
                        setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2, discB);
                        
                        // 3. Coloca professorId em d,p
                        setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, d, p, disciplinaId);
                        
                        return true;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return false;
}
