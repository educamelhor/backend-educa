/**
 * EDUCA.MELHOR — Motor Solver 2.0 (Urânia-Engine)
 * --------------------------------------------------------------------------------------
 * Arquitetura Híbrida de Alta Performance para Geração de Horários Escolares:
 * 1. Pré-alocação inviolável de horários fixos (Aba ✍️ Horário Manual / locked=1).
 * 2. Índice real de Disponibilidades (bloqueio hard para 'indisponivel'/'excluir' e
 *    penalidade soft para 'evitar').
 * 3. Ordenação Dinâmica por Folga Efetiva (DSATUR / Slack-First): professores com
 *    menor folga (slots_livres - aulas_demanda) têm prioridade máxima.
 * 4. Operadores de Reparo Local e Multi-Turma:
 *    - Single Swap, Double Swap, Triple Swap (intra-turma)
 *    - Cross-Turma Kempe / Augmenting Chain (move aulas entre múltiplas turmas e professores)
 * 5. Fase de Busca Tabu com Ejeção Guiada (Tabu Ejection Repair):
 *    - Quando restam poucas aulas não alocadas (95%–99%), desaloja cirurgicamente
 *      aulas bloqueadoras com lista Tabu até atingir 100% de cobertura.
 * 6. Polimento Pedagógico Pós-Alocação (formação de aulas germinadas/duplas e redução de janelas).
 */

// --------------------------------------------------------------------------------------
// Helpers básicos
// --------------------------------------------------------------------------------------

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n, min, max) {
  const x = Number(vOrNum(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function vOrNum(n) {
  return n;
}

function safeObj(v) {
  return v && typeof v === "object" ? v : {};
}

function stableKey(v) {
  if (v === null || v === undefined) return "";
  return String(v);
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

function cloneGradeMap(gradeMap) {
  const out = {};
  for (const [entId, diasObj] of Object.entries(gradeMap || {})) {
    out[entId] = {};
    for (const [dKey, perObj] of Object.entries(diasObj || {})) {
      out[entId][dKey] = {};
      for (const [pKey, cell] of Object.entries(perObj || {})) {
        out[entId][dKey][pKey] = cell ? { ...cell } : null;
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------
// Leitura das regras RC01/RC02 (com defaults e compatibilidade)
// --------------------------------------------------------------------------------------

function readRc01MaxConsecutivas(configPedagogica) {
  const regras = safeObj(configPedagogica?.regras);
  const rc01 = safeObj(regras?.rc01_distribuicao_disciplina);
  const max = toInt(rc01?.max_consecutivas, 2);
  return clamp(max, 1, 6);
}

function readRc02Config(configPedagogica) {
  const regras = safeObj(configPedagogica?.regras);
  const rc02 =
    safeObj(regras?.rc02_max_por_dia_disciplina) ||
    safeObj(regras?.rc02_max_aulas_por_dia_disciplina) ||
    safeObj(regras?.rc02_distribuicao_por_dia) ||
    safeObj(regras?.rc02);

  const modoRaw = (rc02?.modo || "soft").toString().toLowerCase();
  const modo = ["hard", "soft"].includes(modoRaw) ? modoRaw : "soft";
  const maxPadrao = clamp(toInt(rc02?.max_por_dia_padrao, 2), 1, 6);
  const porDisciplina = safeObj(rc02?.por_disciplina);
  const strictCapMock = !!rc02?.strict_cap_mock;
  const bloqueioHard = rc02?.bloqueio_hard === undefined ? false : !!rc02?.bloqueio_hard;
  const maxHardPadrao = clamp(toInt(rc02?.max_por_dia_padrao_hard, maxPadrao), 1, 6);

  return {
    modo,
    maxPadrao,
    porDisciplina,
    bloqueioHard,
    maxHardPadrao,
    strictCapMock,
  };
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

function initEmptyGridForEntity(diasList, periodosPorDia) {
  const grid = {};
  for (const dia of diasList) {
    grid[dia] = {};
    for (let p = 1; p <= periodosPorDia; p++) {
      grid[dia][p] = null;
    }
  }
  return grid;
}

function initGradePorTurma(turmaIds, diasList, periodosPorDia) {
  const grade = {};
  for (const turmaId of turmaIds) {
    grade[turmaId] = initEmptyGridForEntity(diasList, periodosPorDia);
  }
  return grade;
}

function initGradePorProfessor(profIds, diasList, periodosPorDia) {
  const grade = {};
  for (const profId of profIds) {
    grade[profId] = initEmptyGridForEntity(diasList, periodosPorDia);
  }
  return grade;
}

function countConsecutiveSameDisc(gradeTurma, dia, periodo, disciplinaId, periodosPorDia = 6) {
  let left = 0;
  for (let p = periodo - 1; p >= 1; p--) {
    const cell = gradeTurma?.[dia]?.[p];
    if (!cell || cell.disciplina_id !== disciplinaId) break;
    left++;
  }
  let right = 0;
  for (let p = periodo + 1; p <= periodosPorDia; p++) {
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
// Índice Real de Disponibilidades do Professor
// Suporta tanto formato:
//  - [{ professor_id, dia, ordem/periodo, status: 'livre'|'evitar'|'indisponivel' }]
//  - quanto formato legado onde a presença na lista significava disponível
// --------------------------------------------------------------------------------------

function buildDisponibilidadeIndex(disponibilidades, diasList, periodosPorDia) {
  const indisponivelMap = new Map(); // profId -> Set("dia|periodo")
  const evitarMap = new Map();       // profId -> Set("dia|periodo")
  const explicitLivreMap = new Map();// profId -> Set("dia|periodo")
  const hasStatusField = Array.isArray(disponibilidades) && disponibilidades.some(d => d && d.status !== undefined);

  const diasSet = new Set(diasList);
  const list = Array.isArray(disponibilidades) ? disponibilidades : [];

  for (const d of list) {
    const profId = toInt(d?.professor_id, 0);
    const dia = toInt(d?.dia ?? d?.dia_semana, 0);
    const periodo = toInt(d?.ordem ?? d?.periodo ?? d?.aula ?? d?.periodo_ordem, 0);

    if (!profId || !diasSet.has(dia) || periodo < 1 || periodo > periodosPorDia) continue;

    const key = `${dia}|${periodo}`;
    if (hasStatusField) {
      const st = String(d?.status || "livre").toLowerCase().trim();
      if (st === "indisponivel" || st === "excluir" || st === "bloqueado") {
        if (!indisponivelMap.has(profId)) indisponivelMap.set(profId, new Set());
        indisponivelMap.get(profId).add(key);
      } else if (st === "evitar") {
        if (!evitarMap.has(profId)) evitarMap.set(profId, new Set());
        evitarMap.get(profId).add(key);
      } else {
        if (!explicitLivreMap.has(profId)) explicitLivreMap.set(profId, new Set());
        explicitLivreMap.get(profId).add(key);
      }
    } else {
      if (!explicitLivreMap.has(profId)) explicitLivreMap.set(profId, new Set());
      explicitLivreMap.get(profId).add(key);
    }
  }

  return {
    hasStatusField,
    indisponivelMap,
    evitarMap,
    explicitLivreMap,
  };
}

function professorPode(dispoIdx, professorId, dia, periodo) {
  if (!dispoIdx) return true;
  const pid = toInt(professorId, 0);
  const key = `${dia}|${periodo}`;

  if (dispoIdx.hasStatusField) {
    const indSet = dispoIdx.indisponivelMap.get(pid);
    if (indSet && indSet.has(key)) return false;
    return true;
  }

  const livreSet = dispoIdx.explicitLivreMap.get(pid);
  if (!livreSet) return true;
  return livreSet.has(key);
}

function professorEvita(dispoIdx, professorId, dia, periodo) {
  if (!dispoIdx || !dispoIdx.hasStatusField) return false;
  const pid = toInt(professorId, 0);
  const evSet = dispoIdx.evitarMap.get(pid);
  return !!(evSet && evSet.has(`${dia}|${periodo}`));
}

function countProfessorAvailableSlots(dispoIdx, professorId, diasList, periodosPorDia) {
  let count = 0;
  for (const d of diasList) {
    for (let p = 1; p <= periodosPorDia; p++) {
      if (professorPode(dispoIdx, professorId, d, p)) count++;
    }
  }
  return count;
}

// --------------------------------------------------------------------------------------
// Score de slot (menor é melhor)
// --------------------------------------------------------------------------------------

function computeSlotScore({
  turmaGrade,
  profGrade,
  dispoIdx,
  dia,
  periodo,
  periodosPorDia,
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

  // (A) Leve preferência por preencher primeiros horários
  score += periodo * 0.4;

  // (B) Evita buracos na turma
  const leftOcc = periodo > 1 && !!turmaGrade?.[dia]?.[periodo - 1];
  const rightOcc = periodo < periodosPorDia && !!turmaGrade?.[dia]?.[periodo + 1];
  if (leftOcc) score -= 0.7;
  if (rightOcc) score -= 0.4;

  // (B.2) Penaliza slot marcado como 'Evitar' na disponibilidade do professor
  if (professorEvita(dispoIdx, professorId, dia, periodo)) {
    score += 1800;
  }

  // (C) RC01: máximo de aulas consecutivas da mesma disciplina
  const consec = countConsecutiveSameDisc(turmaGrade, dia, periodo, disciplinaId, periodosPorDia);
  if (consec > rc01MaxConsecutivas) {
    score += 100000;
  }

  // (C.2) Preferências e Aulas Germinadas (Duplas)
  const leftSame = periodo > 1 && turmaGrade?.[dia]?.[periodo - 1]?.disciplina_id === disciplinaId;
  const rightSame = periodo < periodosPorDia && turmaGrade?.[dia]?.[periodo + 1]?.disciplina_id === disciplinaId;

  if (preferenciasProfessor?.prefere_aula_unica) {
    if (leftSame || rightSame) {
      score += 2000;
    }
  } else {
    // Bônus magnético para formar aulas duplas (germinadas)
    if (leftSame || rightSame) {
      if (consec <= rc01MaxConsecutivas) {
        score -= 2600;
      }
    } else {
      score += 450;
    }
  }

  // (D) RC02: máximo de aulas da mesma disciplina no mesmo dia na turma
  const maxDia = getRc02MaxForDisc(rc02Cfg, disciplinaId);
  const inDay = countDiscInDay(turmaGrade, dia, disciplinaId);
  const strictCap = !!rc02Cfg?.strictCapMock;

  if (inDay >= maxDia) {
    if (strictCap || rc02Cfg.modo === "hard" || (rc02Cfg.bloqueioHard && maxDia === rc02Cfg.maxHardPadrao)) {
      score += 100000;
    } else {
      score += 20000 + (inDay - maxDia + 1) * 5000;
    }
  }

  // (E) Compactação de janela do professor no dia
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

  if (preferenciasProfessor?.evitar_janela_interna) {
    const profLeftOcc = periodo > 1 && !!profGrade?.[dia]?.[periodo - 1];
    const profRightOcc = periodo < periodosPorDia && !!profGrade?.[dia]?.[periodo + 1];

    if (profDayCount > 0 && !profLeftOcc && !profRightOcc) {
      if (hasEarlyClasses && hasLateClasses) {
        score -= 5000; // Preenchendo janela existente
      } else {
        score += 3000; // Criando nova janela
      }
    } else if (profDayCount > 0 && (profLeftOcc || profRightOcc)) {
      score -= 500;
    }
  }

  score += dia * 0.04;

  if (regrasGerais) {
    // (G) Recreio separando aula dupla
    if (!regrasGerais.aulas_duplas_separar_recreio) {
      const rcApos = regrasGerais.recreio_apos_periodo || {};
      const rcAtual = rcApos[turno] || rcApos.matutino || 3;
      if (periodo === rcAtual + 1) {
        const discAnterior = turmaGrade?.[dia]?.[periodo - 1]?.disciplina_id;
        if (discAnterior == disciplinaId) {
          score += 100000;
        }
      }
      if (periodo === rcAtual) {
        const discPosterior = turmaGrade?.[dia]?.[periodo + 1]?.disciplina_id;
        if (discPosterior == disciplinaId) {
          score += 100000;
        }
      }
    }

    // (H) Disciplinas Excludentes no mesmo dia
    if (regrasGerais.disciplinas_excludentes?.length > 0) {
      const todayClasses = Object.values(turmaGrade?.[dia] || {})
        .filter(Boolean)
        .map(c => String(c?.disciplina_id));
      for (const par of regrasGerais.disciplinas_excludentes) {
        if (String(disciplinaId) === String(par[0]) && todayClasses.includes(String(par[1]))) {
          score += 50000;
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
// Normalização de Turmas e Demandas
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

  // Agrupa todos os professores modulados para cada (turma_id, disciplina_id)
  const modListMap = new Map();
  for (const m of mod) {
    const turmaId = toInt(m.turma_id ?? m.turmaId, 0);
    const discId = toInt(m.disciplina_id ?? m.disciplinaId, 0);
    const profId = toInt(m.professor_id ?? m.professorId, 0);
    const aulas = clamp(toInt(m.aulas_semanais ?? m.aulas ?? m.carga ?? 0, 0), 0, 60);
    if (turmaId > 0 && discId > 0 && profId > 0) {
      const k = `${turmaId}|${discId}`;
      if (!modListMap.has(k)) modListMap.set(k, []);
      const list = modListMap.get(k);
      if (!list.some((it) => it.professor_id === profId)) {
        list.push({ professor_id: profId, aulas });
      }
    }
  }

  if (dem.length) {
    const out = [];
    for (const x of dem) {
      const turma_id = toInt(x.turma_id ?? x.turmaId, 0);
      const disciplina_id = toInt(x.disciplina_id ?? x.disciplinaId, 0);
      const carga = clamp(
        toInt(x.aulas_semanais ?? x.aulasSemanais ?? x.qtd ?? x.carga ?? 0, 0),
        0,
        60
      );
      if (turma_id <= 0 || disciplina_id <= 0 || carga <= 0) continue;

      const explicitProf = toInt(x.professor_id ?? x.professorId, 0);
      if (explicitProf > 0) {
        out.push({ turma_id, disciplina_id, professor_id: explicitProf, aulas_semanais: carga, co_professores: [] });
        continue;
      }

      const mods = modListMap.get(`${turma_id}|${disciplina_id}`) || [];
      if (mods.length === 0) continue;

      if (mods.length === 1) {
        out.push({
          turma_id,
          disciplina_id,
          professor_id: mods[0].professor_id,
          aulas_semanais: carga,
          co_professores: [],
        });
      } else {
        // Múltiplos professores modulados na mesma (turma, disciplina)
        const sumAulas = mods.reduce((acc, m) => acc + (m.aulas || 0), 0);
        if (sumAulas > 0 && sumAulas <= carga) {
          // Caso 1: Divisão de Carga (ex.: 4 aulas na turma -> 2 prof A + 2 prof B)
          let allocated = 0;
          mods.forEach((m, idx) => {
            const qtd = idx === mods.length - 1 ? Math.max(0, carga - allocated) : Math.min(m.aulas || 1, carga - allocated);
            if (qtd > 0) {
              out.push({
                turma_id,
                disciplina_id,
                professor_id: m.professor_id,
                aulas_semanais: qtd,
                co_professores: [],
              });
              allocated += qtd;
            }
          });
        } else {
          // Caso 2: Docência Compartilhada / Agrupamento / IFA / PD Simultâneo no mesmo horário da turma
          const primaryProf = mods[0].professor_id;
          const coProfs = mods.slice(1).map((m) => m.professor_id);
          out.push({
            turma_id,
            disciplina_id,
            professor_id: primaryProf,
            aulas_semanais: carga,
            co_professores: coProfs,
          });
        }
      }
    }
    return out;
  }

  return mod
    .map((x) => ({
      turma_id: toInt(x.turma_id ?? x.turmaId, 0),
      disciplina_id: toInt(x.disciplina_id ?? x.disciplinaId, 0),
      professor_id: toInt(x.professor_id ?? x.professorId, 0),
      aulas_semanais: clamp(
        toInt(x.aulas_semanais ?? x.aulasSemanais ?? x.qtd ?? x.carga ?? x.aulas ?? 0, 0),
        0,
        60
      ),
      co_professores: [],
    }))
    .filter(
      (x) =>
        x.turma_id > 0 &&
        x.disciplina_id > 0 &&
        x.professor_id > 0 &&
        x.aulas_semanais > 0
    );
}

function expandDemandasToLessons(
  demandas,
  randomize = false,
  strategy = "default",
  dispoIdx = null,
  diasList = [1, 2, 3, 4, 5],
  periodosPorDia = 6
) {
  const lessons = [];
  for (const d of demandas) {
    const qtd = toInt(d.aulas_restantes ?? d.aulas_semanais, 0);
    const coProfs = Array.isArray(d.co_professores) ? d.co_professores : [];
    for (let i = 0; i < qtd; i++) {
      lessons.push({
        turma_id: d.turma_id,
        disciplina_id: d.disciplina_id,
        professor_id: d.professor_id,
        co_professores: coProfs,
        seq: i + 1,
        __jitter: randomize ? Math.random() : 0,
        __strongJitter: Math.random(),
      });
    }
  }

  const countKey = new Map();
  const profTotalLoad = new Map();
  const groupJitter = new Map();
  for (const d of demandas) {
    const qtd = toInt(d.aulas_semanais, 0);
    const k = `${d.turma_id}|${d.disciplina_id}|${d.professor_id}`;
    const gk = `${d.professor_id}|${d.turma_id}`;
    countKey.set(k, qtd);
    profTotalLoad.set(d.professor_id, (profTotalLoad.get(d.professor_id) || 0) + qtd);
    for (const cp of d.co_professores || []) {
      profTotalLoad.set(cp, (profTotalLoad.get(cp) || 0) + qtd);
    }
    if (!groupJitter.has(gk)) groupJitter.set(gk, Math.random());
  }

  // Calcula Slack (folga real = slots disponíveis - carga total do professor)
  const profSlack = new Map();
  for (const [profId, load] of profTotalLoad.entries()) {
    const avail = dispoIdx
      ? countProfessorAvailableSlots(dispoIdx, profId, diasList, periodosPorDia)
      : diasList.length * periodosPorDia;
    profSlack.set(profId, avail - load);
  }

  return lessons
    .map((l, idx) => {
      const baseSlack = profSlack.get(l.professor_id) ?? 99;
      // Se for aula de agrupamento/co-docência, é mais restrita (desconta 8 da folga para alocar primeiro)
      const effectiveSlack =
        Array.isArray(l.co_professores) && l.co_professores.length > 0
          ? Math.min(baseSlack, ...l.co_professores.map((cp) => profSlack.get(cp) ?? 99)) - 8
          : baseSlack;
      return {
        ...l,
        __idx: idx,
        __peso: countKey.get(`${l.turma_id}|${l.disciplina_id}|${l.professor_id}`) || 0,
        __profLoad: profTotalLoad.get(l.professor_id) || 0,
        __profSlack: effectiveSlack,
        __groupJitter: groupJitter.get(`${l.professor_id}|${l.turma_id}`) || 0,
      };
    })
    .sort((a, b) => {
      if (strategy === "random") {
        return a.__strongJitter - b.__strongJitter;
      }

      if (strategy === "dsatur_slack") {
        // Prioriza professor com MENOR folga (ex: 0 de folga = 100% ocupado)
        if (a.__profSlack !== b.__profSlack) return a.__profSlack - b.__profSlack;
        if (b.__profLoad !== a.__profLoad) return b.__profLoad - a.__profLoad;
        const gA = `${a.professor_id}|${a.turma_id}`;
        const gB = `${b.professor_id}|${b.turma_id}`;
        if (gA !== gB && randomize) return a.__groupJitter - b.__groupJitter;
        if (b.__peso !== a.__peso) return b.__peso - a.__peso;
        return a.seq - b.seq;
      }

      if (strategy === "group_turma") {
        if (a.__profSlack !== b.__profSlack) return a.__profSlack - b.__profSlack;
        if (b.__profLoad !== a.__profLoad) return b.__profLoad - a.__profLoad;
        const gA = `${a.professor_id}|${a.turma_id}`;
        const gB = `${b.professor_id}|${b.turma_id}`;
        if (gA !== gB) return a.__groupJitter - b.__groupJitter;
        if (a.__peso !== b.__peso) return a.__peso - b.__peso;
        return a.seq - b.seq;
      }

      if (strategy === "reverse_weight") {
        if (a.__peso !== b.__peso) return a.__peso - b.__peso;
      } else if (strategy === "weight_desc") {
        if (b.__peso !== a.__peso) return b.__peso - a.__peso;
      } else {
        // default: "scarce_first" enriquecido com slack
        if (a.__profSlack !== b.__profSlack) return a.__profSlack - b.__profSlack;
        if (b.__profLoad !== a.__profLoad) return b.__profLoad - a.__profLoad;
        if (a.__peso !== b.__peso) return a.__peso - b.__peso;
      }

      if (randomize && a.__jitter !== b.__jitter) {
        return a.__jitter - b.__jitter;
      }

      if (a.turma_id !== b.turma_id) return a.turma_id - b.turma_id;
      if (a.disciplina_id !== b.disciplina_id) return a.disciplina_id - b.disciplina_id;
      if (a.professor_id !== b.professor_id) return a.professor_id - b.professor_id;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.__idx - b.__idx;
    })
    .map(({ __idx, __peso, __profLoad, __profSlack, __jitter, __strongJitter, __groupJitter, ...rest }) => rest);
}

// --------------------------------------------------------------------------------------
// Manipulação básica de células (respeitando células locked e co_professores)
// --------------------------------------------------------------------------------------

function isCellLocked(gradePorTurma, gradePorProfessor, turmaId, profId, d, p) {
  if (turmaId && gradePorTurma?.[turmaId]?.[d]?.[p]?.locked) return true;
  if (profId && gradePorProfessor?.[profId]?.[d]?.[p]?.locked) return true;
  return false;
}

function clearSlot(gradePorTurma, gradePorProfessor, turmaId, profId, d, p) {
  const cellT = gradePorTurma?.[turmaId]?.[d]?.[p];
  if (Array.isArray(cellT?.co_professores)) {
    for (const cp of cellT.co_professores) {
      if (gradePorProfessor[cp]?.[d]) gradePorProfessor[cp][d][p] = null;
    }
  }
  if (gradePorTurma[turmaId]?.[d]) gradePorTurma[turmaId][d][p] = null;
  if (gradePorProfessor[profId]?.[d]) gradePorProfessor[profId][d][p] = null;
}

function setSlot(gradePorTurma, gradePorProfessor, turmaId, profId, d, p, discId, locked = false, coProfessores = []) {
  ensurePath(gradePorTurma, turmaId, d);
  ensurePath(gradePorProfessor, profId, d);
  const cellT = { disciplina_id: discId, professor_id: profId };
  const cellP = { turma_id: turmaId, disciplina_id: discId };
  if (locked) {
    cellT.locked = true;
    cellP.locked = true;
  }
  if (Array.isArray(coProfessores) && coProfessores.length > 0) {
    cellT.co_professores = coProfessores;
    for (const cp of coProfessores) {
      ensurePath(gradePorProfessor, cp, d);
      gradePorProfessor[cp][d][p] = {
        turma_id: turmaId,
        disciplina_id: discId,
        co_docencia: true,
        ...(locked ? { locked: true } : {}),
      };
    }
  }
  gradePorTurma[turmaId][d][p] = cellT;
  gradePorProfessor[profId][d][p] = cellP;
}

// --------------------------------------------------------------------------------------
// Busca de melhor slot livre direto
// --------------------------------------------------------------------------------------

function findBestFreeSlot({
  gradePorTurma,
  gradePorProfessor,
  dispoIdx,
  diasList,
  periodosPorDia,
  turmaId,
  professorId,
  disciplinaId,
  coProfessores = [],
  rc01MaxConsecutivas,
  rc02Cfg,
  regrasGerais,
  turno,
  preferencias,
}) {
  const turmaGrade = gradePorTurma[turmaId];
  const profGrade = gradePorProfessor[professorId];
  let best = null;

  for (const dia of diasList) {
    for (let periodo = 1; periodo <= periodosPorDia; periodo++) {
      if (turmaGrade?.[dia]?.[periodo]) continue;
      if (profGrade?.[dia]?.[periodo]) continue;
      if (!professorPode(dispoIdx, professorId, dia, periodo)) continue;

      // Se houver co-professores (Agrupamento / IFA / PD simultâneo), todos devem estar livres e disponíveis
      if (Array.isArray(coProfessores) && coProfessores.length > 0) {
        let coOk = true;
        for (const cp of coProfessores) {
          if (gradePorProfessor?.[cp]?.[dia]?.[periodo] || !professorPode(dispoIdx, cp, dia, periodo)) {
            coOk = false;
            break;
          }
        }
        if (!coOk) continue;
      }

      const score = computeSlotScore({
        turmaGrade,
        profGrade,
        dispoIdx,
        dia,
        periodo,
        periodosPorDia,
        turmaId,
        professorId,
        disciplinaId,
        rc01MaxConsecutivas,
        rc02Cfg,
        regrasGerais,
        turno,
        preferenciasProfessor: preferencias?.[professorId] || {},
      });

      if (best === null || score < best.score) {
        best = { dia, periodo, score };
      }
    }
  }
  return best;
}

// --------------------------------------------------------------------------------------
// Operadores de Reparo: Single, Double, Triple + Cross-Turma Kempe Chain
// --------------------------------------------------------------------------------------

function trySingleSwap(
  gradePorTurma,
  gradePorProfessor,
  dispoIdx,
  turmaId,
  professorId,
  disciplinaId,
  diasList,
  periodosPorDia
) {
  const turmaGrade = gradePorTurma[turmaId] || {};
  const profGrade = gradePorProfessor[professorId] || {};

  // Caso 1: Turma A livre em (d,p), mas Professor A está ocupado em Turma B em (d,p).
  // Move aula de (Turma B, Prof A) de (d,p) para um slot livre (d2,p2) de Turma B e Prof A.
  for (const d of diasList) {
    for (let p = 1; p <= periodosPorDia; p++) {
      if (!turmaGrade?.[d]?.[p] && professorPode(dispoIdx, professorId, d, p)) {
        const cellProf = profGrade?.[d]?.[p];
        if (cellProf && !cellProf.locked) {
          const turmaB = cellProf.turma_id;
          const discB = cellProf.disciplina_id;

          for (const d2 of diasList) {
            for (let p2 = 1; p2 <= periodosPorDia; p2++) {
              if (d2 === d && p2 === p) continue;
              if (
                !gradePorTurma[turmaB]?.[d2]?.[p2] &&
                !gradePorProfessor[professorId]?.[d2]?.[p2] &&
                professorPode(dispoIdx, professorId, d2, p2)
              ) {
                clearSlot(gradePorTurma, gradePorProfessor, turmaB, professorId, d, p);
                setSlot(gradePorTurma, gradePorProfessor, turmaB, professorId, d2, p2, discB);
                setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, d, p, disciplinaId);
                return true;
              }
            }
          }
        }
      }
    }
  }

  // Caso 2: Professor A livre em (d,p), mas Turma A está ocupada por Prof B em (d,p).
  // Move aula de (Turma A, Prof B) de (d,p) para um slot livre (d2,p2) de Turma A e Prof B.
  for (const d of diasList) {
    for (let p = 1; p <= periodosPorDia; p++) {
      if (!profGrade?.[d]?.[p] && professorPode(dispoIdx, professorId, d, p)) {
        const cellTurma = turmaGrade?.[d]?.[p];
        if (cellTurma && !cellTurma.locked) {
          const profB = cellTurma.professor_id;
          const discB = cellTurma.disciplina_id;

          for (const d2 of diasList) {
            for (let p2 = 1; p2 <= periodosPorDia; p2++) {
              if (d2 === d && p2 === p) continue;
              if (
                !gradePorTurma[turmaId]?.[d2]?.[p2] &&
                !gradePorProfessor[profB]?.[d2]?.[p2] &&
                professorPode(dispoIdx, profB, d2, p2)
              ) {
                clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d, p);
                setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2, discB);
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
  gradePorTurma,
  gradePorProfessor,
  dispoIdx,
  turmaId,
  professorId,
  disciplinaId,
  diasList,
  periodosPorDia
) {
  const turmaGrade = gradePorTurma[turmaId] || {};
  const profGrade = gradePorProfessor[professorId] || {};

  for (const d of diasList) {
    for (let p = 1; p <= periodosPorDia; p++) {
      if (!profGrade?.[d]?.[p] && professorPode(dispoIdx, professorId, d, p)) {
        const cellTurma = turmaGrade?.[d]?.[p];
        if (cellTurma && !cellTurma.locked) {
          const profB = cellTurma.professor_id;
          const discB = cellTurma.disciplina_id;

          for (const d2 of diasList) {
            for (let p2 = 1; p2 <= periodosPorDia; p2++) {
              if (d === d2 && p === p2) continue;

              if (!gradePorProfessor[profB]?.[d2]?.[p2] && professorPode(dispoIdx, profB, d2, p2)) {
                const cellTurma2 = gradePorTurma[turmaId]?.[d2]?.[p2];
                if (cellTurma2 && !cellTurma2.locked) {
                  const profC = cellTurma2.professor_id;
                  const discC = cellTurma2.disciplina_id;
                  if (profC === profB) continue;

                  for (const d3 of diasList) {
                    for (let p3 = 1; p3 <= periodosPorDia; p3++) {
                      if ((d3 === d && p3 === p) || (d3 === d2 && p3 === p2)) continue;

                      if (
                        !gradePorTurma[turmaId]?.[d3]?.[p3] &&
                        !gradePorProfessor[profC]?.[d3]?.[p3] &&
                        professorPode(dispoIdx, profC, d3, p3)
                      ) {
                        clearSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2);
                        setSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d3, p3, discC);

                        clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d, p);
                        setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2, discB);

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

function tryTripleSwap(
  gradePorTurma,
  gradePorProfessor,
  dispoIdx,
  turmaId,
  professorId,
  disciplinaId,
  diasList,
  periodosPorDia
) {
  const turmaGrade = gradePorTurma[turmaId] || {};
  const profGrade = gradePorProfessor[professorId] || {};

  for (const d of diasList) {
    for (let p = 1; p <= periodosPorDia; p++) {
      if (profGrade?.[d]?.[p]) continue;
      if (!professorPode(dispoIdx, professorId, d, p)) continue;

      const cellB = turmaGrade?.[d]?.[p];
      if (!cellB || cellB.locked) continue;
      const profB = cellB.professor_id;
      const discB = cellB.disciplina_id;
      if (!profB) continue;

      for (const d2 of diasList) {
        for (let p2 = 1; p2 <= periodosPorDia; p2++) {
          if (d2 === d && p2 === p) continue;
          if (gradePorProfessor[profB]?.[d2]?.[p2]) continue;
          if (!professorPode(dispoIdx, profB, d2, p2)) continue;

          const cellC = gradePorTurma[turmaId]?.[d2]?.[p2];
          if (!cellC || cellC.locked) continue;
          const profC = cellC.professor_id;
          const discC = cellC.disciplina_id;
          if (!profC || profC === profB) continue;

          for (const d3 of diasList) {
            for (let p3 = 1; p3 <= periodosPorDia; p3++) {
              if ((d3 === d && p3 === p) || (d3 === d2 && p3 === p2)) continue;
              if (gradePorProfessor[profC]?.[d3]?.[p3]) continue;
              if (!professorPode(dispoIdx, profC, d3, p3)) continue;

              const cellD = gradePorTurma[turmaId]?.[d3]?.[p3];
              if (!cellD || cellD.locked) continue;
              const profD = cellD.professor_id;
              const discD = cellD.disciplina_id;
              if (!profD || profD === profB || profD === profC) continue;

              for (const d4 of diasList) {
                for (let p4 = 1; p4 <= periodosPorDia; p4++) {
                  if (
                    (d4 === d && p4 === p) ||
                    (d4 === d2 && p4 === p2) ||
                    (d4 === d3 && p4 === p3)
                  )
                    continue;
                  if (gradePorTurma[turmaId]?.[d4]?.[p4]) continue;
                  if (gradePorProfessor[profD]?.[d4]?.[p4]) continue;
                  if (!professorPode(dispoIdx, profD, d4, p4)) continue;

                  clearSlot(gradePorTurma, gradePorProfessor, turmaId, profD, d3, p3);
                  setSlot(gradePorTurma, gradePorProfessor, turmaId, profD, d4, p4, discD);

                  clearSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2);
                  setSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d3, p3, discC);

                  clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d, p);
                  setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2, discB);

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

/**
 * tryCrossTurmaKempeChain:
 * Resolve deadlocks onde o bloqueio atravessa MÚLTIPLAS turmas e professores:
 * - Variante A: Turma T1 está livre em (d1,p1), mas ProfA está ocupado na Turma T2 em (d1,p1).
 *   Movemos ProfA na Turma T2 para (d2,p2) onde ProfA está livre, e deslocamos o ProfB que estava
 *   em (T2, d2, p2) para um horário livre (d3,p3) de T2!
 * - Variante B: ProfA está livre em (d1,p1), mas Turma T1 está ocupada por ProfB em (d1,p1).
 *   Movemos ProfB na Turma T1 para (d2,p2) onde Turma T1 está livre, mas ProfB estava dando aula
 *   na Turma T2 em (d2,p2) -> movemos a aula de ProfB na Turma T2 para um slot livre (d3,p3) de T2!
 */
function tryCrossTurmaKempeChain(
  gradePorTurma,
  gradePorProfessor,
  dispoIdx,
  turmaId,
  professorId,
  disciplinaId,
  diasList,
  periodosPorDia
) {
  const turmaGrade = gradePorTurma[turmaId] || {};
  const profGrade = gradePorProfessor[professorId] || {};

  // Variante A: TurmaId livre em (d1,p1), ProfA ocupado em Turma2 em (d1,p1) ->
  // move ProfA em Turma2 para (d2,p2) ocupado por ProfB em Turma2 -> move ProfB em Turma2 para (d3,p3) livre
  for (const d1 of diasList) {
    for (let p1 = 1; p1 <= periodosPorDia; p1++) {
      if (turmaGrade?.[d1]?.[p1]) continue;
      if (!professorPode(dispoIdx, professorId, d1, p1)) continue;

      const cellProfA = profGrade?.[d1]?.[p1];
      if (!cellProfA || cellProfA.locked) continue;
      const turma2 = cellProfA.turma_id;
      const discA2 = cellProfA.disciplina_id;
      if (!turma2 || turma2 === turmaId) continue;

      for (const d2 of diasList) {
        for (let p2 = 1; p2 <= periodosPorDia; p2++) {
          if (d2 === d1 && p2 === p1) continue;
          // ProfA deve estar livre em (d2,p2)
          if (profGrade?.[d2]?.[p2]) continue;
          if (!professorPode(dispoIdx, professorId, d2, p2)) continue;

          const cellTurma2 = gradePorTurma[turma2]?.[d2]?.[p2];
          if (!cellTurma2 || cellTurma2.locked) continue;
          const profB = cellTurma2.professor_id;
          const discB2 = cellTurma2.disciplina_id;
          if (!profB || profB === professorId) continue;

          // Procura (d3,p3) livre para Turma2 e ProfB
          for (const d3 of diasList) {
            for (let p3 = 1; p3 <= periodosPorDia; p3++) {
              if ((d3 === d1 && p3 === p1) || (d3 === d2 && p3 === p2)) continue;
              if (gradePorTurma[turma2]?.[d3]?.[p3]) continue;
              if (gradePorProfessor[profB]?.[d3]?.[p3]) continue;
              if (!professorPode(dispoIdx, profB, d3, p3)) continue;

              // Executa cadeia multi-turma A!
              clearSlot(gradePorTurma, gradePorProfessor, turma2, profB, d2, p2);
              setSlot(gradePorTurma, gradePorProfessor, turma2, profB, d3, p3, discB2);

              clearSlot(gradePorTurma, gradePorProfessor, turma2, professorId, d1, p1);
              setSlot(gradePorTurma, gradePorProfessor, turma2, professorId, d2, p2, discA2);

              setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, d1, p1, disciplinaId);
              return true;
            }
          }
        }
      }
    }
  }

  // Variante B: ProfA livre em (d1,p1), TurmaId ocupada por ProfB em (d1,p1) ->
  // move ProfB em TurmaId para (d2,p2) onde TurmaId está livre, mas ProfB está ocupado em Turma2 em (d2,p2) ->
  // move ProfB em Turma2 de (d2,p2) para (d3,p3) livre em Turma2 e ProfB!
  for (const d1 of diasList) {
    for (let p1 = 1; p1 <= periodosPorDia; p1++) {
      if (profGrade?.[d1]?.[p1]) continue;
      if (!professorPode(dispoIdx, professorId, d1, p1)) continue;

      const cellTurma1 = turmaGrade?.[d1]?.[p1];
      if (!cellTurma1 || cellTurma1.locked) continue;
      const profB = cellTurma1.professor_id;
      const discB1 = cellTurma1.disciplina_id;
      if (!profB || profB === professorId) continue;

      for (const d2 of diasList) {
        for (let p2 = 1; p2 <= periodosPorDia; p2++) {
          if (d2 === d1 && p2 === p1) continue;
          // TurmaId deve estar livre em (d2,p2) e ProfB disponível
          if (turmaGrade?.[d2]?.[p2]) continue;
          if (!professorPode(dispoIdx, profB, d2, p2)) continue;

          const cellProfB2 = gradePorProfessor[profB]?.[d2]?.[p2];
          if (!cellProfB2 || cellProfB2.locked) continue;
          const turma2 = cellProfB2.turma_id;
          const discB2 = cellProfB2.disciplina_id;
          if (!turma2 || turma2 === turmaId) continue;

          // Procura (d3,p3) livre para Turma2 e ProfB
          for (const d3 of diasList) {
            for (let p3 = 1; p3 <= periodosPorDia; p3++) {
              if ((d3 === d1 && p3 === p1) || (d3 === d2 && p3 === p2)) continue;
              if (gradePorTurma[turma2]?.[d3]?.[p3]) continue;
              if (gradePorProfessor[profB]?.[d3]?.[p3]) continue;
              if (!professorPode(dispoIdx, profB, d3, p3)) continue;

              // Executa cadeia multi-turma B!
              clearSlot(gradePorTurma, gradePorProfessor, turma2, profB, d2, p2);
              setSlot(gradePorTurma, gradePorProfessor, turma2, profB, d3, p3, discB2);

              clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d1, p1);
              setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2, discB1);

              setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, d1, p1, disciplinaId);
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

function tryPlaceWithAllOperators({
  gradePorTurma,
  gradePorProfessor,
  dispoIdx,
  diasList,
  periodosPorDia,
  turmaId,
  professorId,
  disciplinaId,
  coProfessores = [],
  rc01MaxConsecutivas,
  rc02Cfg,
  regrasGerais,
  turno,
  preferencias,
}) {
  const best = findBestFreeSlot({
    gradePorTurma,
    gradePorProfessor,
    dispoIdx,
    diasList,
    periodosPorDia,
    turmaId,
    professorId,
    disciplinaId,
    coProfessores,
    rc01MaxConsecutivas,
    rc02Cfg,
    regrasGerais,
    turno,
    preferencias,
  });

  if (best) {
    setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, best.dia, best.periodo, disciplinaId, false, coProfessores);
    return true;
  }

  // Se houver co-professores simultâneos, evitamos swaps simples que não verificam coProfessores
  if (Array.isArray(coProfessores) && coProfessores.length > 0) {
    return false;
  }

  if (
    trySingleSwap(
      gradePorTurma,
      gradePorProfessor,
      dispoIdx,
      turmaId,
      professorId,
      disciplinaId,
      diasList,
      periodosPorDia
    )
  ) {
    return true;
  }

  if (
    tryCrossTurmaKempeChain(
      gradePorTurma,
      gradePorProfessor,
      dispoIdx,
      turmaId,
      professorId,
      disciplinaId,
      diasList,
      periodosPorDia
    )
  ) {
    return true;
  }

  if (
    tryDoubleSwap(
      gradePorTurma,
      gradePorProfessor,
      dispoIdx,
      turmaId,
      professorId,
      disciplinaId,
      diasList,
      periodosPorDia
    )
  ) {
    return true;
  }

  if (
    tryTripleSwap(
      gradePorTurma,
      gradePorProfessor,
      dispoIdx,
      turmaId,
      professorId,
      disciplinaId,
      diasList,
      periodosPorDia
    )
  ) {
    return true;
  }

  return false;
}

// --------------------------------------------------------------------------------------
// Fase de Reparo por Busca Tabu com Ejeção Guiada (Tabu Ejection Search)
// Quando restam poucas aulas não alocadas, desaloja cirurgicamente aulas bloqueadoras
// --------------------------------------------------------------------------------------

function runTabuEjectionRepair({
  gradePorTurma,
  gradePorProfessor,
  unplacedLessons,
  dispoIdx,
  diasList,
  periodosPorDia,
  rc01MaxConsecutivas,
  rc02Cfg,
  regrasGerais,
  turno,
  preferencias,
  maxSteps = 90,
}) {
  if (!unplacedLessons || unplacedLessons.length === 0) return [];

  let queue = unplacedLessons.map(x => ({ ...x }));
  let bestQueue = queue.map(x => ({ ...x }));
  let bestTurmaSnap = cloneGradeMap(gradePorTurma);
  let bestProfSnap = cloneGradeMap(gradePorProfessor);

  const tabuMap = new Map(); // "turmaId|profId|dia|periodo" -> stepUntil
  const TABU_TENURE = 9;

  for (let step = 1; step <= maxSteps && queue.length > 0; step++) {
    // Escolhe a primeira aula pendente (ou rotaciona)
    const target = queue.shift();
    const { turma_id: tId, disciplina_id: dId, professor_id: pId, co_professores: coProfs = [] } = target;

    // 1) Tenta encaixar com operadores normais primeiro
    const placedDirect = tryPlaceWithAllOperators({
      gradePorTurma,
      gradePorProfessor,
      dispoIdx,
      diasList,
      periodosPorDia,
      turmaId: tId,
      professorId: pId,
      disciplinaId: dId,
      coProfessores: coProfs,
      rc01MaxConsecutivas,
      rc02Cfg,
      regrasGerais,
      turno,
      preferencias,
    });

    if (placedDirect) {
      if (queue.length < bestQueue.length) {
        bestQueue = queue.map(x => ({ ...x }));
        bestTurmaSnap = cloneGradeMap(gradePorTurma);
        bestProfSnap = cloneGradeMap(gradePorProfessor);
      }
      continue;
    }

    // 2) Se não coube diretamente, escolhe um slot (d, p) válido para o professor para EJETAR quem bloqueia
    const candidates = [];
    for (const d of diasList) {
      for (let p = 1; p <= periodosPorDia; p++) {
        if (!professorPode(dispoIdx, pId, d, p)) continue;
        if (Array.isArray(coProfs) && coProfs.length > 0) {
          let coAvail = true;
          for (const cp of coProfs) {
            if (!professorPode(dispoIdx, cp, d, p) || gradePorProfessor[cp]?.[d]?.[p]) {
              coAvail = false;
              break;
            }
          }
          if (!coAvail) continue;
        }

        const cellT = gradePorTurma[tId]?.[d]?.[p];
        const cellP = gradePorProfessor[pId]?.[d]?.[p];

        // Nunca ejeta células fixadas manualmente (locked)
        if (cellT?.locked || cellP?.locked) continue;

        const tabuKey = `${tId}|${pId}|${d}|${p}`;
        const isTabu = (tabuMap.get(tabuKey) || 0) > step;

        let blockersCount = 0;
        if (cellT) blockersCount++;
        if (cellP && Number(cellP.turma_id) !== Number(tId)) blockersCount++;
        if (blockersCount === 0) continue;

        // Prioriza slots não-tabu com apenas 1 bloqueador
        const cost = (isTabu ? 500 : 0) + blockersCount * 100 + Math.random() * 25;
        candidates.push({ d, p, cellT, cellP, cost });
      }
    }

    if (candidates.length === 0) {
      queue.push(target);
      continue;
    }

    candidates.sort((a, b) => a.cost - b.cost);
    const chosen = candidates[0];
    const { d, p, cellT, cellP } = chosen;

    const ejected = [];
    if (cellT) {
      const oldProf = cellT.professor_id;
      const oldDisc = cellT.disciplina_id;
      const oldCoProfs = cellT.co_professores || [];
      clearSlot(gradePorTurma, gradePorProfessor, tId, oldProf, d, p);
      tabuMap.set(`${tId}|${oldProf}|${d}|${p}`, step + TABU_TENURE);
      ejected.push({ turma_id: tId, disciplina_id: oldDisc, professor_id: oldProf, co_professores: oldCoProfs });
    }
    if (cellP && Number(cellP.turma_id) !== Number(tId)) {
      const oldTurma = cellP.turma_id;
      const oldDisc = cellP.disciplina_id;
      // Verifica se ainda está lá
      const oldCellT = gradePorTurma[oldTurma]?.[d]?.[p];
      if (oldCellT) {
        const oldCoProfs = oldCellT.co_professores || [];
        clearSlot(gradePorTurma, gradePorProfessor, oldTurma, pId, d, p);
        tabuMap.set(`${oldTurma}|${pId}|${d}|${p}`, step + TABU_TENURE);
        ejected.push({ turma_id: oldTurma, disciplina_id: oldDisc, professor_id: pId, co_professores: oldCoProfs });
      }
    }

    // Aloca a aula target no slot (d, p)
    setSlot(gradePorTurma, gradePorProfessor, tId, pId, d, p, dId, false, coProfs);
    tabuMap.set(`${tId}|${pId}|${d}|${p}`, step + TABU_TENURE);

    // Tenta realocar imediatamente as aulas ejetadas
    for (const ej of ejected) {
      const okEj = tryPlaceWithAllOperators({
        gradePorTurma,
        gradePorProfessor,
        dispoIdx,
        diasList,
        periodosPorDia,
        turmaId: ej.turma_id,
        professorId: ej.professor_id,
        disciplinaId: ej.disciplina_id,
        coProfessores: ej.co_professores || [],
        rc01MaxConsecutivas,
        rc02Cfg,
        regrasGerais,
        turno,
        preferencias,
      });
      if (!okEj) {
        queue.push(ej);
      }
    }

    if (queue.length < bestQueue.length) {
      bestQueue = queue.map(x => ({ ...x }));
      bestTurmaSnap = cloneGradeMap(gradePorTurma);
      bestProfSnap = cloneGradeMap(gradePorProfessor);
      if (bestQueue.length === 0) break;
    }
  }

  // Restaura o melhor estado atingido durante a busca Tabu
  for (const k of Object.keys(gradePorTurma)) delete gradePorTurma[k];
  for (const [k, v] of Object.entries(bestTurmaSnap)) gradePorTurma[k] = v;

  for (const k of Object.keys(gradePorProfessor)) delete gradePorProfessor[k];
  for (const [k, v] of Object.entries(bestProfSnap)) gradePorProfessor[k] = v;

  return bestQueue;
}

// --------------------------------------------------------------------------------------
//Solver Principal
// --------------------------------------------------------------------------------------

export function runGreedySolver(payload, randomize = false, strategy = "default") {
  const diasList =
    Array.isArray(payload?.dias_semana) && payload.dias_semana.length > 0
      ? payload.dias_semana.map(Number).filter(n => n >= 1 && n <= 6)
      : [1, 2, 3, 4, 5];

  const periodosPorDia = clamp(toInt(payload?.periodos_por_dia, 6), 1, 10);
  const configPedagogica = payload?.config_pedagogica || payload?.configPedagogica || null;

  const rc01MaxConsecutivas = readRc01MaxConsecutivas(configPedagogica);
  const rc02Cfg = readRc02Config(configPedagogica);
  const regrasGerais = configPedagogica?.regras_gerais || null;
  const turno = payload?.turno || "matutino";

  const turmaIds = normalizeTurmaIds(payload);
  const demandasNorm = normalizeDemandas(payload);

  // Disponibilidades reais (respeita 'indisponivel' e 'evitar')
  const dispoIdx = buildDisponibilidadeIndex(payload?.disponibilidades, diasList, periodosPorDia);

  // Slots fixos (vindos da aba ✍️ Horário Manual / locked=1)
  const slotsFixos = Array.isArray(payload?.slots_fixos) ? payload.slots_fixos : [];
  const turmaIdsSet = new Set(turmaIds.map(Number));

  // Calcula quantas aulas de cada (turma_id, disciplina_id, professor_id) já foram preenchidas pelos slots fixos
  const fixosCountMap = new Map();
  const validFixos = [];
  const externalProfFixos = [];
  const diasSet = new Set(diasList);

  for (const sf of slotsFixos) {
    const tId = toInt(sf.turma_id, 0);
    const dId = toInt(sf.disciplina_id, 0);
    const pId = toInt(sf.professor_id, 0);
    const dia = toInt(sf.dia ?? sf.dia_semana, 0);
    const ord = toInt(sf.ordem ?? sf.periodo_ordem, 0);
    if (!tId || !dId || !pId || !diasSet.has(dia) || ord < 1 || ord > periodosPorDia) continue;

    if (turmaIdsSet.size === 0 || turmaIdsSet.has(tId)) {
      validFixos.push({ turma_id: tId, disciplina_id: dId, professor_id: pId, dia, ordem: ord });
      const k = `${tId}|${dId}|${pId}`;
      fixosCountMap.set(k, (fixosCountMap.get(k) || 0) + 1);
    } else {
      // Slot fixo do professor em outra turma do mesmo turno (fora do escopo atual):
      // bloqueia o professor nesse (dia, ordem) para evitar choque!
      externalProfFixos.push({ turma_id: tId, disciplina_id: dId, professor_id: pId, dia, ordem: ord });
    }
  }

  // Ajusta demandas descontando os slots já fixados manualmente
  const demandasAjustadas = demandasNorm.map(d => {
    const k = `${d.turma_id}|${d.disciplina_id}|${d.professor_id}`;
    const jaFixadas = fixosCountMap.get(k) || 0;
    const restantes = Math.max(0, d.aulas_semanais - jaFixadas);
    return {
      ...d,
      aulas_restantes: restantes,
    };
  });

  const lessons = expandDemandasToLessons(
    demandasAjustadas,
    randomize,
    strategy,
    dispoIdx,
    diasList,
    periodosPorDia
  );

  const allProfIds = uniq([
    ...demandasNorm.map(d => d.professor_id),
    ...demandasNorm.flatMap(d => d.co_professores || []),
    ...validFixos.map(f => f.professor_id),
    ...externalProfFixos.map(f => f.professor_id),
  ]);

  const gradePorTurma = initGradePorTurma(turmaIds, diasList, periodosPorDia);
  const gradePorProfessor = initGradePorProfessor(allProfIds, diasList, periodosPorDia);

  // 1a) Bloqueia horários de professores que estão em outras turmas fixas do mesmo turno
  for (const ef of externalProfFixos) {
    if (!gradePorProfessor[ef.professor_id]) {
      gradePorProfessor[ef.professor_id] = initEmptyGridForEntity(diasList, periodosPorDia);
    }
    ensurePath(gradePorProfessor, ef.professor_id, ef.dia);
    gradePorProfessor[ef.professor_id][ef.dia][ef.ordem] = {
      turma_id: ef.turma_id,
      disciplina_id: ef.disciplina_id,
      locked: true,
    };
  }

  // 1b) Pré-aloca todos os slots fixos das turmas no escopo (locked = true)
  let alocadasFixas = 0;
  for (const sf of validFixos) {
    if (!gradePorTurma[sf.turma_id]) {
      gradePorTurma[sf.turma_id] = initEmptyGridForEntity(diasList, periodosPorDia);
    }
    if (!gradePorProfessor[sf.professor_id]) {
      gradePorProfessor[sf.professor_id] = initEmptyGridForEntity(diasList, periodosPorDia);
    }
    if (!gradePorTurma[sf.turma_id]?.[sf.dia]?.[sf.ordem] && !gradePorProfessor[sf.professor_id]?.[sf.dia]?.[sf.ordem]) {
      setSlot(gradePorTurma, gradePorProfessor, sf.turma_id, sf.professor_id, sf.dia, sf.ordem, sf.disciplina_id, true);
      alocadasFixas++;
    }
  }

  // 2) Fase Construtiva + Operadores de Swap / Kempe Chain
  let unplaced = [];
  for (const lesson of lessons) {
    const { turma_id: turmaId, disciplina_id: disciplinaId, professor_id: professorId, co_professores: coProfessores = [] } = lesson;

    if (!gradePorTurma[turmaId]) {
      gradePorTurma[turmaId] = initEmptyGridForEntity(diasList, periodosPorDia);
    }
    if (!gradePorProfessor[professorId]) {
      gradePorProfessor[professorId] = initEmptyGridForEntity(diasList, periodosPorDia);
    }
    for (const cp of coProfessores) {
      if (!gradePorProfessor[cp]) {
        gradePorProfessor[cp] = initEmptyGridForEntity(diasList, periodosPorDia);
      }
    }

    const ok = tryPlaceWithAllOperators({
      gradePorTurma,
      gradePorProfessor,
      dispoIdx,
      diasList,
      periodosPorDia,
      turmaId,
      professorId,
      disciplinaId,
      coProfessores,
      rc01MaxConsecutivas,
      rc02Cfg,
      regrasGerais,
      turno,
      preferencias: payload?.preferencias,
    });

    if (!ok) {
      unplaced.push(lesson);
    }
  }

  // 3) Fase de Reparo por Busca Tabu (Tabu Ejection Search) se restarem poucas aulas
  if (unplaced.length > 0 && unplaced.length <= 18) {
    unplaced = runTabuEjectionRepair({
      gradePorTurma,
      gradePorProfessor,
      unplacedLessons: unplaced,
      dispoIdx,
      diasList,
      periodosPorDia,
      rc01MaxConsecutivas,
      rc02Cfg,
      regrasGerais,
      turno,
      preferencias: payload?.preferencias,
      maxSteps: unplaced.length <= 6 ? 110 : 65,
    });
  }

  // 4) Diagnóstico das aulas que eventualmente restarem sem alocação
  const diagnosticoNaoAlocadas = [];
  const diagnosticoContadores = {
    SEM_SLOT_LIVRE_TURMA: 0,
    COLISAO_PROFESSOR: 0,
    SEM_DISPONIBILIDADE_PROFESSOR: 0,
    OUTRO: 0,
  };

  for (const na of unplaced) {
    const motivo = inferirMotivoNaoAlocacao({
      turmaGrade: gradePorTurma[na.turma_id],
      profGrade: gradePorProfessor[na.professor_id],
      dispoIdx,
      professorId: na.professor_id,
      periodosPorDia,
      diasList,
    });
    diagnosticoNaoAlocadas.push({
      turma_id: na.turma_id,
      disciplina_id: na.disciplina_id,
      professor_id: na.professor_id,
      motivo,
    });
    const k = diagnosticoContadores[motivo] !== undefined ? motivo : "OUTRO";
    diagnosticoContadores[k] = (diagnosticoContadores[k] || 0) + 1;
  }

  // 5) Limpeza defensiva de eventuais excessos (preservando slots fixos)
  validateAndCleanGrade(gradePorTurma, gradePorProfessor, demandasNorm, validFixos);

  // Reconta o total real de aulas alocadas na grade após validação
  let totalAlocadasReal = 0;
  for (const diasObj of Object.values(gradePorTurma)) {
    for (const perObj of Object.values(diasObj || {})) {
      for (const cell of Object.values(perObj || {})) {
        if (cell && cell.professor_id) totalAlocadasReal++;
      }
    }
  }

  const demandaTotal = Math.max(
    demandasNorm.reduce((acc, d) => acc + d.aulas_semanais, 0),
    totalAlocadasReal + unplaced.length
  );

  let cobertura = 100;
  if (demandaTotal > 0) {
    cobertura = (totalAlocadasReal / demandaTotal) * 100;
    cobertura = totalAlocadasReal < demandaTotal ? Math.floor(cobertura) : 100;
  }

  const payloadSummary = {
    escola_id: payload?.escola_id ?? payload?.escolaId ?? null,
    turno: payload?.turno ?? null,
    ano_ref: payload?.ano_ref ?? null,
    nivel: payload?.nivel ?? payload?.config_pedagogica?.nivel ?? null,
    turmas: turmaIds.length,
    demanda: demandaTotal,
    professores: allProfIds.length,
    slots_fixos_respeitados: alocadasFixas,
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
      aulas_alocadas: totalAlocadasReal,
      aulas_demanda: demandaTotal,
      slots_fixos: alocadasFixas,
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
// Validação pós-alocação (preserva slots locked)
// --------------------------------------------------------------------------------------

function validateAndCleanGrade(gradePorTurma, gradePorProfessor, demandasNorm, validFixos = []) {
  const demandaMap = new Map();
  for (const d of demandasNorm) {
    const k = `${d.turma_id}|${d.disciplina_id}`;
    demandaMap.set(k, (demandaMap.get(k) || 0) + d.aulas_semanais);
  }
  // Garante que slots fixos manuais (mesmo fora de turma_cargas) nunca sejam removidos
  const fixosPerTurmaDisc = new Map();
  for (const sf of validFixos) {
    const k = `${sf.turma_id}|${sf.disciplina_id}`;
    fixosPerTurmaDisc.set(k, (fixosPerTurmaDisc.get(k) || 0) + 1);
  }

  for (const [turmaIdStr, dias] of Object.entries(gradePorTurma)) {
    const turmaId = Number(turmaIdStr);
    const countByDisc = new Map();
    const slotsByDisc = new Map();

    for (const [dStr, perSlot] of Object.entries(dias || {})) {
      const dia = Number(dStr);
      for (const [pStr, cell] of Object.entries(perSlot || {})) {
        const periodo = Number(pStr);
        if (!cell) continue;
        const discId = cell.disciplina_id;
        countByDisc.set(discId, (countByDisc.get(discId) || 0) + 1);
        if (!slotsByDisc.has(discId)) slotsByDisc.set(discId, []);
        slotsByDisc.get(discId).push({ d: dia, p: periodo, profId: cell.professor_id, locked: !!cell.locked });
      }
    }

    for (const [discId, count] of countByDisc) {
      const key = `${turmaId}|${discId}`;
      const maxAllowed = Math.max(demandaMap.get(key) || 0, fixosPerTurmaDisc.get(key) || 0);
      if (count > maxAllowed) {
        const unlockedSlots = (slotsByDisc.get(discId) || []).filter(s => !s.locked);
        const toRemove = count - maxAllowed;
        for (let i = 0; i < toRemove && i < unlockedSlots.length; i++) {
          const slot = unlockedSlots[unlockedSlots.length - 1 - i];
          if (!slot) continue;
          clearSlot(gradePorTurma, gradePorProfessor, turmaId, slot.profId, slot.d, slot.p);
        }
      }
    }
  }
}

function inferirMotivoNaoAlocacao({
  turmaGrade,
  profGrade,
  dispoIdx,
  professorId,
  periodosPorDia,
  diasList = [1, 2, 3, 4, 5],
}) {
  let isProfLotado = true;
  let isTurmaLotada = true;
  let slotsDisponiveisProf = 0;

  for (const d of diasList) {
    for (let p = 1; p <= (periodosPorDia || 6); p++) {
      const pode = professorPode(dispoIdx, professorId, d, p);
      if (pode) slotsDisponiveisProf++;
      if (pode && !profGrade?.[d]?.[p]) isProfLotado = false;
      if (!turmaGrade?.[d]?.[p]) isTurmaLotada = false;
    }
  }

  if (slotsDisponiveisProf === 0) return "SEM_DISPONIBILIDADE_PROFESSOR";
  if (isProfLotado) return "COLISAO_PROFESSOR";
  if (isTurmaLotada) return "TURMA_SEM_HORARIO";
  return "SEM_SLOT_LIVRE_TURMA";
}

export default { runGreedySolver };
export { validateAndCleanGrade };
