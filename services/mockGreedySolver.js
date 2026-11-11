// src/features/secretaria/horarios/solverEngine.js
// ============================================================================
// MOTOR SOLVER 2.0 (Urânia-Engine) — Web Worker + Multi-Start + Kempe Chains + Tabu Search
// Executa 100% em background thread no navegador do usuário (sem timeout HTTP),
// enviando telemetria em tempo real (iterações, cobertura, estratégia ativa, melhor grade)
// e permitindo parada imediata ("Parar e Usar Melhor Grade") a qualquer momento.
// ============================================================================

function solverWorkerBootstrap(workerScope) {
  function toInt(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function uniq(arr) {
    return Array.from(new Set(arr));
  }

  function ensurePath(obj, k1, k2) {
    if (!obj[k1]) obj[k1] = {};
    if (!obj[k1][k2]) obj[k1][k2] = {};
    return obj[k1][k2];
  }

  function cloneGradeMap(gradeMap) {
    const out = {};
    for (const [id, diasObj] of Object.entries(gradeMap || {})) {
      out[id] = {};
      for (const [d, perObj] of Object.entries(diasObj || {})) {
        out[id][d] = {};
        for (const [p, cell] of Object.entries(perObj || {})) {
          out[id][d][p] = cell ? { ...cell } : null;
        }
      }
    }
    return out;
  }

  function buildDisponibilidadeIndex(disponibilidades, diasList, periodosPorDia) {
    const idx = new Map();
    const list = Array.isArray(disponibilidades) ? disponibilidades : [];

    for (const d of list) {
      const profId = toInt(d?.professor_id ?? d?.professorId, 0);
      const dia = toInt(d?.dia ?? d?.dia_semana ?? d?.diaSemana, 0);
      const per = toInt(d?.ordem ?? d?.periodo ?? d?.aula ?? d?.periodo_ordem, 0);
      const status = String(d?.status || "indisponivel").trim().toLowerCase();

      if (!profId || !dia || !per) continue;
      if (!diasList.includes(dia)) continue;
      if (per < 1 || per > periodosPorDia) continue;

      if (status === "indisponivel" || status === "bloqueado" || status === "excluir") {
        idx.set(`${profId}|${dia}|${per}`, "indisponivel");
      } else if (status === "evitar") {
        if (idx.get(`${profId}|${dia}|${per}`) !== "indisponivel") {
          idx.set(`${profId}|${dia}|${per}`, "evitar");
        }
      }
    }
    return idx;
  }

  function professorPode(dispoIdx, professorId, dia, periodo) {
    if (!dispoIdx || dispoIdx.size === 0) return true;
    return dispoIdx.get(`${professorId}|${dia}|${periodo}`) !== "indisponivel";
  }

  function professorEvita(dispoIdx, professorId, dia, periodo) {
    if (!dispoIdx || dispoIdx.size === 0) return false;
    return dispoIdx.get(`${professorId}|${dia}|${periodo}`) === "evitar";
  }

  function countProfessorAvailableSlots(dispoIdx, professorId, diasList, periodosPorDia) {
    let available = 0;
    for (const d of diasList) {
      for (let p = 1; p <= periodosPorDia; p++) {
        if (professorPode(dispoIdx, professorId, d, p)) {
          available += professorEvita(dispoIdx, professorId, d, p) ? 0.5 : 1;
        }
      }
    }
    return available;
  }

  function readRc01MaxConsecutivas(configPedagogica) {
    const rgMax = configPedagogica?.regras_gerais?.max_aulas_mesmo_dia;
    const raw =
      configPedagogica?.regras?.rc01_distribuicao_disciplina?.max_consecutivas ??
      configPedagogica?.rc01_distribuicao_disciplina?.max_consecutivas ??
      configPedagogica?.max_consecutivas ??
      rgMax ??
      2;
    return clamp(toInt(raw, 2), 1, 6);
  }

  function readRc02Config(configPedagogica) {
    const r =
      configPedagogica?.regras?.rc02_max_por_dia_disciplina ??
      configPedagogica?.regras?.rc02_max_aulas_por_dia_disciplina ??
      configPedagogica?.rc02_max_por_dia_disciplina ??
      configPedagogica?.rc02_max_aulas_por_dia_disciplina ??
      null;

    const rgMax = configPedagogica?.regras_gerais?.max_aulas_mesmo_dia;
    const modoRaw = String(r?.modo ?? "hard").toLowerCase();
    const modo = modoRaw === "soft" && !rgMax ? "soft" : "hard";
    const maxPadrao = clamp(toInt(rgMax ?? r?.max_por_dia_padrao ?? r?.maxPorDiaPadrao ?? 2, 2), 1, 6);
    const bloqueioHard = Boolean(r?.bloqueio_hard ?? r?.bloqueioHard ?? true);
    const maxHardPadrao = clamp(toInt(r?.max_hard_padrao ?? r?.maxHardPadrao ?? maxPadrao, maxPadrao), maxPadrao, 6);
    const strictCapMock = Boolean(r?.strict_cap_mock ?? r?.strictCapMock ?? true);

    const porDiscRaw = r?.por_disciplina ?? r?.porDisciplina ?? {};
    const porDisciplina = {};
    if (porDiscRaw && typeof porDiscRaw === "object") {
      for (const [k, v] of Object.entries(porDiscRaw)) {
        const discId = toInt(k, 0);
        if (!discId) continue;
        const cap =
          typeof v === "number"
            ? v
            : toInt(v?.max_por_dia ?? v?.maxPorDia ?? v?.max ?? maxPadrao, maxPadrao);
        porDisciplina[discId] = clamp(toInt(cap, maxPadrao), 1, 6);
      }
    }

    return {
      modo,
      maxPadrao,
      bloqueioHard,
      maxHardPadrao,
      porDisciplina,
      strictCapMock,
    };
  }

  function getRc02MaxForDisc(rc02Cfg, disciplinaId) {
    if (!rc02Cfg) return 2;
    const override = rc02Cfg.porDisciplina?.[disciplinaId];
    return clamp(toInt(override ?? rc02Cfg.maxPadrao ?? 2, 2), 1, 6);
  }

  function countDiscInDay(turmaGrade, dia, disciplinaId) {
    let count = 0;
    const row = turmaGrade?.[dia] || {};
    for (const p of Object.keys(row)) {
      const cell = row[p];
      if (cell && Number(cell.disciplina_id) === Number(disciplinaId)) count++;
    }
    return count;
  }

  function consecutiveRunIfPut(turmaGrade, dia, periodo, disciplinaId, periodosPorDia) {
    let left = 0;
    for (let p = periodo - 1; p >= 1; p--) {
      const cell = turmaGrade?.[dia]?.[p];
      if (cell && Number(cell.disciplina_id) === Number(disciplinaId)) left++;
      else break;
    }
    let right = 0;
    for (let p = periodo + 1; p <= periodosPorDia; p++) {
      const cell = turmaGrade?.[dia]?.[p];
      if (cell && Number(cell.disciplina_id) === Number(disciplinaId)) right++;
      else break;
    }
    return left + 1 + right;
  }

  function buildExcludentesMap(regrasGerais) {
    if (!regrasGerais) return null;
    if (regrasGerais._excludentesMap instanceof Map) return regrasGerais._excludentesMap;
    const raw = Array.isArray(regrasGerais.disciplinas_excludentes)
      ? regrasGerais.disciplinas_excludentes
      : [];
    const map = new Map();
    for (const pair of raw) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const d1 = toInt(pair[0], 0);
      const d2 = toInt(pair[1], 0);
      if (!d1 || !d2 || d1 === d2) continue;
      if (!map.has(d1)) map.set(d1, new Set());
      if (!map.has(d2)) map.set(d2, new Set());
      map.get(d1).add(d2);
      map.get(d2).add(d1);
    }
    return map;
  }

  /**
   * Constrói o índice de Governança Multi-Escola de Pares de Aulas Duplas
   * (Ordem de prioridade #1-#2, #4-#5, etc., modos: obrigatorio | prioritario | permitido | bloqueado,
   * e bloqueio de pares que cortam o recreio/intervalo específico do turno ativo).
   */
  function buildPairGovernanceIndex(regrasGerais, turno, periodosPorDia) {
    const turnoKey = String(turno || regrasGerais?._turno || "matutino").toLowerCase();
    if (
      regrasGerais &&
      regrasGerais._pairGov &&
      regrasGerais._pairGov.periodosPorDia === periodosPorDia &&
      regrasGerais._pairGov.turnoKey === turnoKey
    ) {
      return regrasGerais._pairGov;
    }

    const isNoturno = turnoKey.includes("noturno");
    const govApos = toInt(regrasGerais?._intervalos_governanca?.[turnoKey]?.apos_periodo, 0);
    const cfgAposRaw = regrasGerais?.recreio_apos_periodo?.[turnoKey];
    const cfgApos = cfgAposRaw !== undefined ? toInt(cfgAposRaw, 0) : null;

    // Prioriza o intervalo real cadastrado em Direção > Governança quando válido para os períodos do turno;
    // caso contrário usa recreio_apos_periodo[turno] (corrigindo legado noturno=2 quando turno tem >=5 aulas)
    let intAfter = 3;
    if (govApos > 0 && govApos < periodosPorDia) {
      intAfter = govApos;
    } else if (cfgApos !== null && cfgApos >= 0 && cfgApos < periodosPorDia) {
      intAfter = isNoturno && cfgApos === 2 && periodosPorDia >= 5 ? 3 : cfgApos;
    } else {
      intAfter = isNoturno ? (periodosPorDia >= 5 ? 3 : 2) : 3;
    }

    const bloquearRecreio =
      regrasGerais?.bloquear_duplas_no_recreio !== undefined
        ? Boolean(regrasGerais.bloquear_duplas_no_recreio)
        : regrasGerais?.aulas_duplas_separar_recreio !== undefined
        ? !regrasGerais.aulas_duplas_separar_recreio
        : true;

    const rawList = Array.isArray(regrasGerais?.pares_duplas_governanca)
      ? regrasGerais.pares_duplas_governanca
      : [];

    // Identifica recreios de outros turnos para não bloquear indevidamente um par válido do turno atual
    const otherShiftRecesses = new Set();
    if (regrasGerais?.recreio_apos_periodo && typeof regrasGerais.recreio_apos_periodo === "object") {
      for (const [tk, val] of Object.entries(regrasGerais.recreio_apos_periodo)) {
        if (String(tk).toLowerCase() !== turnoKey) {
          const rv = toInt(val, 0);
          if (rv > 0 && rv !== intAfter) otherShiftRecesses.add(rv);
        }
      }
    }

    const defaultOrder = [];
    if (periodosPorDia >= 2) defaultOrder.push(1);
    if (intAfter > 0 && intAfter + 1 < periodosPorDia && !defaultOrder.includes(intAfter + 1)) {
      defaultOrder.push(intAfter + 1);
    }
    for (let p = 1; p < periodosPorDia; p++) {
      if (p === intAfter) continue;
      if (!defaultOrder.includes(p)) defaultOrder.push(p);
    }
    if (intAfter > 0 && intAfter < periodosPorDia && !defaultOrder.includes(intAfter)) {
      defaultOrder.push(intAfter);
    }

    const byStart = new Map();
    const orderedStarts = [];

    for (const item of rawList) {
      const ini = Number(item?.inicio ?? item?.p1 ?? 0);
      if (ini >= 1 && ini < periodosPorDia && !byStart.has(ini)) {
        let modo = String(item?.modo || "prioritario").toLowerCase();
        if (!["obrigatorio", "prioritario", "permitido", "bloqueado"].includes(modo)) {
          modo = "prioritario";
        }
        // Se o par veio 'bloqueado' apenas por ser o recreio de OUTRO turno (ex: #3-#4 da manhã num turno de 4 aulas com recreio no #2), libera no turno atual
        if (
          modo === "bloqueado" &&
          ini !== intAfter &&
          (item?.bloqueado_por_recreio || otherShiftRecesses.has(ini))
        ) {
          modo = ini === intAfter + 1 ? "prioritario" : "permitido";
        }
        if (bloquearRecreio && intAfter > 0 && ini === intAfter) {
          modo = "bloqueado";
        }
        byStart.set(ini, { inicio: ini, fim: ini + 1, modo });
        orderedStarts.push(ini);
      }
    }

    for (const ini of defaultOrder) {
      if (!byStart.has(ini)) {
        const isRecreioPair = intAfter > 0 && ini === intAfter;
        const modo =
          isRecreioPair && bloquearRecreio
            ? "bloqueado"
            : orderedStarts.length < 2
            ? "prioritario"
            : "permitido";
        byStart.set(ini, { inicio: ini, fim: ini + 1, modo });
        orderedStarts.push(ini);
      }
    }

    const totalPairs = Math.max(1, orderedStarts.length);
    orderedStarts.forEach((ini, idx) => {
      const info = byStart.get(ini);
      info.rank = idx;
      info.cortaRecreio = intAfter > 0 && ini === intAfter;
      const rankFactor = Math.max(1, totalPairs - idx);

      if (info.modo === "bloqueado") {
        info.pairScoreBonus = 85000;
        info.seedScoreBonus = 750;
        info.qualityWeight = -8000;
      } else if (info.modo === "obrigatorio") {
        info.pairScoreBonus = -(7500 + rankFactor * 500);
        info.seedScoreBonus = -(980 + rankFactor * 95);
        info.qualityWeight = 260 + rankFactor * 50;
      } else if (info.modo === "prioritario") {
        info.pairScoreBonus = -(5200 + rankFactor * 380);
        info.seedScoreBonus = -(680 + rankFactor * 70);
        info.qualityWeight = 120 + rankFactor * 32;
      } else {
        info.pairScoreBonus = -(3500 + rankFactor * 180);
        info.seedScoreBonus = -(400 + rankFactor * 35);
        info.qualityWeight = 50 + rankFactor * 14;
      }
    });

    return {
      turnoKey,
      periodosPorDia,
      intAfter,
      bloquearRecreio,
      orderedStarts,
      getPairInfo(pStart) {
        return byStart.get(Number(pStart)) || null;
      },
      isPairBlocked(pStart) {
        const info = byStart.get(Number(pStart));
        return info ? info.modo === "bloqueado" : false;
      },
      isPairMandatory(pStart) {
        const info = byStart.get(Number(pStart));
        return info ? info.modo === "obrigatorio" : false;
      },
    };
  }

  /**
   * Valida se alocar `disciplinaId` em `(dia, periodo)` da `turmaGrade` respeita:
   * 1. Proibição de aulas separadas da mesma disciplina no mesmo dia (ex.: 1º e 6º horário)
   * 2. Limite máximo de aulas da mesma disciplina no mesmo dia (RC-02 / max_aulas_mesmo_dia)
   * 3. Limite máximo de aulas consecutivas (RC-01)
   * 4. Bloqueio de pares geminados proibidos pela escola ou que cortam o recreio/intervalo (ex.: #3-#4)
   */
  function canPlaceDiscInTurmaSlot({
    turmaGrade,
    dia,
    periodo,
    disciplinaId,
    periodosPorDia,
    rc01MaxConsecutivas = 2,
    rc02Cfg = null,
    regrasGerais = null,
    strictPedagogical = true,
  }) {
    const row = turmaGrade?.[dia] || {};
    let countExisting = 0;
    let minP = periodo;
    let maxP = periodo;
    const exclMap = strictPedagogical ? buildExcludentesMap(regrasGerais) : null;
    const exclSet = exclMap ? exclMap.get(Number(disciplinaId)) : null;

    for (let p = 1; p <= periodosPorDia; p++) {
      if (p === periodo) continue;
      const cell = row[p];
      if (!cell || !cell.disciplina_id) continue;
      const cellDiscId = Number(cell.disciplina_id);
      if (exclSet && exclSet.has(cellDiscId)) {
        return false;
      }
      if (cellDiscId === Number(disciplinaId)) {
        countExisting++;
        if (p < minP) minP = p;
        if (p > maxP) maxP = p;
      }
    }

    if (countExisting === 0) return true;

    const totalAfter = countExisting + 1;
    const maxDia = getRc02MaxForDisc(rc02Cfg, disciplinaId);
    const proibirSeparadas = regrasGerais ? regrasGerais.proibir_aulas_separadas_mesmo_dia !== false : true;

    // Regra 1: Jamais permitir aulas separadas da mesma disciplina no mesmo dia (ex: 1º e 6º horário)
    if (proibirSeparadas && maxP - minP + 1 !== totalAfter) {
      return false;
    }

    // Regra 2: Respeitar máximo de aulas por dia, máximo de consecutivas e bloqueio de recreio/pares bloqueados
    if (strictPedagogical) {
      if (totalAfter > maxDia) return false;
      if (totalAfter > rc01MaxConsecutivas) return false;

      const pairGov = buildPairGovernanceIndex(regrasGerais, regrasGerais?._turno, periodosPorDia);
      for (let p = minP; p < maxP; p++) {
        if (pairGov.isPairBlocked(p)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Verifica se o dia inteiro `dia` de uma `turmaGrade` está pedagogicamente válido
   * após uma permutação (Swap / Kempe Chain / Tabu Ejection).
   */
  function isTurmaDayPedagogicallyValid({
    turmaGrade,
    dia,
    periodosPorDia,
    rc01MaxConsecutivas = 2,
    rc02Cfg = null,
    regrasGerais = null,
    strictPedagogical = true,
  }) {
    const row = turmaGrade?.[dia] || {};
    const byDisc = new Map();

    for (let p = 1; p <= periodosPorDia; p++) {
      const cell = row[p];
      if (!cell || !cell.disciplina_id) continue;
      const dId = Number(cell.disciplina_id);
      let st = byDisc.get(dId);
      if (!st) {
        st = { count: 0, minP: p, maxP: p, allLocked: true };
        byDisc.set(dId, st);
      }
      st.count++;
      if (p < st.minP) st.minP = p;
      if (p > st.maxP) st.maxP = p;
      if (!cell.locked) st.allLocked = false;
    }

    const proibirSeparadas = regrasGerais ? regrasGerais.proibir_aulas_separadas_mesmo_dia !== false : true;
    const pairGov = buildPairGovernanceIndex(regrasGerais, regrasGerais?._turno, periodosPorDia);

    for (const [dId, st] of byDisc.entries()) {
      if (st.count <= 1 || st.allLocked) continue;

      if (proibirSeparadas && st.maxP - st.minP + 1 !== st.count) {
        return false;
      }

      if (strictPedagogical) {
        const maxDia = getRc02MaxForDisc(rc02Cfg, dId);
        if (st.count > maxDia) return false;
        if (st.count > rc01MaxConsecutivas) return false;

        for (let p = st.minP; p < st.maxP; p++) {
          if (pairGov.isPairBlocked(p)) {
            return false;
          }
        }
      }
    }

    if (strictPedagogical) {
      const exclMap = buildExcludentesMap(regrasGerais);
      if (exclMap && exclMap.size > 0) {
        const discIds = Array.from(byDisc.keys());
        for (let i = 0; i < discIds.length; i++) {
          const dA = discIds[i];
          const setA = exclMap.get(dA);
          if (!setA) continue;
          for (let j = i + 1; j < discIds.length; j++) {
            const dB = discIds[j];
            if (setA.has(dB)) {
              const stA = byDisc.get(dA);
              const stB = byDisc.get(dB);
              if (!(stA?.allLocked && stB?.allLocked)) {
                return false;
              }
            }
          }
        }
      }
    }

    return true;
  }

  function computeSlotScore({
    turmaGrade,
    profGrade,
    dispoIdx,
    dia,
    periodo,
    periodosPorDia,
    professorId,
    disciplinaId,
    rc01MaxConsecutivas,
    rc02Cfg,
    regrasGerais,
    turno,
    preferenciasProfessor,
  }) {
    let score = 0;

    if (professorEvita(dispoIdx, professorId, dia, periodo)) {
      score += 1800;
    }

    const turmaDayCount = Object.values(turmaGrade?.[dia] || {}).filter(Boolean).length;
    score += turmaDayCount * 1.0;

    if (periodo === 1 || periodo === periodosPorDia) {
      score += 0.35;
    }

    const consec = consecutiveRunIfPut(turmaGrade, dia, periodo, disciplinaId, periodosPorDia);
    if (consec > rc01MaxConsecutivas) {
      score += 80000 + (consec - rc01MaxConsecutivas) * 20000;
    }

    const leftCell = periodo > 1 ? turmaGrade?.[dia]?.[periodo - 1] : null;
    const rightCell = periodo < periodosPorDia ? turmaGrade?.[dia]?.[periodo + 1] : null;
    const leftSame = leftCell && Number(leftCell.disciplina_id) === Number(disciplinaId);
    const rightSame = rightCell && Number(rightCell.disciplina_id) === Number(disciplinaId);

    const prefDuplasEscola = regrasGerais ? Boolean(regrasGerais.preferencia_aulas_duplas) : true;
    const profPrefereUnica = Boolean(preferenciasProfessor?.prefere_aula_unica);
    const prefDuplas = prefDuplasEscola && !profPrefereUnica;
    const proibirSeparadas = regrasGerais ? regrasGerais.proibir_aulas_separadas_mesmo_dia !== false : true;
    const maxDia = getRc02MaxForDisc(rc02Cfg, disciplinaId);
    const inDay = countDiscInDay(turmaGrade, dia, disciplinaId);
    const strictCap = !!rc02Cfg?.strictCapMock;

    const exclMap = buildExcludentesMap(regrasGerais);
    const exclSet = exclMap ? exclMap.get(Number(disciplinaId)) : null;
    if (exclSet && exclSet.size > 0) {
      const rowDia = turmaGrade?.[dia] || {};
      for (const c of Object.values(rowDia)) {
        if (c && exclSet.has(Number(c.disciplina_id))) {
          score += 65000;
          break;
        }
      }
    }

    const pairGov = buildPairGovernanceIndex(regrasGerais, turno, periodosPorDia);
    const intAfter = pairGov.intAfter;
    const evitaSepararRecreio = pairGov.bloquearRecreio;

    if (inDay >= 1 && !leftSame && !rightSame) {
      // Penalidade severíssima para aulas separadas da mesma disciplina no mesmo dia (ex.: 1º e 6º horário)
      score += proibirSeparadas ? 150000 : 45000;
    }

    if (!prefDuplas) {
      if (leftSame || rightSame) score += profPrefereUnica ? 4500 : 2000;
      else if (profPrefereUnica && inDay > 0) score += 4500;
    } else {
      if (leftSame || rightSame) {
        const pStart = leftSame ? periodo - 1 : periodo;
        const pInfo = pairGov.getPairInfo(pStart);
        if (pInfo?.modo === "bloqueado") {
          score += 85000;
        } else if (consec <= rc01MaxConsecutivas && inDay < maxDia) {
          score += pInfo ? pInfo.pairScoreBonus : -4800;
        }
      } else if (inDay === 0) {
        // Verifica se este slot possui vizinho imediato livre e permitido pela governança da escola para formar aula dupla depois
        const leftInfo = periodo > 1 ? pairGov.getPairInfo(periodo - 1) : null;
        const rightInfo = periodo < periodosPorDia ? pairGov.getPairInfo(periodo) : null;

        const canPairLeft =
          periodo > 1 &&
          leftInfo &&
          leftInfo.modo !== "bloqueado" &&
          !turmaGrade?.[dia]?.[periodo - 1] &&
          !profGrade?.[dia]?.[periodo - 1] &&
          professorPode(dispoIdx, professorId, dia, periodo - 1);

        const canPairRight =
          periodo < periodosPorDia &&
          rightInfo &&
          rightInfo.modo !== "bloqueado" &&
          !turmaGrade?.[dia]?.[periodo + 1] &&
          !profGrade?.[dia]?.[periodo + 1] &&
          professorPode(dispoIdx, professorId, dia, periodo + 1);

        if (canPairLeft || canPairRight) {
          const bonusLeft = canPairLeft ? leftInfo.seedScoreBonus : 0;
          const bonusRight = canPairRight ? rightInfo.seedScoreBonus : 0;
          score += Math.min(bonusLeft, bonusRight);
        } else {
          score += 650;
        }

        // Se este horário faz parte de um bloco OBRIGATÓRIO cujo par vizinho já está ocupado por OUTRA disciplina,
        // penaliza quebrar o bloco obrigatório com duas disciplinas avulsas
        if (leftInfo?.modo === "obrigatorio" && leftCell && !leftSame) {
          score += 1400;
        }
        if (rightInfo?.modo === "obrigatorio" && rightCell && !rightSame) {
          score += 1400;
        }
      }
    }

    if (inDay >= maxDia) {
      if (strictCap || rc02Cfg.modo === "hard" || (rc02Cfg.bloqueioHard && maxDia === rc02Cfg.maxHardPadrao)) {
        score += 150000;
      } else {
        score += 35000 + (inDay - maxDia + 1) * 10000;
      }
    }

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
        if (hasEarlyClasses && hasLateClasses) score -= 5000;
        else score += 3000;
      } else if (profDayCount > 0 && (profLeftOcc || profRightOcc)) {
        score -= 500;
      }
    }

    score += dia * 0.04;

    if (regrasGerais) {
      if (evitaSepararRecreio && intAfter > 0) {
        if (
          (periodo === intAfter && rightSame) ||
          (periodo === intAfter + 1 && leftSame)
        ) {
          score += 85000;
        }
      }
      if (regrasGerais.limite_aulas_seguidas_prof) {
        const maxSeguidasProf = Number(regrasGerais.limite_aulas_seguidas_prof) || 4;
        let pLeft = 0;
        for (let p = periodo - 1; p >= 1; p--) {
          if (profGrade?.[dia]?.[p]) pLeft++;
          else break;
        }
        let pRight = 0;
        for (let p = periodo + 1; p <= periodosPorDia; p++) {
          if (profGrade?.[dia]?.[p]) pRight++;
          else break;
        }
        if (pLeft + 1 + pRight > maxSeguidasProf) score += 8000;
      }
    }

    if (preferenciasProfessor) {
      if (
        Array.isArray(preferenciasProfessor.dias_evitar) &&
        preferenciasProfessor.dias_evitar.includes(dia)
      ) {
        score += 1200;
      }
      if (preferenciasProfessor.evitar_extremos) {
        if (periodo === 1 || periodo === periodosPorDia) score += 800;
      } else {
        if (preferenciasProfessor.evitar_primeira_aula && periodo === 1) score += 800;
        if (preferenciasProfessor.evitar_ultima_aula && periodo === periodosPorDia) score += 800;
      }
      const maxConsecProf = Number(preferenciasProfessor.max_consecutivas_prof) || 0;
      if (maxConsecProf > 0) {
        let pLeft = 0;
        for (let p = periodo - 1; p >= 1; p--) {
          if (profGrade?.[dia]?.[p]) pLeft++;
          else break;
        }
        let pRight = 0;
        for (let p = periodo + 1; p <= periodosPorDia; p++) {
          if (profGrade?.[dia]?.[p]) pRight++;
          else break;
        }
        if (pLeft + 1 + pRight > maxConsecProf) score += 6000;
      }
    }

    return score;
  }

  function normalizeTurmaIds(payload) {
    const raw =
      payload?.turma_ids ??
      payload?.turmaIds ??
      (Array.isArray(payload?.turmas) ? payload.turmas.map(t => t?.id ?? t?.turma_id ?? t) : null) ??
      [];
    return uniq((Array.isArray(raw) ? raw : []).map(x => toInt(x, 0)).filter(Boolean));
  }

  function buildModListMap(payload) {
    const mod = Array.isArray(payload?.modulacao) ? payload.modulacao : [];
    const map = new Map();
    for (const m of mod) {
      const turmaId = toInt(m?.turma_id ?? m?.turmaId, 0);
      const discId = toInt(m?.disciplina_id ?? m?.disciplinaId, 0);
      const profId = toInt(m?.professor_id ?? m?.professorId, 0);
      const aulas = clamp(toInt(m?.aulas_semanais ?? m?.aulas ?? m?.carga ?? 0, 0), 0, 60);
      if (!turmaId || !discId || !profId) continue;
      const key = `${turmaId}|${discId}`;
      if (!map.has(key)) map.set(key, []);
      const list = map.get(key);
      if (!list.some(it => it.professor_id === profId)) {
        list.push({ professor_id: profId, aulas });
      }
    }
    return map;
  }

  function normalizeDemandas(payload) {
    const raw =
      payload?.demandas ??
      payload?.demanda ??
      payload?.itens_demanda ??
      payload?.grade_demanda ??
      payload?.cargas ??
      [];

    const list = Array.isArray(raw) ? raw : [];
    const modListMap = buildModListMap(payload);
    const out = [];

    for (const it of list) {
      const turmaId = toInt(it?.turma_id ?? it?.turmaId, 0);
      const discId = toInt(it?.disciplina_id ?? it?.disciplinaId, 0);
      const carga = toInt(
        it?.aulas_semanais ?? it?.carga ?? it?.carga_semanal ?? it?.qtd ?? it?.quantidade ?? 0,
        0
      );
      if (!turmaId || !discId || carga <= 0) continue;

      const explicitProf = toInt(it?.professor_id ?? it?.professorId, 0);
      if (explicitProf > 0) {
        out.push({
          turma_id: turmaId,
          disciplina_id: discId,
          professor_id: explicitProf,
          aulas_semanais: carga,
          co_professores: [],
        });
        continue;
      }

      const mods = modListMap.get(`${turmaId}|${discId}`) || [];
      if (mods.length === 0) continue;

      if (mods.length === 1) {
        out.push({
          turma_id: turmaId,
          disciplina_id: discId,
          professor_id: mods[0].professor_id,
          aulas_semanais: carga,
          co_professores: [],
        });
      } else {
        const sumAulas = mods.reduce((acc, m) => acc + (m.aulas || 0), 0);
        if (sumAulas > 0 && sumAulas <= carga) {
          let allocated = 0;
          mods.forEach((m, idx) => {
            const qtd = idx === mods.length - 1 ? Math.max(0, carga - allocated) : Math.min(m.aulas || 1, carga - allocated);
            if (qtd > 0) {
              out.push({
                turma_id: turmaId,
                disciplina_id: discId,
                professor_id: m.professor_id,
                aulas_semanais: qtd,
                co_professores: [],
              });
              allocated += qtd;
            }
          });
        } else {
          out.push({
            turma_id: turmaId,
            disciplina_id: discId,
            professor_id: mods[0].professor_id,
            aulas_semanais: carga,
            co_professores: mods.slice(1).map(m => m.professor_id),
          });
        }
      }
    }
    return out;
  }

  function expandDemandasToLessons(
    demandasNorm,
    randomize = false,
    strategy = "default",
    dispoIdx = null,
    diasList = [1, 2, 3, 4, 5],
    periodosPorDia = 6
  ) {
    const lessons = [];
    const profTotalLoad = new Map();
    const profTurmasCount = new Map();

    for (const d of demandasNorm) {
      const pId = d.professor_id;
      const load = d.aulas_restantes !== undefined ? d.aulas_restantes : d.aulas_semanais;
      profTotalLoad.set(pId, (profTotalLoad.get(pId) || 0) + load);
      for (const cp of d.co_professores || []) {
        profTotalLoad.set(cp, (profTotalLoad.get(cp) || 0) + load);
      }
      if (!profTurmasCount.has(pId)) profTurmasCount.set(pId, new Set());
      profTurmasCount.get(pId).add(d.turma_id);
    }

    const profSlackMap = new Map();
    for (const [pId, load] of profTotalLoad.entries()) {
      const avail = countProfessorAvailableSlots(dispoIdx, pId, diasList, periodosPorDia);
      profSlackMap.set(pId, avail - load);
    }

    for (const d of demandasNorm) {
      const count = d.aulas_restantes !== undefined ? d.aulas_restantes : d.aulas_semanais;
      if (count <= 0) continue;

      const coProfs = Array.isArray(d.co_professores) ? d.co_professores : [];
      const pLoad = profTotalLoad.get(d.professor_id) || 0;
      const baseSlack = profSlackMap.get(d.professor_id) ?? 30;
      const pSlack =
        coProfs.length > 0
          ? Math.min(baseSlack, ...coProfs.map(cp => profSlackMap.get(cp) ?? 30)) - 8
          : baseSlack;
      const pTurmas = profTurmasCount.get(d.professor_id)?.size || 1;
      const groupJitter = randomize ? Math.random() * 5.0 : 0;

      for (let i = 0; i < count; i++) {
        let weight = 0;
        const lessonJitter = randomize ? Math.random() * 1.5 : 0;

        if (strategy === "dsatur_slack") {
          weight = (40 - pSlack) * 500 + pTurmas * 80 + count * 15 + groupJitter * 20;
        } else if (strategy === "group_turma") {
          weight = pLoad * 250 + (d.turma_id % 50) * 10 + groupJitter * 10 + count;
        } else if (strategy === "weight_desc") {
          weight = count * 100 + pLoad * 2 + lessonJitter;
        } else if (strategy === "reverse_weight") {
          weight = (20 - count) * 100 + pLoad * 2 + lessonJitter;
        } else if (strategy === "random") {
          weight = Math.random() * 1000;
        } else {
          weight = pLoad * 120 + (35 - pSlack) * 80 + count * 10 + lessonJitter;
        }

        lessons.push({
          turma_id: d.turma_id,
          disciplina_id: d.disciplina_id,
          professor_id: d.professor_id,
          co_professores: coProfs,
          _weight: weight,
        });
      }
    }

    lessons.sort((a, b) => {
      if (b._weight !== a._weight) return b._weight - a._weight;
      if (a.turma_id !== b.turma_id) return a.turma_id - b.turma_id;
      return a.disciplina_id - b.disciplina_id;
    });

    return lessons;
  }

  function initEmptyGridForEntity(diasList, periodosPorDia) {
    const g = {};
    for (const d of diasList) {
      g[d] = {};
      for (let p = 1; p <= periodosPorDia; p++) {
        g[d][p] = null;
      }
    }
    return g;
  }

  function initGradePorTurma(turmaIds, diasList, periodosPorDia) {
    const out = {};
    for (const id of turmaIds) out[id] = initEmptyGridForEntity(diasList, periodosPorDia);
    return out;
  }

  function initGradePorProfessor(profIds, diasList, periodosPorDia) {
    const out = {};
    for (const id of profIds) out[id] = initEmptyGridForEntity(diasList, periodosPorDia);
    return out;
  }

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

  function isPartOfGeminatedMandatoryPair(turmaGrade, dia, periodo, pairGov) {
    if (!pairGov) return false;
    const row = turmaGrade?.[dia] || {};
    const cell = row[periodo];
    if (!cell || !cell.disciplina_id) return false;
    if (periodo > 1 && pairGov.isPairMandatory(periodo - 1)) {
      const left = row[periodo - 1];
      if (left && Number(left.disciplina_id) === Number(cell.disciplina_id)) return true;
    }
    if (periodo < pairGov.periodosPorDia && pairGov.isPairMandatory(periodo)) {
      const right = row[periodo + 1];
      if (right && Number(right.disciplina_id) === Number(cell.disciplina_id)) return true;
    }
    return false;
  }

  /**
   * FASE 0 (Urânia-Engine): Emparelhamento Bipartido Estrutural (Kuhn Augmenting Path)
   * para Pares marcados como 🔒 OBRIGATÓRIO (ex.: #1-#2).
   * Reserva e aloca duplas geminadas nos blocos obrigatórios de todas as turmas e dias
   * ANTES de distribuir as aulas avulsas e os horários restantes (#3..#6).
   */
  function allocateMandatoryPairsPhase({
    demandasAjustadas,
    gradePorTurma,
    gradePorProfessor,
    dispoIdx,
    turmaIds,
    diasList,
    periodosPorDia,
    rc01MaxConsecutivas,
    rc02Cfg,
    regrasGerais,
    turno,
    preferencias = null,
    randomize = false,
    strategy = "dsatur_slack",
  }) {
    const prefDuplas = regrasGerais ? Boolean(regrasGerais.preferencia_aulas_duplas) : true;
    if (!prefDuplas || rc01MaxConsecutivas < 2) return;
    const exclMap = buildExcludentesMap(regrasGerais);

    const pairGov = buildPairGovernanceIndex(regrasGerais, turno, periodosPorDia);
    const mandatoryStarts = pairGov.orderedStarts.filter(p => pairGov.isPairMandatory(p));
    if (mandatoryStarts.length === 0) return;

    const totalGridSlots = diasList.length * periodosPorDia;
    const profTotalPairs = new Map();
    const profExcludedSlots = new Map();
    for (const d of demandasAjustadas) {
      const pId = d.professor_id;
      const pCount = Math.floor((d.aulas_restantes || 0) / 2);
      if (pCount > 0) {
        profTotalPairs.set(pId, (profTotalPairs.get(pId) || 0) + pCount);
      }
      if (!profExcludedSlots.has(pId)) {
        const avail = countProfessorAvailableSlots(dispoIdx, pId, diasList, periodosPorDia);
        profExcludedSlots.set(pId, Math.max(0, totalGridSlots - avail));
      }
    }

    const byTurma = new Map();
    for (const tId of turmaIds) byTurma.set(Number(tId), []);
    for (const d of demandasAjustadas) {
      const tId = Number(d.turma_id);
      if (!byTurma.has(tId)) byTurma.set(tId, []);
      byTurma.get(tId).push(d);
    }

    const diasOrdered = [...diasList];
    if (randomize) {
      for (let i = diasOrdered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = diasOrdered[i];
        diasOrdered[i] = diasOrdered[j];
        diasOrdered[j] = tmp;
      }
    }

    for (const pStart of mandatoryStarts) {
      const pEnd = pStart + 1;
      if (pEnd > periodosPorDia) continue;

      // Evita sobrepor com outro par já preenchido
      for (const dia of diasOrdered) {
        const eligibleTurmas = turmaIds
          .map(Number)
          .filter(tId => {
            const row = gradePorTurma[tId]?.[dia] || {};
            return !row[pStart] && !row[pEnd];
          });

        if (eligibleTurmas.length === 0) continue;

        eligibleTurmas.sort((a, b) => {
          const ca = (byTurma.get(a) || []).filter(d => (d.aulas_restantes || 0) >= 2).length;
          const cb = (byTurma.get(b) || []).filter(d => (d.aulas_restantes || 0) >= 2).length;
          if (ca !== cb) return ca - cb;
          return randomize ? Math.random() - 0.5 : a - b;
        });

        const matchProfToTurma = new Map(); // profId -> { tId, demand }
        const matchTurmaToDemand = new Map(); // tId -> demand

        function canDemandTakeMandatorySlot(tId, d) {
          if ((d.aulas_restantes || 0) < 2) return false;
          if (Array.isArray(d.co_professores) && d.co_professores.length > 0) return false;
          if (getRc02MaxForDisc(rc02Cfg, d.disciplina_id) < 2) return false;
          const pId = d.professor_id;
          if (preferencias?.[pId]?.prefere_aula_unica) return false;
          const tGrade = gradePorTurma[tId];
          if (countDiscInDay(tGrade, dia, d.disciplina_id) > 0) return false;
          const exclSet = exclMap ? exclMap.get(Number(d.disciplina_id)) : null;
          if (exclSet && exclSet.size > 0) {
            const rowDia = tGrade?.[dia] || {};
            for (const c of Object.values(rowDia)) {
              if (c && exclSet.has(Number(c.disciplina_id))) return false;
            }
          }

          if (gradePorProfessor[pId]?.[dia]?.[pStart] || gradePorProfessor[pId]?.[dia]?.[pEnd]) {
            return false;
          }
          if (!professorPode(dispoIdx, pId, dia, pStart) || !professorPode(dispoIdx, pId, dia, pEnd)) {
            return false;
          }
          return true;
        }

        function dfsMatch(tId, visitedProfs) {
          const candidates = (byTurma.get(tId) || [])
            .filter(d => canDemandTakeMandatorySlot(tId, d))
            .sort((a, b) => {
              if (strategy === "scarce_first" || strategy === "dsatur_slack") {
                const excA = (profExcludedSlots.get(a.professor_id) || 0) >= 4 ? 1 : 0;
                const excB = (profExcludedSlots.get(b.professor_id) || 0) >= 4 ? 1 : 0;
                if (excA !== excB) return excB - excA;
              }

              const pa = Math.floor((a.aulas_restantes || 0) / 2);
              const pb = Math.floor((b.aulas_restantes || 0) / 2);
              if (strategy === "scarce_first" || strategy === "reverse_weight") {
                const totA = profTotalPairs.get(a.professor_id) || 0;
                const totB = profTotalPairs.get(b.professor_id) || 0;
                if (totA !== totB) return totA - totB;
              }
              if (pb !== pa) return pb - pa;
              const totA = profTotalPairs.get(a.professor_id) || 0;
              const totB = profTotalPairs.get(b.professor_id) || 0;
              if (totB !== totA) return totB - totA;
              return randomize ? Math.random() - 0.5 : a.disciplina_id - b.disciplina_id;
            });

          for (const d of candidates) {
            const pId = d.professor_id;
            if (visitedProfs.has(pId)) continue;
            visitedProfs.add(pId);

            const holder = matchProfToTurma.get(pId);
            if (!holder || dfsMatch(holder.tId, visitedProfs)) {
              matchProfToTurma.set(pId, { tId, demand: d });
              matchTurmaToDemand.set(tId, d);
              return true;
            }
          }
          return false;
        }

        for (const tId of eligibleTurmas) {
          dfsMatch(tId, new Set());
        }

        for (const [tId, d] of matchTurmaToDemand.entries()) {
          setSlot(gradePorTurma, gradePorProfessor, tId, d.professor_id, dia, pStart, d.disciplina_id, false, d.co_professores);
          setSlot(gradePorTurma, gradePorProfessor, tId, d.professor_id, dia, pEnd, d.disciplina_id, false, d.co_professores);
          d.aulas_restantes = Math.max(0, (d.aulas_restantes || 0) - 2);
          profTotalPairs.set(d.professor_id, Math.max(0, (profTotalPairs.get(d.professor_id) || 1) - 1));
        }
      }
    }
  }

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
    strictPedagogical = true,
  }) {
    const turmaGrade = gradePorTurma[turmaId];
    const profGrade = gradePorProfessor[professorId];
    let best = null;

    for (const dia of diasList) {
      for (let periodo = 1; periodo <= periodosPorDia; periodo++) {
        if (turmaGrade?.[dia]?.[periodo]) continue;
        if (profGrade?.[dia]?.[periodo]) continue;
        if (!professorPode(dispoIdx, professorId, dia, periodo)) continue;

        if (
          !canPlaceDiscInTurmaSlot({
            turmaGrade,
            dia,
            periodo,
            disciplinaId,
            periodosPorDia,
            rc01MaxConsecutivas,
            rc02Cfg,
            regrasGerais,
            strictPedagogical,
          })
        ) {
          continue;
        }

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

  function trySingleSwap(
    gradePorTurma,
    gradePorProfessor,
    dispoIdx,
    turmaId,
    professorId,
    disciplinaId,
    diasList,
    periodosPorDia,
    rc01MaxConsecutivas = 2,
    rc02Cfg = null,
    regrasGerais = null,
    strictPedagogical = true,
    protectMandatoryPairs = false
  ) {
    const turmaGrade = gradePorTurma[turmaId];
    const profGrade = gradePorProfessor[professorId];
    const pairGov = protectMandatoryPairs
      ? buildPairGovernanceIndex(regrasGerais, regrasGerais?._turno, periodosPorDia)
      : null;

    const freeInTurma = [];
    for (const d of diasList) {
      for (let p = 1; p <= periodosPorDia; p++) {
        if (!turmaGrade?.[d]?.[p]) freeInTurma.push({ d, p });
      }
    }
    if (freeInTurma.length === 0) return null;

    const freeForProf = [];
    for (const d of diasList) {
      for (let p = 1; p <= periodosPorDia; p++) {
        if (!profGrade?.[d]?.[p] && professorPode(dispoIdx, professorId, d, p)) {
          freeForProf.push({ d, p });
        }
      }
    }

    for (const cand of freeForProf) {
      const occ = turmaGrade?.[cand.d]?.[cand.p];
      if (!occ || occ.locked || occ.co_professores?.length) continue;
      if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(turmaGrade, cand.d, cand.p, pairGov)) continue;
      const otherProf = occ.professor_id;
      const otherDisc = occ.disciplina_id;
      if (isCellLocked(gradePorTurma, gradePorProfessor, turmaId, otherProf, cand.d, cand.p)) continue;

      for (const empty of freeInTurma) {
        if (!gradePorProfessor[otherProf]?.[empty.d]?.[empty.p]) {
          if (professorPode(dispoIdx, otherProf, empty.d, empty.p)) {
            clearSlot(gradePorTurma, gradePorProfessor, turmaId, otherProf, cand.d, cand.p);
            setSlot(gradePorTurma, gradePorProfessor, turmaId, otherProf, empty.d, empty.p, otherDisc);
            setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, cand.d, cand.p, disciplinaId);

            const validCand = isTurmaDayPedagogicallyValid({
              turmaGrade,
              dia: cand.d,
              periodosPorDia,
              rc01MaxConsecutivas,
              rc02Cfg,
              regrasGerais,
              strictPedagogical,
            });
            const validEmpty =
              empty.d === cand.d ||
              isTurmaDayPedagogicallyValid({
                turmaGrade,
                dia: empty.d,
                periodosPorDia,
                rc01MaxConsecutivas,
                rc02Cfg,
                regrasGerais,
                strictPedagogical,
              });

            if (validCand && validEmpty) {
              return { dia: cand.d, periodo: cand.p };
            }

            // Reverte caso viole regra pedagógica (ex.: aulas separadas no mesmo dia ou excesso no dia)
            clearSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, cand.d, cand.p);
            clearSlot(gradePorTurma, gradePorProfessor, turmaId, otherProf, empty.d, empty.p);
            setSlot(gradePorTurma, gradePorProfessor, turmaId, otherProf, cand.d, cand.p, otherDisc);
          }
        }
      }
    }
    return null;
  }

  function tryDoubleSwap(
    gradePorTurma,
    gradePorProfessor,
    dispoIdx,
    turmaId,
    professorId,
    disciplinaId,
    diasList,
    periodosPorDia,
    rc01MaxConsecutivas = 2,
    rc02Cfg = null,
    regrasGerais = null,
    strictPedagogical = true,
    protectMandatoryPairs = false
  ) {
    const turmaGrade = gradePorTurma[turmaId];
    const profGrade = gradePorProfessor[professorId];
    const pairGov = protectMandatoryPairs
      ? buildPairGovernanceIndex(regrasGerais, regrasGerais?._turno, periodosPorDia)
      : null;

    const freeInTurma = [];
    for (const d of diasList) {
      for (let p = 1; p <= periodosPorDia; p++) {
        if (!turmaGrade?.[d]?.[p]) freeInTurma.push({ d, p });
      }
    }
    if (freeInTurma.length === 0) return null;

    const freeForProf = [];
    for (const d of diasList) {
      for (let p = 1; p <= periodosPorDia; p++) {
        if (!profGrade?.[d]?.[p] && professorPode(dispoIdx, professorId, d, p)) {
          freeForProf.push({ d, p });
        }
      }
    }

    for (const s1 of freeForProf) {
      const occB = turmaGrade?.[s1.d]?.[s1.p];
      if (!occB || occB.locked || occB.co_professores?.length) continue;
      if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(turmaGrade, s1.d, s1.p, pairGov)) continue;
      const profB = occB.professor_id;
      const discB = occB.disciplina_id;
      if (isCellLocked(gradePorTurma, gradePorProfessor, turmaId, profB, s1.d, s1.p)) continue;

      for (const d2 of diasList) {
        for (let p2 = 1; p2 <= periodosPorDia; p2++) {
          if (d2 === s1.d && p2 === s1.p) continue;
          if (gradePorProfessor[profB]?.[d2]?.[p2]) continue;
          if (!professorPode(dispoIdx, profB, d2, p2)) continue;
          if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(turmaGrade, d2, p2, pairGov)) continue;

          const occC = turmaGrade?.[d2]?.[p2];
          if (!occC || occC.locked || occC.co_professores?.length) continue;
          const profC = occC.professor_id;
          const discC = occC.disciplina_id;
          if (profC === profB || profC === professorId) continue;
          if (isCellLocked(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2)) continue;

          for (const s3 of freeInTurma) {
            if (!gradePorProfessor[profC]?.[s3.d]?.[s3.p]) {
              if (professorPode(dispoIdx, profC, s3.d, s3.p)) {
                clearSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2);
                setSlot(gradePorTurma, gradePorProfessor, turmaId, profC, s3.d, s3.p, discC);

                clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, s1.d, s1.p);
                setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2, discB);

                setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p, disciplinaId);

                const daysToCheck = uniq([s1.d, d2, s3.d]);
                let allValid = true;
                for (const dCheck of daysToCheck) {
                  if (
                    !isTurmaDayPedagogicallyValid({
                      turmaGrade,
                      dia: dCheck,
                      periodosPorDia,
                      rc01MaxConsecutivas,
                      rc02Cfg,
                      regrasGerais,
                      strictPedagogical,
                    })
                  ) {
                    allValid = false;
                    break;
                  }
                }

                if (allValid) {
                  return { dia: s1.d, periodo: s1.p };
                }

                // Reverte
                clearSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p);
                clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2);
                clearSlot(gradePorTurma, gradePorProfessor, turmaId, profC, s3.d, s3.p);
                setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, s1.d, s1.p, discB);
                setSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2, discC);
              }
            }
          }
        }
      }
    }
    return null;
  }

  function tryTripleSwap(
    gradePorTurma,
    gradePorProfessor,
    dispoIdx,
    turmaId,
    professorId,
    disciplinaId,
    diasList,
    periodosPorDia,
    rc01MaxConsecutivas = 2,
    rc02Cfg = null,
    regrasGerais = null,
    strictPedagogical = true,
    protectMandatoryPairs = false
  ) {
    const turmaGrade = gradePorTurma[turmaId];
    const profGrade = gradePorProfessor[professorId];
    const pairGov = protectMandatoryPairs
      ? buildPairGovernanceIndex(regrasGerais, regrasGerais?._turno, periodosPorDia)
      : null;

    const freeInTurma = [];
    for (const d of diasList) {
      for (let p = 1; p <= periodosPorDia; p++) {
        if (!turmaGrade?.[d]?.[p]) freeInTurma.push({ d, p });
      }
    }
    if (freeInTurma.length === 0) return null;

    const freeForProf = [];
    for (const d of diasList) {
      for (let p = 1; p <= periodosPorDia; p++) {
        if (!profGrade?.[d]?.[p] && professorPode(dispoIdx, professorId, d, p)) {
          freeForProf.push({ d, p });
        }
      }
    }

    for (const s1 of freeForProf) {
      const occB = turmaGrade?.[s1.d]?.[s1.p];
      if (!occB || occB.locked || occB.co_professores?.length) continue;
      if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(turmaGrade, s1.d, s1.p, pairGov)) continue;
      const profB = occB.professor_id;
      const discB = occB.disciplina_id;
      if (isCellLocked(gradePorTurma, gradePorProfessor, turmaId, profB, s1.d, s1.p)) continue;

      for (const d2 of diasList) {
        for (let p2 = 1; p2 <= periodosPorDia; p2++) {
          if (d2 === s1.d && p2 === s1.p) continue;
          if (gradePorProfessor[profB]?.[d2]?.[p2]) continue;
          if (!professorPode(dispoIdx, profB, d2, p2)) continue;
          if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(turmaGrade, d2, p2, pairGov)) continue;

          const occC = turmaGrade?.[d2]?.[p2];
          if (!occC || occC.locked || occC.co_professores?.length) continue;
          const profC = occC.professor_id;
          const discC = occC.disciplina_id;
          if (profC === profB || profC === professorId) continue;
          if (isCellLocked(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2)) continue;

          for (const d3 of diasList) {
            for (let p3 = 1; p3 <= periodosPorDia; p3++) {
              if ((d3 === s1.d && p3 === s1.p) || (d3 === d2 && p3 === p2)) continue;
              if (gradePorProfessor[profC]?.[d3]?.[p3]) continue;
              if (!professorPode(dispoIdx, profC, d3, p3)) continue;
              if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(turmaGrade, d3, p3, pairGov)) continue;

              const occD = turmaGrade?.[d3]?.[p3];
              if (!occD || occD.locked || occD.co_professores?.length) continue;
              const profD = occD.professor_id;
              const discD = occD.disciplina_id;
              if (profD === profC || profD === profB || profD === professorId) continue;
              if (isCellLocked(gradePorTurma, gradePorProfessor, turmaId, profD, d3, p3)) continue;

              for (const s4 of freeInTurma) {
                if (!gradePorProfessor[profD]?.[s4.d]?.[s4.p]) {
                  if (professorPode(dispoIdx, profD, s4.d, s4.p)) {
                    clearSlot(gradePorTurma, gradePorProfessor, turmaId, profD, d3, p3);
                    setSlot(gradePorTurma, gradePorProfessor, turmaId, profD, s4.d, s4.p, discD);

                    clearSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2);
                    setSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d3, p3, discC);

                    clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, s1.d, s1.p);
                    setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2, discB);

                    setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p, disciplinaId);

                    const daysToCheck = uniq([s1.d, d2, d3, s4.d]);
                    let allValid = true;
                    for (const dCheck of daysToCheck) {
                      if (
                        !isTurmaDayPedagogicallyValid({
                          turmaGrade,
                          dia: dCheck,
                          periodosPorDia,
                          rc01MaxConsecutivas,
                          rc02Cfg,
                          regrasGerais,
                          strictPedagogical,
                        })
                      ) {
                        allValid = false;
                        break;
                      }
                    }

                    if (allValid) {
                      return { dia: s1.d, periodo: s1.p };
                    }

                    // Reverte
                    clearSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p);
                    clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, d2, p2);
                    clearSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d3, p3);
                    clearSlot(gradePorTurma, gradePorProfessor, turmaId, profD, s4.d, s4.p);
                    setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, s1.d, s1.p, discB);
                    setSlot(gradePorTurma, gradePorProfessor, turmaId, profC, d2, p2, discC);
                    setSlot(gradePorTurma, gradePorProfessor, turmaId, profD, d3, p3, discD);
                  }
                }
              }
            }
          }
        }
      }
    }
    return null;
  }

  function tryCrossTurmaKempeChain(
    gradePorTurma,
    gradePorProfessor,
    dispoIdx,
    turmaId,
    professorId,
    disciplinaId,
    diasList,
    periodosPorDia,
    rc01MaxConsecutivas = 2,
    rc02Cfg = null,
    regrasGerais = null,
    strictPedagogical = true,
    protectMandatoryPairs = false
  ) {
    const turmaGrade = gradePorTurma[turmaId];
    const profGrade = gradePorProfessor[professorId];
    const pairGov = protectMandatoryPairs
      ? buildPairGovernanceIndex(regrasGerais, regrasGerais?._turno, periodosPorDia)
      : null;

    const freeInTurma = [];
    const freeForProf = [];

    for (const d of diasList) {
      for (let p = 1; p <= periodosPorDia; p++) {
        if (!turmaGrade?.[d]?.[p]) freeInTurma.push({ d, p });
        if (!profGrade?.[d]?.[p] && professorPode(dispoIdx, professorId, d, p)) {
          freeForProf.push({ d, p });
        }
      }
    }

    if (freeInTurma.length === 0) return null;

    // Caso 1: Turma T está livre em (d1, p1), mas o Professor P está dando aula em outra turma T2 nesse mesmo horário
    for (const s1 of freeInTurma) {
      if (!professorPode(dispoIdx, professorId, s1.d, s1.p)) continue;
      if (
        !canPlaceDiscInTurmaSlot({
          turmaGrade,
          dia: s1.d,
          periodo: s1.p,
          disciplinaId,
          periodosPorDia,
          rc01MaxConsecutivas,
          rc02Cfg,
          regrasGerais,
          strictPedagogical,
        })
      ) {
        continue;
      }

      const conflictCell = profGrade?.[s1.d]?.[s1.p];
      if (!conflictCell || conflictCell.locked || conflictCell.co_docencia) continue;

      const t2Id = conflictCell.turma_id;
      const discInT2 = conflictCell.disciplina_id;
      if (Number(t2Id) === Number(turmaId)) continue;
      if (!gradePorTurma[t2Id]) continue;
      if (isCellLocked(gradePorTurma, gradePorProfessor, t2Id, professorId, s1.d, s1.p)) continue;

      const t2Grade = gradePorTurma[t2Id];
      if (t2Grade?.[s1.d]?.[s1.p]?.co_professores?.length) continue;
      if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(t2Grade, s1.d, s1.p, pairGov)) continue;

      for (const s2 of freeForProf) {
        if (!t2Grade?.[s2.d]?.[s2.p]) {
          clearSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s1.d, s1.p);
          setSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s2.d, s2.p, discInT2);
          setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p, disciplinaId);

          const okT1 = isTurmaDayPedagogicallyValid({
            turmaGrade,
            dia: s1.d,
            periodosPorDia,
            rc01MaxConsecutivas,
            rc02Cfg,
            regrasGerais,
            strictPedagogical,
          });
          const okT2a = isTurmaDayPedagogicallyValid({
            turmaGrade: t2Grade,
            dia: s1.d,
            periodosPorDia,
            rc01MaxConsecutivas,
            rc02Cfg,
            regrasGerais,
            strictPedagogical,
          });
          const okT2b =
            s2.d === s1.d ||
            isTurmaDayPedagogicallyValid({
              turmaGrade: t2Grade,
              dia: s2.d,
              periodosPorDia,
              rc01MaxConsecutivas,
              rc02Cfg,
              regrasGerais,
              strictPedagogical,
            });

          if (okT1 && okT2a && okT2b) {
            return { dia: s1.d, periodo: s1.p };
          }

          clearSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p);
          clearSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s2.d, s2.p);
          setSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s1.d, s1.p, discInT2);
        }
      }

      for (const s2 of freeForProf) {
        const occT2 = t2Grade?.[s2.d]?.[s2.p];
        if (!occT2 || occT2.locked || occT2.co_professores?.length) continue;
        if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(t2Grade, s2.d, s2.p, pairGov)) continue;
        const profQ = occT2.professor_id;
        const discQ = occT2.disciplina_id;
        if (profQ === professorId) continue;
        if (isCellLocked(gradePorTurma, gradePorProfessor, t2Id, profQ, s2.d, s2.p)) continue;

        if (!gradePorProfessor[profQ]?.[s1.d]?.[s1.p] && professorPode(dispoIdx, profQ, s1.d, s1.p)) {
          clearSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s1.d, s1.p);
          clearSlot(gradePorTurma, gradePorProfessor, t2Id, profQ, s2.d, s2.p);
          setSlot(gradePorTurma, gradePorProfessor, t2Id, profQ, s1.d, s1.p, discQ);
          setSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s2.d, s2.p, discInT2);
          setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p, disciplinaId);

          const okT1 = isTurmaDayPedagogicallyValid({
            turmaGrade,
            dia: s1.d,
            periodosPorDia,
            rc01MaxConsecutivas,
            rc02Cfg,
            regrasGerais,
            strictPedagogical,
          });
          const okT2a = isTurmaDayPedagogicallyValid({
            turmaGrade: t2Grade,
            dia: s1.d,
            periodosPorDia,
            rc01MaxConsecutivas,
            rc02Cfg,
            regrasGerais,
            strictPedagogical,
          });
          const okT2b =
            s2.d === s1.d ||
            isTurmaDayPedagogicallyValid({
              turmaGrade: t2Grade,
              dia: s2.d,
              periodosPorDia,
              rc01MaxConsecutivas,
              rc02Cfg,
              regrasGerais,
              strictPedagogical,
            });

          if (okT1 && okT2a && okT2b) {
            return { dia: s1.d, periodo: s1.p };
          }

          clearSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p);
          clearSlot(gradePorTurma, gradePorProfessor, t2Id, profQ, s1.d, s1.p);
          clearSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s2.d, s2.p);
          setSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s1.d, s1.p, discInT2);
          setSlot(gradePorTurma, gradePorProfessor, t2Id, profQ, s2.d, s2.p, discQ);
        }

        for (const d3 of diasList) {
          for (let p3 = 1; p3 <= periodosPorDia; p3++) {
            if (!t2Grade?.[d3]?.[p3] && !gradePorProfessor[profQ]?.[d3]?.[p3]) {
              if (professorPode(dispoIdx, profQ, d3, p3)) {
                clearSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s1.d, s1.p);
                clearSlot(gradePorTurma, gradePorProfessor, t2Id, profQ, s2.d, s2.p);
                setSlot(gradePorTurma, gradePorProfessor, t2Id, profQ, d3, p3, discQ);
                setSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s2.d, s2.p, discInT2);
                setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p, disciplinaId);

                const okT1 = isTurmaDayPedagogicallyValid({
                  turmaGrade,
                  dia: s1.d,
                  periodosPorDia,
                  rc01MaxConsecutivas,
                  rc02Cfg,
                  regrasGerais,
                  strictPedagogical,
                });
                const daysT2 = uniq([s1.d, s2.d, d3]);
                let okT2 = true;
                for (const dCheck of daysT2) {
                  if (
                    !isTurmaDayPedagogicallyValid({
                      turmaGrade: t2Grade,
                      dia: dCheck,
                      periodosPorDia,
                      rc01MaxConsecutivas,
                      rc02Cfg,
                      regrasGerais,
                      strictPedagogical,
                    })
                  ) {
                    okT2 = false;
                    break;
                  }
                }

                if (okT1 && okT2) {
                  return { dia: s1.d, periodo: s1.p };
                }

                clearSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p);
                clearSlot(gradePorTurma, gradePorProfessor, t2Id, profQ, d3, p3);
                clearSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s2.d, s2.p);
                setSlot(gradePorTurma, gradePorProfessor, t2Id, professorId, s1.d, s1.p, discInT2);
                setSlot(gradePorTurma, gradePorProfessor, t2Id, profQ, s2.d, s2.p, discQ);
              }
            }
          }
        }
      }
    }

    // Caso 2: Professor P está livre em s1, Turma T tem profB em s1, e profB quer ir para emptyInT onde está em T3
    for (const s1 of freeForProf) {
      const occT = turmaGrade?.[s1.d]?.[s1.p];
      if (!occT || occT.locked || occT.co_professores?.length) continue;
      if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(turmaGrade, s1.d, s1.p, pairGov)) continue;
      const profB = occT.professor_id;
      const discB = occT.disciplina_id;
      if (isCellLocked(gradePorTurma, gradePorProfessor, turmaId, profB, s1.d, s1.p)) continue;

      for (const emptyT of freeInTurma) {
        if (!professorPode(dispoIdx, profB, emptyT.d, emptyT.p)) continue;
        const conflictB = gradePorProfessor[profB]?.[emptyT.d]?.[emptyT.p];
        if (!conflictB || conflictB.locked || conflictB.co_docencia) continue;

        const t3Id = conflictB.turma_id;
        const discBInT3 = conflictB.disciplina_id;
        if (Number(t3Id) === Number(turmaId)) continue;
        if (!gradePorTurma[t3Id]) continue;
        if (isCellLocked(gradePorTurma, gradePorProfessor, t3Id, profB, emptyT.d, emptyT.p)) continue;

        const t3Grade = gradePorTurma[t3Id];
        if (t3Grade?.[emptyT.d]?.[emptyT.p]?.co_professores?.length) continue;
        if (protectMandatoryPairs && isPartOfGeminatedMandatoryPair(t3Grade, emptyT.d, emptyT.p, pairGov)) continue;

        if (!t3Grade?.[s1.d]?.[s1.p] && professorPode(dispoIdx, profB, s1.d, s1.p)) {
          clearSlot(gradePorTurma, gradePorProfessor, t3Id, profB, emptyT.d, emptyT.p);
          clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, s1.d, s1.p);
          setSlot(gradePorTurma, gradePorProfessor, t3Id, profB, s1.d, s1.p, discBInT3);
          setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, emptyT.d, emptyT.p, discB);
          setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p, disciplinaId);

          const daysT1 = uniq([s1.d, emptyT.d]);
          const daysT3 = uniq([s1.d, emptyT.d]);
          let okAll = true;
          for (const dCheck of daysT1) {
            if (
              !isTurmaDayPedagogicallyValid({
                turmaGrade,
                dia: dCheck,
                periodosPorDia,
                rc01MaxConsecutivas,
                rc02Cfg,
                regrasGerais,
                strictPedagogical,
              })
            ) {
              okAll = false;
              break;
            }
          }
          if (okAll) {
            for (const dCheck of daysT3) {
              if (
                !isTurmaDayPedagogicallyValid({
                  turmaGrade: t3Grade,
                  dia: dCheck,
                  periodosPorDia,
                  rc01MaxConsecutivas,
                  rc02Cfg,
                  regrasGerais,
                  strictPedagogical,
                })
              ) {
                okAll = false;
                break;
              }
            }
          }

          if (okAll) {
            return { dia: s1.d, periodo: s1.p };
          }

          clearSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, s1.d, s1.p);
          clearSlot(gradePorTurma, gradePorProfessor, turmaId, profB, emptyT.d, emptyT.p);
          clearSlot(gradePorTurma, gradePorProfessor, t3Id, profB, s1.d, s1.p);
          setSlot(gradePorTurma, gradePorProfessor, turmaId, profB, s1.d, s1.p, discB);
          setSlot(gradePorTurma, gradePorProfessor, t3Id, profB, emptyT.d, emptyT.p, discBInT3);
        }
      }
    }

    return null;
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
    rc01MaxConsecutivas,
    rc02Cfg,
    regrasGerais,
    turno,
    preferencias,
    coProfessores = null,
    strictPedagogical = true,
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
      rc01MaxConsecutivas,
      rc02Cfg,
      regrasGerais,
      turno,
      preferencias,
      coProfessores,
      strictPedagogical,
    });

    if (best) {
      setSlot(gradePorTurma, gradePorProfessor, turmaId, professorId, best.dia, best.periodo, disciplinaId, false, coProfessores);
      return true;
    }

    if (Array.isArray(coProfessores) && coProfessores.length > 0) {
      return false;
    }

    const pairGov = buildPairGovernanceIndex(regrasGerais, turno, periodosPorDia);
    const hasMandatoryPairs = pairGov.orderedStarts.some(p => pairGov.isPairMandatory(p));
    const protectionPasses = hasMandatoryPairs ? [true, false] : [false];

    for (const protectMandatoryPairs of protectionPasses) {
      if (
        trySingleSwap(
          gradePorTurma,
          gradePorProfessor,
          dispoIdx,
          turmaId,
          professorId,
          disciplinaId,
          diasList,
          periodosPorDia,
          rc01MaxConsecutivas,
          rc02Cfg,
          regrasGerais,
          strictPedagogical,
          protectMandatoryPairs
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
          periodosPorDia,
          rc01MaxConsecutivas,
          rc02Cfg,
          regrasGerais,
          strictPedagogical,
          protectMandatoryPairs
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
          periodosPorDia,
          rc01MaxConsecutivas,
          rc02Cfg,
          regrasGerais,
          strictPedagogical,
          protectMandatoryPairs
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
          periodosPorDia,
          rc01MaxConsecutivas,
          rc02Cfg,
          regrasGerais,
          strictPedagogical,
          protectMandatoryPairs
        )
      ) {
        return true;
      }
    }

    return false;
  }

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
    strictPedagogical = true,
  }) {
    if (!unplacedLessons || unplacedLessons.length === 0) return [];

    let bestTurmaSnap = cloneGradeMap(gradePorTurma);
    let bestProfSnap = cloneGradeMap(gradePorProfessor);
    let bestQueue = unplacedLessons.map(x => ({ ...x }));

    const queue = unplacedLessons.map(x => ({ ...x }));
    const tabuMap = new Map();
    const TABU_TENURE = 7;

    for (let step = 0; step < maxSteps && queue.length > 0; step++) {
      const target = queue.shift();
      const { turma_id: tId, disciplina_id: dId, professor_id: pId, co_professores: coProfs } = target;

      const placedDirect = tryPlaceWithAllOperators({
        gradePorTurma,
        gradePorProfessor,
        dispoIdx,
        diasList,
        periodosPorDia,
        turmaId: tId,
        professorId: pId,
        disciplinaId: dId,
        rc01MaxConsecutivas,
        rc02Cfg,
        regrasGerais,
        turno,
        preferencias,
        coProfessores: coProfs || null,
        strictPedagogical,
      });

      if (placedDirect) {
        if (queue.length < bestQueue.length) {
          bestQueue = queue.map(x => ({ ...x }));
          bestTurmaSnap = cloneGradeMap(gradePorTurma);
          bestProfSnap = cloneGradeMap(gradePorProfessor);
        }
        continue;
      }

      if (Array.isArray(coProfs) && coProfs.length > 0) {
        queue.push(target);
        continue;
      }

      const candidates = [];
      for (const d of diasList) {
        for (let p = 1; p <= periodosPorDia; p++) {
          if (!professorPode(dispoIdx, pId, d, p)) continue;

          if (
            !canPlaceDiscInTurmaSlot({
              turmaGrade: gradePorTurma[tId],
              dia: d,
              periodo: p,
              disciplinaId: dId,
              periodosPorDia,
              rc01MaxConsecutivas,
              rc02Cfg,
              regrasGerais,
              strictPedagogical,
            })
          ) {
            continue;
          }

          const cellT = gradePorTurma[tId]?.[d]?.[p];
          const cellP = gradePorProfessor[pId]?.[d]?.[p];
          if (cellT?.locked || cellP?.locked || cellT?.co_professores?.length || cellP?.co_docencia) continue;

          const tabuKey = `${tId}|${pId}|${d}|${p}`;
          const isTabu = (tabuMap.get(tabuKey) || 0) > step;

          let blockersCount = 0;
          if (cellT) blockersCount++;
          if (cellP && Number(cellP.turma_id) !== Number(tId)) blockersCount++;
          if (blockersCount === 0) continue;

          const cost = (isTabu ? 500 : 0) + blockersCount * 100 + Math.random() * 25;
          candidates.push({ d, p, cellT, cellP, cost });
        }
      }

      if (candidates.length === 0) {
        queue.push(target);
        continue;
      }

      candidates.sort((a, b) => a.cost - b.cost);
      const { d, p, cellT, cellP } = candidates[0];

      const ejected = [];
      if (cellT) {
        const oldProf = cellT.professor_id;
        const oldDisc = cellT.disciplina_id;
        const oldCo = cellT.co_professores || null;
        clearSlot(gradePorTurma, gradePorProfessor, tId, oldProf, d, p);
        tabuMap.set(`${tId}|${oldProf}|${d}|${p}`, step + TABU_TENURE);
        ejected.push({ turma_id: tId, disciplina_id: oldDisc, professor_id: oldProf, co_professores: oldCo });
      }
      if (cellP && Number(cellP.turma_id) !== Number(tId)) {
        const oldTurma = cellP.turma_id;
        const oldDisc = cellP.disciplina_id;
        const oldCell = gradePorTurma[oldTurma]?.[d]?.[p];
        if (oldCell) {
          const oldCo = oldCell.co_professores || null;
          clearSlot(gradePorTurma, gradePorProfessor, oldTurma, oldCell.professor_id, d, p);
          tabuMap.set(`${oldTurma}|${pId}|${d}|${p}`, step + TABU_TENURE);
          ejected.push({ turma_id: oldTurma, disciplina_id: oldDisc, professor_id: oldCell.professor_id, co_professores: oldCo });
        }
      }

      setSlot(gradePorTurma, gradePorProfessor, tId, pId, d, p, dId, false, coProfs || null);
      tabuMap.set(`${tId}|${pId}|${d}|${p}`, step + TABU_TENURE);

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
          rc01MaxConsecutivas,
          rc02Cfg,
          regrasGerais,
          turno,
          preferencias,
          coProfessores: ej.co_professores || null,
          strictPedagogical,
        });
        if (!okEj) queue.push(ej);
      }

      if (queue.length < bestQueue.length) {
        bestQueue = queue.map(x => ({ ...x }));
        bestTurmaSnap = cloneGradeMap(gradePorTurma);
        bestProfSnap = cloneGradeMap(gradePorProfessor);
        if (bestQueue.length === 0) break;
      }
    }

    for (const k of Object.keys(gradePorTurma)) delete gradePorTurma[k];
    for (const [k, v] of Object.entries(bestTurmaSnap)) gradePorTurma[k] = v;

    for (const k of Object.keys(gradePorProfessor)) delete gradePorProfessor[k];
    for (const [k, v] of Object.entries(bestProfSnap)) gradePorProfessor[k] = v;

    return bestQueue;
  }

  function inferirMotivoNaoAlocacao({
    turmaGrade,
    profGrade,
    dispoIdx,
    professorId,
    periodosPorDia,
    diasList,
  }) {
    let livresTurma = 0;
    let livresProf = 0;
    let livresDispo = 0;

    for (const dia of diasList) {
      for (let periodo = 1; periodo <= periodosPorDia; periodo++) {
        if (!turmaGrade?.[dia]?.[periodo]) {
          livresTurma++;
          if (!profGrade?.[dia]?.[periodo]) {
            livresProf++;
            if (professorPode(dispoIdx, professorId, dia, periodo)) livresDispo++;
          }
        }
      }
    }

    if (livresTurma === 0) return "SEM_SLOT_LIVRE_TURMA";
    if (livresProf === 0) return "COLISAO_PROFESSOR";
    if (livresDispo === 0) return "SEM_DISPONIBILIDADE_PROFESSOR";
    return "OUTRO";
  }

  function validateAndCleanGrade(gradePorTurma, gradePorProfessor, demandasNorm) {
    const demandLookup = new Map();
    for (const d of demandasNorm) {
      const k = `${d.turma_id}|${d.disciplina_id}|${d.professor_id}`;
      demandLookup.set(k, (demandLookup.get(k) || 0) + d.aulas_semanais);
    }

    const allocatedCount = new Map();
    for (const [turmaIdStr, diasObj] of Object.entries(gradePorTurma)) {
      const turmaId = toInt(turmaIdStr, 0);
      for (const [diaStr, perObj] of Object.entries(diasObj)) {
        const dia = toInt(diaStr, 0);
        for (const [perStr, cell] of Object.entries(perObj)) {
          if (!cell) continue;
          const per = toInt(perStr, 0);
          const discId = toInt(cell.disciplina_id, 0);
          const profId = toInt(cell.professor_id, 0);
          const k = `${turmaId}|${discId}|${profId}`;
          const maxAllowed = demandLookup.get(k) || 0;
          const current = allocatedCount.get(k) || 0;

          if (cell.locked) {
            allocatedCount.set(k, current + 1);
            continue;
          }

          if (maxAllowed === 0 || current >= maxAllowed) {
            gradePorTurma[turmaId][dia][per] = null;
            if (gradePorProfessor[profId]?.[dia]) gradePorProfessor[profId][dia][per] = null;
          } else {
            allocatedCount.set(k, current + 1);
          }
        }
      }
    }
  }

  function polishGradePedagogica({
    gradePorTurma,
    gradePorProfessor,
    dispoIdx,
    diasList,
    periodosPorDia,
    rc01MaxConsecutivas,
    rc02Cfg,
    regrasGerais,
    preferencias = null,
  }) {
    const prefDuplas = regrasGerais ? Boolean(regrasGerais.preferencia_aulas_duplas) : true;
    const pairGov = buildPairGovernanceIndex(regrasGerais, regrasGerais?._turno, periodosPorDia);

    for (const [tIdStr, turmaGrade] of Object.entries(gradePorTurma)) {
      const tId = toInt(tIdStr, 0);
      if (!tId || !turmaGrade) continue;

      // 1) Compactação intra-dia: se por qualquer motivo houver 2 aulas da mesma disciplina no mesmo dia separadas,
      // tenta permutar dentro do próprio dia para colá-las como aula dupla (respeitando bloqueio de recreio/pares)
      for (const d of diasList) {
        const row = turmaGrade[d] || {};
        for (let p1 = 1; p1 <= periodosPorDia; p1++) {
          const c1 = row[p1];
          if (!c1 || c1.locked || c1.co_professores?.length) continue;
          for (let p2 = p1 + 2; p2 <= periodosPorDia; p2++) {
            const c2 = row[p2];
            if (!c2 || c2.locked || c2.co_professores?.length) continue;
            if (Number(c1.disciplina_id) !== Number(c2.disciplina_id)) continue;

            const targets = [
              { moveFrom: p2, swapWith: p1 + 1, pairStart: p1 },
              { moveFrom: p1, swapWith: p2 - 1, pairStart: p2 - 1 },
            ].filter(t => !pairGov.isPairBlocked(t.pairStart));

            for (const { moveFrom, swapWith } of targets) {
              const cellMove = row[moveFrom];
              const cellNeighbor = row[swapWith];
              if (!cellMove || !cellNeighbor || cellNeighbor.locked || cellNeighbor.co_professores?.length) continue;

              const profM = cellMove.professor_id;
              const discM = cellMove.disciplina_id;
              const profN = cellNeighbor.professor_id;
              const discN = cellNeighbor.disciplina_id;

              if (
                !gradePorProfessor[profM]?.[d]?.[swapWith] &&
                professorPode(dispoIdx, profM, d, swapWith) &&
                !gradePorProfessor[profN]?.[d]?.[moveFrom] &&
                professorPode(dispoIdx, profN, d, moveFrom)
              ) {
                clearSlot(gradePorTurma, gradePorProfessor, tId, profM, d, moveFrom);
                clearSlot(gradePorTurma, gradePorProfessor, tId, profN, d, swapWith);
                setSlot(gradePorTurma, gradePorProfessor, tId, profM, d, swapWith, discM);
                setSlot(gradePorTurma, gradePorProfessor, tId, profN, d, moveFrom, discN);

                const okIntra = isTurmaDayPedagogicallyValid({
                  turmaGrade,
                  dia: d,
                  periodosPorDia,
                  rc01MaxConsecutivas,
                  rc02Cfg,
                  regrasGerais,
                  strictPedagogical: true,
                });
                if (okIntra) {
                  break;
                }
                clearSlot(gradePorTurma, gradePorProfessor, tId, profM, d, swapWith);
                clearSlot(gradePorTurma, gradePorProfessor, tId, profN, d, moveFrom);
                setSlot(gradePorTurma, gradePorProfessor, tId, profM, d, moveFrom, discM);
                setSlot(gradePorTurma, gradePorProfessor, tId, profN, d, swapWith, discN);
              }
            }
          }
        }
      }

      // 2) Polimento de Geminação entre dias: se preferencia_aulas_duplas estiver ativa,
      // percorre os pares na ORDEM DE PRIORIDADE da escola (#1-#2, #4-#5, etc.) para formar duplas nos blocos preferidos
      if (prefDuplas) {
        const candidatePeriodsOrder = [];
        for (const ini of pairGov.orderedStarts) {
          if (pairGov.isPairBlocked(ini)) continue;
          if (!candidatePeriodsOrder.includes(ini)) candidatePeriodsOrder.push(ini);
          if (!candidatePeriodsOrder.includes(ini + 1)) candidatePeriodsOrder.push(ini + 1);
        }
        for (let p = 1; p <= periodosPorDia; p++) {
          if (!candidatePeriodsOrder.includes(p)) candidatePeriodsOrder.push(p);
        }

        for (const d1 of diasList) {
          for (const p1 of candidatePeriodsOrder) {
            const c1 = turmaGrade[d1]?.[p1];
            if (!c1 || c1.locked || c1.co_professores?.length) continue;
            if (preferencias?.[c1.professor_id]?.prefere_aula_unica) continue;
            if (countDiscInDay(turmaGrade, d1, c1.disciplina_id) !== 1) continue;

            const adjCandidates = [p1 - 1, p1 + 1]
              .filter(pAdj => {
                if (pAdj < 1 || pAdj > periodosPorDia) return false;
                const pStart = Math.min(p1, pAdj);
                return !pairGov.isPairBlocked(pStart);
              })
              .sort((a, b) => {
                const infoA = pairGov.getPairInfo(Math.min(p1, a));
                const infoB = pairGov.getPairInfo(Math.min(p1, b));
                return (infoB?.qualityWeight || 0) - (infoA?.qualityWeight || 0);
              });

            for (const pAdj of adjCandidates) {
              const cAdj = turmaGrade[d1]?.[pAdj];
              if (!cAdj || cAdj.locked || cAdj.co_professores?.length) continue;
              if (Number(cAdj.disciplina_id) === Number(c1.disciplina_id)) continue;
              if (countDiscInDay(turmaGrade, d1, cAdj.disciplina_id) > 1) continue;

              let paired = false;
              for (const d2 of diasList) {
                if (d2 === d1) continue;
                if (countDiscInDay(turmaGrade, d2, c1.disciplina_id) !== 1) continue;

                for (let p2 = 1; p2 <= periodosPorDia; p2++) {
                  const c2 = turmaGrade[d2]?.[p2];
                  if (!c2 || c2.locked || c2.co_professores?.length) continue;
                  if (Number(c2.disciplina_id) !== Number(c1.disciplina_id)) continue;

                  const prof1 = c2.professor_id;
                  const disc1 = c2.disciplina_id;
                  const profAdj = cAdj.professor_id;
                  const discAdj = cAdj.disciplina_id;

                  if (
                    !gradePorProfessor[prof1]?.[d1]?.[pAdj] &&
                    professorPode(dispoIdx, prof1, d1, pAdj) &&
                    !gradePorProfessor[profAdj]?.[d2]?.[p2] &&
                    professorPode(dispoIdx, profAdj, d2, p2)
                  ) {
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profAdj, d1, pAdj);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, prof1, d2, p2);
                    setSlot(gradePorTurma, gradePorProfessor, tId, prof1, d1, pAdj, disc1);
                    setSlot(gradePorTurma, gradePorProfessor, tId, profAdj, d2, p2, discAdj);

                    const okD1 = isTurmaDayPedagogicallyValid({
                      turmaGrade,
                      dia: d1,
                      periodosPorDia,
                      rc01MaxConsecutivas,
                      rc02Cfg,
                      regrasGerais,
                      strictPedagogical: true,
                    });
                    const okD2 = isTurmaDayPedagogicallyValid({
                      turmaGrade,
                      dia: d2,
                      periodosPorDia,
                      rc01MaxConsecutivas,
                      rc02Cfg,
                      regrasGerais,
                      strictPedagogical: true,
                    });

                    if (okD1 && okD2) {
                      paired = true;
                      break;
                    }

                    clearSlot(gradePorTurma, gradePorProfessor, tId, prof1, d1, pAdj);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profAdj, d2, p2);
                    setSlot(gradePorTurma, gradePorProfessor, tId, profAdj, d1, pAdj, discAdj);
                    setSlot(gradePorTurma, gradePorProfessor, tId, prof1, d2, p2, disc1);
                  }
                }
                if (paired) break;
              }
              if (paired) break;
            }
          }
        }

        // 3) Alinhamento Intra-Dia de Prioridade e Obrigatoriedade de Blocos (Ex.: deslizar #2-#3 para #1-#2, ou #5-#6 para #4-#5)
        for (let pass = 0; pass < 2; pass++) {
          for (const d of diasList) {
            const row = turmaGrade[d] || {};

            // 3A) Deslizamento em janela de 3 aulas consecutivas (pA, pA+1, pA+2) trocando apenas as pontas (pA <-> pA+2)
            for (let pA = 1; pA <= periodosPorDia - 2; pA++) {
              const infoLeft = pairGov.getPairInfo(pA);
              const infoRight = pairGov.getPairInfo(pA + 1);
              if (!infoLeft || !infoRight) continue;
              if (infoLeft.modo === "bloqueado" || infoRight.modo === "bloqueado") continue;

              const c1 = row[pA];
              const c2 = row[pA + 1];
              const c3 = row[pA + 2];
              if (!c1 || !c2 || !c3) continue;
              if (c1.locked || c2.locked || c3.locked) continue;
              if (c1.co_professores?.length || c2.co_professores?.length || c3.co_professores?.length) continue;

              const rightIsPair =
                Number(c2.disciplina_id) === Number(c3.disciplina_id) &&
                Number(c1.disciplina_id) !== Number(c2.disciplina_id);
              const leftIsPair =
                Number(c1.disciplina_id) === Number(c2.disciplina_id) &&
                Number(c3.disciplina_id) !== Number(c2.disciplina_id);

              // Se a dupla está em (pA+1, pA+2) mas (pA, pA+1) tem prioridade maior (ex: #1-#2 > #2-#3),
              // ou se a dupla está em (pA, pA+1) mas (pA+1, pA+2) tem prioridade maior:
              // basta permutar pA com pA+2!
              const shouldSlideLeft = rightIsPair && infoLeft.qualityWeight > infoRight.qualityWeight;
              const shouldSlideRight = leftIsPair && infoRight.qualityWeight > infoLeft.qualityWeight;

              if (shouldSlideLeft || shouldSlideRight) {
                const prof1 = c1.professor_id;
                const disc1 = c1.disciplina_id;
                const prof3 = c3.professor_id;
                const disc3 = c3.disciplina_id;

                if (
                  !gradePorProfessor[prof1]?.[d]?.[pA + 2] &&
                  professorPode(dispoIdx, prof1, d, pA + 2) &&
                  !gradePorProfessor[prof3]?.[d]?.[pA] &&
                  professorPode(dispoIdx, prof3, d, pA)
                ) {
                  clearSlot(gradePorTurma, gradePorProfessor, tId, prof1, d, pA);
                  clearSlot(gradePorTurma, gradePorProfessor, tId, prof3, d, pA + 2);
                  setSlot(gradePorTurma, gradePorProfessor, tId, prof3, d, pA, disc3);
                  setSlot(gradePorTurma, gradePorProfessor, tId, prof1, d, pA + 2, disc1);

                  if (
                    !isTurmaDayPedagogicallyValid({
                      turmaGrade,
                      dia: d,
                      periodosPorDia,
                      rc01MaxConsecutivas,
                      rc02Cfg,
                      regrasGerais,
                      strictPedagogical: true,
                    })
                  ) {
                    clearSlot(gradePorTurma, gradePorProfessor, tId, prof3, d, pA);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, prof1, d, pA + 2);
                    setSlot(gradePorTurma, gradePorProfessor, tId, prof1, d, pA, disc1);
                    setSlot(gradePorTurma, gradePorProfessor, tId, prof3, d, pA + 2, disc3);
                  }
                }
              }
            }

            // 3B) Permutação de bloco inteiro de 2 aulas: se um par prioritário/obrigatório (pHigh, pHigh+1)
            // está ocupado por 2 aulas simples diferentes, e outro par de menor prioridade (pLow, pLow+1)
            // no mesmo dia tem uma aula dupla geminada, tenta trocar os dois blocos!
            for (const pHigh of pairGov.orderedStarts) {
              const infoHigh = pairGov.getPairInfo(pHigh);
              if (!infoHigh || infoHigh.modo === "bloqueado") continue;

              const cH1 = row[pHigh];
              const cH2 = row[pHigh + 1];
              if (!cH1 || !cH2 || cH1.locked || cH2.locked) continue;
              if (cH1.co_professores?.length || cH2.co_professores?.length) continue;
              if (Number(cH1.disciplina_id) === Number(cH2.disciplina_id)) continue; // já é dupla!
              if (
                countDiscInDay(turmaGrade, d, cH1.disciplina_id) > 1 ||
                countDiscInDay(turmaGrade, d, cH2.disciplina_id) > 1
              ) {
                continue;
              }

              for (const pLow of [...pairGov.orderedStarts].reverse()) {
                if (Math.abs(pLow - pHigh) < 2) continue; // precisa ser bloco disjunto
                const infoLow = pairGov.getPairInfo(pLow);
                if (!infoLow || infoLow.modo === "bloqueado") continue;
                if (infoHigh.qualityWeight <= infoLow.qualityWeight) continue;

                const cL1 = row[pLow];
                const cL2 = row[pLow + 1];
                if (!cL1 || !cL2 || cL1.locked || cL2.locked) continue;
                if (cL1.co_professores?.length || cL2.co_professores?.length) continue;
                if (Number(cL1.disciplina_id) !== Number(cL2.disciplina_id)) continue; // precisa ser dupla geminada
                if (Number(cL1.professor_id) !== Number(cL2.professor_id)) continue;

                const profD = cL1.professor_id;
                const discD = cL1.disciplina_id;
                const profS1 = cH1.professor_id;
                const discS1 = cH1.disciplina_id;
                const profS2 = cH2.professor_id;
                const discS2 = cH2.disciplina_id;

                const profDCanHigh =
                  !gradePorProfessor[profD]?.[d]?.[pHigh] &&
                  !gradePorProfessor[profD]?.[d]?.[pHigh + 1] &&
                  professorPode(dispoIdx, profD, d, pHigh) &&
                  professorPode(dispoIdx, profD, d, pHigh + 1);

                if (!profDCanHigh) continue;

                // Ordem direta: S1 -> pLow, S2 -> pLow+1 (ou invertida: S1 -> pLow+1, S2 -> pLow)
                const arrangements = [
                  { pForS1: pLow, pForS2: pLow + 1 },
                  { pForS1: pLow + 1, pForS2: pLow },
                ];

                let swappedBlock = false;
                for (const { pForS1, pForS2 } of arrangements) {
                  if (Number(profS1) === Number(profS2)) continue;
                  const s1Ok =
                    !gradePorProfessor[profS1]?.[d]?.[pForS1] &&
                    professorPode(dispoIdx, profS1, d, pForS1);
                  const s2Ok =
                    !gradePorProfessor[profS2]?.[d]?.[pForS2] &&
                    professorPode(dispoIdx, profS2, d, pForS2);

                  if (s1Ok && s2Ok) {
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profS1, d, pHigh);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profS2, d, pHigh + 1);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profD, d, pLow);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profD, d, pLow + 1);

                    setSlot(gradePorTurma, gradePorProfessor, tId, profD, d, pHigh, discD);
                    setSlot(gradePorTurma, gradePorProfessor, tId, profD, d, pHigh + 1, discD);
                    setSlot(gradePorTurma, gradePorProfessor, tId, profS1, d, pForS1, discS1);
                    setSlot(gradePorTurma, gradePorProfessor, tId, profS2, d, pForS2, discS2);

                    if (
                      isTurmaDayPedagogicallyValid({
                        turmaGrade,
                        dia: d,
                        periodosPorDia,
                        rc01MaxConsecutivas,
                        rc02Cfg,
                        regrasGerais,
                        strictPedagogical: true,
                      })
                    ) {
                      swappedBlock = true;
                      break;
                    }

                    // Reverte
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profD, d, pHigh);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profD, d, pHigh + 1);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profS1, d, pForS1);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, profS2, d, pForS2);

                    setSlot(gradePorTurma, gradePorProfessor, tId, profS1, d, pHigh, discS1);
                    setSlot(gradePorTurma, gradePorProfessor, tId, profS2, d, pHigh + 1, discS2);
                    setSlot(gradePorTurma, gradePorProfessor, tId, profD, d, pLow, discD);
                    setSlot(gradePorTurma, gradePorProfessor, tId, profD, d, pLow + 1, discD);
                  }
                }
                if (swappedBlock) break;
              }
            }
          }

          // 3C) Permutação Inter-Dias de Blocos de 2 Aulas: se em um dia d1 o par obrigatório/prioritário (pHigh, pHigh+1)
          // ficou com 2 aulas simples diferentes (S1, S2), e em outro dia d2 da mesma turma há uma aula dupla (D, D)
          // em um par de menor prioridade (pLow, pLow+1), troca os dois blocos de 2 aulas entre d1 e d2!
          for (const d1 of diasList) {
            const row1 = turmaGrade[d1] || {};
            for (const pHigh of pairGov.orderedStarts) {
              const infoHigh = pairGov.getPairInfo(pHigh);
              if (!infoHigh || infoHigh.modo === "bloqueado") continue;

              const cH1 = row1[pHigh];
              const cH2 = row1[pHigh + 1];
              if (!cH1 || !cH2 || cH1.locked || cH2.locked) continue;
              if (cH1.co_professores?.length || cH2.co_professores?.length) continue;
              if (Number(cH1.disciplina_id) === Number(cH2.disciplina_id)) continue;
              if (
                countDiscInDay(turmaGrade, d1, cH1.disciplina_id) > 1 ||
                countDiscInDay(turmaGrade, d1, cH2.disciplina_id) > 1
              ) {
                continue;
              }

              let swappedInterDay = false;
              for (const d2 of diasList) {
                if (d2 === d1) continue;
                const row2 = turmaGrade[d2] || {};

                for (const pLow of [...pairGov.orderedStarts].reverse()) {
                  const infoLow = pairGov.getPairInfo(pLow);
                  if (!infoLow || infoLow.modo === "bloqueado") continue;
                  if (infoHigh.qualityWeight <= infoLow.qualityWeight) continue;

                  const cL1 = row2[pLow];
                  const cL2 = row2[pLow + 1];
                  if (!cL1 || !cL2 || cL1.locked || cL2.locked) continue;
                  if (cL1.co_professores?.length || cL2.co_professores?.length) continue;
                  if (Number(cL1.disciplina_id) !== Number(cL2.disciplina_id)) continue;
                  if (Number(cL1.professor_id) !== Number(cL2.professor_id)) continue;

                  const profD = cL1.professor_id;
                  const discD = cL1.disciplina_id;
                  const profS1 = cH1.professor_id;
                  const discS1 = cH1.disciplina_id;
                  const profS2 = cH2.professor_id;
                  const discS2 = cH2.disciplina_id;
                  if (Number(profS1) === Number(profS2)) continue;

                  if (countDiscInDay(turmaGrade, d1, discD) > 0) continue;
                  if (
                    countDiscInDay(turmaGrade, d2, discS1) > 0 ||
                    countDiscInDay(turmaGrade, d2, discS2) > 0
                  ) {
                    continue;
                  }

                  const profDCanD1 =
                    !gradePorProfessor[profD]?.[d1]?.[pHigh] &&
                    !gradePorProfessor[profD]?.[d1]?.[pHigh + 1] &&
                    professorPode(dispoIdx, profD, d1, pHigh) &&
                    professorPode(dispoIdx, profD, d1, pHigh + 1);
                  if (!profDCanD1) continue;

                  const arrangements = [
                    { pForS1: pLow, pForS2: pLow + 1 },
                    { pForS1: pLow + 1, pForS2: pLow },
                  ];

                  for (const { pForS1, pForS2 } of arrangements) {
                    const s1CanD2 =
                      !gradePorProfessor[profS1]?.[d2]?.[pForS1] &&
                      professorPode(dispoIdx, profS1, d2, pForS1);
                    const s2CanD2 =
                      !gradePorProfessor[profS2]?.[d2]?.[pForS2] &&
                      professorPode(dispoIdx, profS2, d2, pForS2);

                    if (s1CanD2 && s2CanD2) {
                      clearSlot(gradePorTurma, gradePorProfessor, tId, profS1, d1, pHigh);
                      clearSlot(gradePorTurma, gradePorProfessor, tId, profS2, d1, pHigh + 1);
                      clearSlot(gradePorTurma, gradePorProfessor, tId, profD, d2, pLow);
                      clearSlot(gradePorTurma, gradePorProfessor, tId, profD, d2, pLow + 1);

                      setSlot(gradePorTurma, gradePorProfessor, tId, profD, d1, pHigh, discD);
                      setSlot(gradePorTurma, gradePorProfessor, tId, profD, d1, pHigh + 1, discD);
                      setSlot(gradePorTurma, gradePorProfessor, tId, profS1, d2, pForS1, discS1);
                      setSlot(gradePorTurma, gradePorProfessor, tId, profS2, d2, pForS2, discS2);

                      const okD1 = isTurmaDayPedagogicallyValid({
                        turmaGrade,
                        dia: d1,
                        periodosPorDia,
                        rc01MaxConsecutivas,
                        rc02Cfg,
                        regrasGerais,
                        strictPedagogical: true,
                      });
                      const okD2 = isTurmaDayPedagogicallyValid({
                        turmaGrade,
                        dia: d2,
                        periodosPorDia,
                        rc01MaxConsecutivas,
                        rc02Cfg,
                        regrasGerais,
                        strictPedagogical: true,
                      });

                      if (okD1 && okD2) {
                        swappedInterDay = true;
                        break;
                      }

                      // Reverte
                      clearSlot(gradePorTurma, gradePorProfessor, tId, profD, d1, pHigh);
                      clearSlot(gradePorTurma, gradePorProfessor, tId, profD, d1, pHigh + 1);
                      clearSlot(gradePorTurma, gradePorProfessor, tId, profS1, d2, pForS1);
                      clearSlot(gradePorTurma, gradePorProfessor, tId, profS2, d2, pForS2);

                      setSlot(gradePorTurma, gradePorProfessor, tId, profS1, d1, pHigh, discS1);
                      setSlot(gradePorTurma, gradePorProfessor, tId, profS2, d1, pHigh + 1, discS2);
                      setSlot(gradePorTurma, gradePorProfessor, tId, profD, d2, pLow, discD);
                      setSlot(gradePorTurma, gradePorProfessor, tId, profD, d2, pLow + 1, discD);
                    }
                  }
                  if (swappedInterDay) break;
                }
                if (swappedInterDay) break;
              }
            }
          }
        }
      }
    }
  }

  function sanitizePedagogicalViolations({
    gradePorTurma,
    gradePorProfessor,
    dispoIdx,
    diasList,
    periodosPorDia,
    rc01MaxConsecutivas,
    rc02Cfg,
    regrasGerais,
    turno,
    preferencias,
    unplaced,
  }) {
    const proibirSeparadas = regrasGerais ? regrasGerais.proibir_aulas_separadas_mesmo_dia !== false : true;
    const pairGov = buildPairGovernanceIndex(regrasGerais, turno, periodosPorDia);
    const evicted = [];

    for (const [tIdStr, turmaGrade] of Object.entries(gradePorTurma)) {
      const tId = toInt(tIdStr, 0);
      if (!tId || !turmaGrade) continue;

      for (const d of diasList) {
        const row = turmaGrade[d] || {};
        const byDisc = new Map();

        for (let p = 1; p <= periodosPorDia; p++) {
          const cell = row[p];
          if (!cell || !cell.disciplina_id) continue;
          // HIERARQUIA SOBERANA: Aulas fixadas manualmente (cell.locked) JAMAIS são removidas;
          // apenas aulas móveis do solver respeitam obrigatoriamente o bloqueio de disponibilidade
          if (!cell.locked && !professorPode(dispoIdx, cell.professor_id, d, p)) {
            clearSlot(gradePorTurma, gradePorProfessor, tId, cell.professor_id, d, p);
            evicted.push({
              turma_id: tId,
              disciplina_id: Number(cell.disciplina_id),
              professor_id: cell.professor_id,
              co_professores: cell.co_professores || null,
            });
            continue;
          }
          const dId = Number(cell.disciplina_id);
          if (!byDisc.has(dId)) byDisc.set(dId, []);
          byDisc.get(dId).push({ p, cell });
        }

        // 0) Se houver par de disciplinas excludentes no mesmo dia (e pelo menos uma não estiver travada), realoca a não-travada
        const exclMap = buildExcludentesMap(regrasGerais);
        if (exclMap && exclMap.size > 0) {
          const presentDiscs = Array.from(byDisc.keys());
          for (let i = 0; i < presentDiscs.length; i++) {
            const dA = presentDiscs[i];
            const setA = exclMap.get(dA);
            if (!setA) continue;
            for (let j = i + 1; j < presentDiscs.length; j++) {
              const dB = presentDiscs[j];
              if (!setA.has(dB)) continue;
              const listB = byDisc.get(dB) || [];
              const listA = byDisc.get(dA) || [];
              const targetList = listB.some(x => !x.cell.locked) ? listB : listA.some(x => !x.cell.locked) ? listA : null;
              const targetDisc = targetList === listB ? dB : dA;
              if (targetList) {
                for (let k = targetList.length - 1; k >= 0; k--) {
                  if (!targetList[k].cell.locked) {
                    const [rem] = targetList.splice(k, 1);
                    clearSlot(gradePorTurma, gradePorProfessor, tId, rem.cell.professor_id, d, rem.p);
                    evicted.push({
                      turma_id: tId,
                      disciplina_id: targetDisc,
                      professor_id: rem.cell.professor_id,
                      co_professores: rem.cell.co_professores || null,
                    });
                  }
                }
              }
            }
          }
        }

        for (const [dId, list] of byDisc.entries()) {
          if (list.length <= 1) continue;
          const maxDia = Math.min(getRc02MaxForDisc(rc02Cfg, dId), rc01MaxConsecutivas);

          // 1) Se exceder o máximo diário (ex: 3 aulas no mesmo dia), remove as excedentes não-travadas
          while (list.length > maxDia) {
            const idx = list.findLastIndex(x => !x.cell.locked);
            if (idx === -1) break;
            const [rem] = list.splice(idx, 1);
            clearSlot(gradePorTurma, gradePorProfessor, tId, rem.cell.professor_id, d, rem.p);
            evicted.push({
              turma_id: tId,
              disciplina_id: dId,
              professor_id: rem.cell.professor_id,
              co_professores: rem.cell.co_professores || null,
            });
          }

          // 2) Se restarem 2+ aulas separadas no mesmo dia OU em um par bloqueado (ex.: #3-#4 cortando o recreio),
          // remove a última não-travada para realocar
          if (list.length >= 2) {
            const minP = list[0].p;
            const maxP = list[list.length - 1].p;
            const isSeparated = proibirSeparadas && maxP - minP + 1 !== list.length;
            let crossesBlockedPair = false;
            for (let p = minP; p < maxP; p++) {
              if (pairGov.isPairBlocked(p)) {
                crossesBlockedPair = true;
                break;
              }
            }

            if (isSeparated || crossesBlockedPair) {
              const idx = list.findLastIndex(x => !x.cell.locked);
              if (idx !== -1) {
                const [rem] = list.splice(idx, 1);
                clearSlot(gradePorTurma, gradePorProfessor, tId, rem.cell.professor_id, d, rem.p);
                evicted.push({
                  turma_id: tId,
                  disciplina_id: dId,
                  professor_id: rem.cell.professor_id,
                  co_professores: rem.cell.co_professores || null,
                });
              }
            }
          }
        }
      }
    }

    for (const ev of evicted) {
      const ok = tryPlaceWithAllOperators({
        gradePorTurma,
        gradePorProfessor,
        dispoIdx,
        diasList,
        periodosPorDia,
        turmaId: ev.turma_id,
        professorId: ev.professor_id,
        disciplinaId: ev.disciplina_id,
        rc01MaxConsecutivas,
        rc02Cfg,
        regrasGerais,
        turno,
        preferencias,
        coProfessores: ev.co_professores,
        strictPedagogical: true,
      });
      if (!ok) {
        unplaced.push(ev);
      }
    }

    if (evicted.length > 0) {
      polishGradePedagogica({
        gradePorTurma,
        gradePorProfessor,
        dispoIdx,
        diasList,
        periodosPorDia,
        rc01MaxConsecutivas,
        rc02Cfg,
        regrasGerais,
        preferencias,
      });
    }
  }

  function evaluateGradePedagogicalQuality(
    gradePorTurma,
    diasList,
    periodosPorDia,
    rc01MaxConsecutivas,
    rc02Cfg,
    regrasGerais = null,
    turno = "matutino",
    dispoIdx = null
  ) {
    let violacoesSeparadasMesmoDia = 0;
    let violacoesMaxDia = 0;
    let violacoesParesBloqueados = 0;
    let violacoesIndisponibilidade = 0;
    let violacoesDisciplinasExcludentes = 0;
    let paresGeminados = 0;
    let scorePrioridadePares = 0;
    let paresObrigatoriosMeta = 0;
    let paresObrigatoriosAtendidos = 0;
    let paresObrigatoriosIsentosManual = 0;

    const pairGov = buildPairGovernanceIndex(regrasGerais, turno, periodosPorDia);
    const exclMap = buildExcludentesMap(regrasGerais);
    const mandatoryStarts = pairGov.orderedStarts.filter(p => pairGov.isPairMandatory(p));
    const turmaEntries = Object.entries(gradePorTurma || {}).filter(([, g]) => Boolean(g));
    const divergenciasParesObrigatorios = [];

    for (const [tIdStr, turmaGrade] of turmaEntries) {
      const tId = toInt(tIdStr, 0);
      for (const d of diasList) {
        const row = turmaGrade[d] || {};
        const byDisc = new Map();

        for (const pOb of mandatoryStarts) {
          const cOb1 = row[pOb];
          const cOb2 = row[pOb + 1];
          const isGeminatedOb =
            cOb1 &&
            cOb2 &&
            cOb1.disciplina_id &&
            Number(cOb1.disciplina_id) === Number(cOb2.disciplina_id);

          if (isGeminatedOb) {
            paresObrigatoriosMeta++;
            paresObrigatoriosAtendidos++;
          } else if (cOb1?.locked || cOb2?.locked) {
            // Hierarquia Soberana: marcação manual prevalece sobre par obrigatório sem gerar pendência
            paresObrigatoriosIsentosManual++;
          } else {
            paresObrigatoriosMeta++;
            divergenciasParesObrigatorios.push({
              turma_id: tId,
              dia: Number(d),
              inicio: pOb,
              fim: pOb + 1,
              disc_inicio: cOb1?.disciplina_id ? Number(cOb1.disciplina_id) : null,
              prof_inicio: cOb1?.professor_id ? Number(cOb1.professor_id) : null,
              disc_fim: cOb2?.disciplina_id ? Number(cOb2.disciplina_id) : null,
              prof_fim: cOb2?.professor_id ? Number(cOb2.professor_id) : null,
            });
          }
        }

        for (let p = 1; p <= periodosPorDia; p++) {
          const cell = row[p];
          if (!cell || !cell.disciplina_id) continue;
          const dId = Number(cell.disciplina_id);

          if (!cell.locked && dispoIdx && !professorPode(dispoIdx, cell.professor_id, d, p)) {
            violacoesIndisponibilidade++;
          }

          if (p < periodosPorDia) {
            const nextCell = row[p + 1];
            if (nextCell && Number(nextCell.disciplina_id) === dId) {
              paresGeminados++;
              const pInfo = pairGov.getPairInfo(p);
              if (pInfo) {
                scorePrioridadePares += pInfo.qualityWeight || 0;
                if (pInfo.modo === "bloqueado" && (!cell.locked || !nextCell.locked)) {
                  violacoesParesBloqueados++;
                }
              }
            }
          }

          let st = byDisc.get(dId);
          if (!st) {
            st = { count: 0, minP: p, maxP: p, allLocked: true };
            byDisc.set(dId, st);
          }
          st.count++;
          if (p < st.minP) st.minP = p;
          if (p > st.maxP) st.maxP = p;
          if (!cell.locked) st.allLocked = false;
        }

        for (const [dId, st] of byDisc.entries()) {
          if (st.count <= 1 || st.allLocked) continue;
          if (st.maxP - st.minP + 1 !== st.count) {
            violacoesSeparadasMesmoDia++;
          }
          const maxDia = getRc02MaxForDisc(rc02Cfg, dId);
          if (st.count > maxDia || st.count > rc01MaxConsecutivas) {
            violacoesMaxDia++;
          }
        }

        if (exclMap && exclMap.size > 0) {
          const discIds = Array.from(byDisc.keys());
          for (let i = 0; i < discIds.length; i++) {
            const dA = discIds[i];
            const setA = exclMap.get(dA);
            if (!setA) continue;
            for (let j = i + 1; j < discIds.length; j++) {
              const dB = discIds[j];
              if (setA.has(dB)) {
                const stA = byDisc.get(dA);
                const stB = byDisc.get(dB);
                if (!(stA?.allLocked && stB?.allLocked)) {
                  violacoesDisciplinasExcludentes++;
                }
              }
            }
          }
        }
      }
    }

    const paresObrigatoriosFaltantes = Math.max(0, paresObrigatoriosMeta - paresObrigatoriosAtendidos);

    return {
      violacoesSeparadasMesmoDia,
      violacoesMaxDia,
      violacoesParesBloqueados,
      violacoesIndisponibilidade,
      violacoesDisciplinasExcludentes,
      paresGeminados,
      scorePrioridadePares,
      paresObrigatoriosMeta,
      paresObrigatoriosAtendidos,
      paresObrigatoriosIsentosManual,
      paresObrigatoriosFaltantes,
      divergenciasParesObrigatorios,
    };
  }

  function runGreedySolver(payload, randomize = false, strategy = "dsatur_slack") {
    const diasList =
      Array.isArray(payload?.dias_semana) && payload.dias_semana.length > 0
        ? payload.dias_semana.map(Number).filter(n => n >= 1 && n <= 6)
        : [1, 2, 3, 4, 5];

    const periodosPorDia = clamp(toInt(payload?.periodos_por_dia, 6), 1, 10);
    const configPedagogica = payload?.config_pedagogica || payload?.configPedagogica || null;

    const rc01MaxConsecutivas = readRc01MaxConsecutivas(configPedagogica);
    const rc02Cfg = readRc02Config(configPedagogica);
    const turno = payload?.turno || "matutino";
    const rawRegrasGerais = configPedagogica?.regras_gerais || null;
    const pairGov = buildPairGovernanceIndex(rawRegrasGerais, turno, periodosPorDia);
    const exclMapRoot = buildExcludentesMap(rawRegrasGerais);
    const regrasGerais = rawRegrasGerais
      ? { ...rawRegrasGerais, _turno: turno, _pairGov: pairGov, _excludentesMap: exclMapRoot }
      : { _turno: turno, _pairGov: pairGov, _excludentesMap: exclMapRoot };

    const turmaIds = normalizeTurmaIds(payload);
    const demandasNorm = normalizeDemandas(payload);
    const dispoIdx = buildDisponibilidadeIndex(payload?.disponibilidades, diasList, periodosPorDia);

    const slotsFixos = Array.isArray(payload?.slots_fixos) ? payload.slots_fixos : [];
    const turmaIdsSet = new Set(turmaIds.map(Number));

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
      // HIERARQUIA SOBERANA: Marcações manuais (slots_fixos) prevalecem sobre Disponibilidade e Reconfigurar!

      if (turmaIdsSet.size === 0 || turmaIdsSet.has(tId)) {
        validFixos.push({ turma_id: tId, disciplina_id: dId, professor_id: pId, dia, ordem: ord });
        const k = `${tId}|${dId}|${pId}`;
        fixosCountMap.set(k, (fixosCountMap.get(k) || 0) + 1);
      } else {
        externalProfFixos.push({ turma_id: tId, disciplina_id: dId, professor_id: pId, dia, ordem: ord });
      }
    }

    const capacidadeFisicaTurma = diasList.length * periodosPorDia;
    const cargaPorTurmaMap = new Map();
    const matchedFixoKeys = new Set();
    const excessosFixados = [];

    const demandasAjustadas = demandasNorm.map(d => {
      const k = `${d.turma_id}|${d.disciplina_id}|${d.professor_id}`;
      matchedFixoKeys.add(k);
      cargaPorTurmaMap.set(d.turma_id, (cargaPorTurmaMap.get(d.turma_id) || 0) + d.aulas_semanais);
      const jaFixadas = fixosCountMap.get(k) || 0;
      if (jaFixadas > d.aulas_semanais) {
        excessosFixados.push({
          turma_id: d.turma_id,
          disciplina_id: d.disciplina_id,
          professor_id: d.professor_id,
          fixadas: jaFixadas,
          previstas: d.aulas_semanais,
          excedente: jaFixadas - d.aulas_semanais,
        });
      }
      return {
        ...d,
        aulas_restantes: Math.max(0, d.aulas_semanais - jaFixadas),
      };
    });

    for (const [k, qtdFixa] of fixosCountMap.entries()) {
      if (matchedFixoKeys.has(k) || qtdFixa <= 0) continue;
      const [tIdStr, dIdStr, pIdStr] = k.split("|");
      excessosFixados.push({
        turma_id: Number(tIdStr),
        disciplina_id: Number(dIdStr),
        professor_id: Number(pIdStr),
        fixadas: qtdFixa,
        previstas: 0,
        excedente: qtdFixa,
      });
    }

    const turmasAcimaCapacidade = [];
    for (const [tId, cargaTot] of cargaPorTurmaMap.entries()) {
      if (cargaTot > capacidadeFisicaTurma) {
        turmasAcimaCapacidade.push({
          turma_id: Number(tId),
          carga_total: cargaTot,
          capacidade_turno: capacidadeFisicaTurma,
          excedente: cargaTot - capacidadeFisicaTurma,
        });
      }
    }

    const allProfIds = uniq([
      ...demandasNorm.map(d => d.professor_id),
      ...demandasNorm.flatMap(d => Array.isArray(d.co_professores) ? d.co_professores : []),
      ...validFixos.map(f => f.professor_id),
      ...externalProfFixos.map(f => f.professor_id),
    ]);

    const gradePorTurma = initGradePorTurma(turmaIds, diasList, periodosPorDia);
    const gradePorProfessor = initGradePorProfessor(allProfIds, diasList, periodosPorDia);

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

    // FASE 0: Emparelhamento Bipartido Estrutural para Pares 🔒 Obrigatórios (ex.: #1-#2)
    allocateMandatoryPairsPhase({
      demandasAjustadas,
      gradePorTurma,
      gradePorProfessor,
      dispoIdx,
      turmaIds,
      diasList,
      periodosPorDia,
      rc01MaxConsecutivas,
      rc02Cfg,
      regrasGerais,
      turno,
      preferencias: payload?.preferencias,
      randomize,
      strategy,
    });

    const lessons = expandDemandasToLessons(
      demandasAjustadas,
      randomize,
      strategy,
      dispoIdx,
      diasList,
      periodosPorDia
    );

    let unplaced = [];
    for (const lesson of lessons) {
      const { turma_id: turmaId, disciplina_id: disciplinaId, professor_id: professorId, co_professores: coProfessores } = lesson;

      if (!gradePorTurma[turmaId]) {
        gradePorTurma[turmaId] = initEmptyGridForEntity(diasList, periodosPorDia);
      }
      if (!gradePorProfessor[professorId]) {
        gradePorProfessor[professorId] = initEmptyGridForEntity(diasList, periodosPorDia);
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
        rc01MaxConsecutivas,
        rc02Cfg,
        regrasGerais,
        turno,
        preferencias: payload?.preferencias,
        coProfessores: coProfessores || null,
        strictPedagogical: true,
      });

      if (!ok) unplaced.push(lesson);
    }

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
        strictPedagogical: true,
      });
    }

    // Polimento pós-alocação para maximizar aulas duplas geminadas na ordem de prioridade da escola
    polishGradePedagogica({
      gradePorTurma,
      gradePorProfessor,
      dispoIdx,
      diasList,
      periodosPorDia,
      rc01MaxConsecutivas,
      rc02Cfg,
      regrasGerais,
      preferencias: payload?.preferencias,
    });

    // Blindagem final inviolável: garante zero aulas separadas no mesmo dia, zero dias acima do limite e zero pares bloqueados (recreio)
    sanitizePedagogicalViolations({
      gradePorTurma,
      gradePorProfessor,
      dispoIdx,
      diasList,
      periodosPorDia,
      rc01MaxConsecutivas,
      rc02Cfg,
      regrasGerais,
      turno,
      preferencias: payload?.preferencias,
      unplaced,
    });

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

    validateAndCleanGrade(gradePorTurma, gradePorProfessor, demandasNorm);

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
    const cobertura = demandaTotal > 0 ? Math.round((totalAlocadasReal / demandaTotal) * 10000) / 100 : 100;

    const qual = evaluateGradePedagogicalQuality(
      gradePorTurma,
      diasList,
      periodosPorDia,
      rc01MaxConsecutivas,
      rc02Cfg,
      regrasGerais,
      turno,
      dispoIdx
    );
    const qualidadeScore =
      totalAlocadasReal * 1000000 -
      qual.violacoesIndisponibilidade * 10000000 -
      qual.violacoesSeparadasMesmoDia * 5000000 -
      qual.violacoesMaxDia * 5000000 -
      qual.violacoesParesBloqueados * 4000000 -
      (qual.violacoesDisciplinasExcludentes || 0) * 3500000 +
      qual.paresObrigatoriosAtendidos * 8500 +
      qual.paresGeminados * 60 +
      qual.scorePrioridadePares;

    return {
      status: unplaced.length === 0 ? "MOCK_FEASIBLE" : "MOCK_PARTIAL",
      metrics: {
        aulas_demanda: demandaTotal,
        aulas_alocadas: totalAlocadasReal,
        aulas_fixas_manuais: alocadasFixas,
        aulas_nao_alocadas: unplaced.length,
        cobertura_percentual: cobertura,
        rc01_max_consecutivas: rc01MaxConsecutivas,
        rc02_modo: rc02Cfg.modo,
        rc02_max_por_dia_padrao: rc02Cfg.maxPadrao,
        rc02_bloqueio_hard: rc02Cfg.bloqueioHard,
        rc02_max_hard_padrao: rc02Cfg.maxHardPadrao,
        rc02_strict_cap_mock: !!rc02Cfg.strictCapMock,
        violacoes_indisponibilidade: qual.violacoesIndisponibilidade,
        violacoes_separadas_mesmo_dia: qual.violacoesSeparadasMesmoDia,
        violacoes_max_dia: qual.violacoesMaxDia,
        violacoes_pares_bloqueados: qual.violacoesParesBloqueados,
        violacoes_disciplinas_excludentes: qual.violacoesDisciplinasExcludentes || 0,
        pares_geminados: qual.paresGeminados,
        pares_obrigatorios_meta: qual.paresObrigatoriosMeta,
        pares_obrigatorios_atendidos: qual.paresObrigatoriosAtendidos,
        pares_obrigatorios_isentos_manual: qual.paresObrigatoriosIsentosManual || 0,
        pares_obrigatorios_faltantes: qual.paresObrigatoriosFaltantes,
        score_prioridade_pares: qual.scorePrioridadePares,
        qualidade_score: qualidadeScore,
      },
      grade_por_turma: gradePorTurma,
      grade_por_professor: gradePorProfessor,
      nao_alocadas: unplaced.map(x => ({
        turma_id: x.turma_id,
        disciplina_id: x.disciplina_id,
        professor_id: x.professor_id,
      })),
      diagnostico: {
        resumo_motivos: diagnosticoContadores,
        nao_alocadas_detalhado: diagnosticoNaoAlocadas,
        divergencias_pares_obrigatorios: qual.divergenciasParesObrigatorios,
        excessos_fixados: excessosFixados,
        turmas_acima_capacidade: turmasAcimaCapacidade,
      },
    };
  }

  // Se estiver executando dentro de um Web Worker
  if (workerScope && typeof workerScope.postMessage === "function") {
    let stopRequested = false;

    workerScope.onmessage = function (ev) {
      const msg = ev.data || {};
      if (msg.type === "stop") {
        stopRequested = true;
        return;
      }

      if (msg.type === "start") {
        stopRequested = false;
        const payload = msg.payload;
        const maxTimeMs = Number(msg.maxTimeMs) || 15000;
        const startTime = Date.now();

        const strategies = [
          "dsatur_slack",
          "group_turma",
          "scarce_first",
          "dsatur_slack",
          "weight_desc",
          "reverse_weight",
          "random",
        ];

        let iter = 0;
        let maxQualidade = -Infinity;
        let bestResult = null;
        let lastProgressAt = 0;
        let cleanPerfectFoundCount = 0;

        function stepBatch() {
          const batchStart = Date.now();

          // Roda em pequenos slices de 45ms para permitir que mensagens 'stop' sejam processadas imediatamente
          while (Date.now() - batchStart < 45) {
            if (stopRequested || Date.now() - startTime >= maxTimeMs) {
              const finalResult = bestResult || runGreedySolver(payload, false, "dsatur_slack");
              workerScope.postMessage({
                type: "done",
                iter,
                elapsedMs: Date.now() - startTime,
                stoppedByUser: stopRequested,
                result: finalResult,
              });
              return;
            }

            const strategy = strategies[iter % strategies.length];
            const isRandomized = iter > 0;
            const res = runGreedySolver(payload, isRandomized, strategy);

            const alocadas = res.metrics.aulas_alocadas || 0;
            const demanda = res.metrics.aulas_demanda || 1;
            const qScore = res.metrics.qualidade_score ?? alocadas * 1000000;

            if (qScore > maxQualidade) {
              maxQualidade = qScore;
              bestResult = res;
            }

            iter++;

            // 100% encontrado sem nenhuma violação pedagógica E atendendo 100% dos pares obrigatórios!
            // Roda até 15 variações rápidas (~80ms) para escolher a grade com mais aulas duplas geminadas
            if (
              alocadas >= demanda &&
              (res.metrics.violacoes_indisponibilidade || 0) === 0 &&
              (res.metrics.violacoes_separadas_mesmo_dia || 0) === 0 &&
              (res.metrics.violacoes_max_dia || 0) === 0 &&
              (res.metrics.violacoes_pares_bloqueados || 0) === 0 &&
              (res.metrics.violacoes_disciplinas_excludentes || 0) === 0 &&
              (res.metrics.pares_obrigatorios_faltantes || 0) === 0
            ) {
              cleanPerfectFoundCount++;
              if (cleanPerfectFoundCount >= 15) {
                workerScope.postMessage({
                  type: "done",
                  iter,
                  elapsedMs: Date.now() - startTime,
                  stoppedByUser: false,
                  perfect: true,
                  strategy,
                  result: bestResult,
                });
                return;
              }
            }

            const now = Date.now();
            if (now - lastProgressAt >= 180) {
              lastProgressAt = now;
              workerScope.postMessage({
                type: "progress",
                iter,
                elapsedMs: now - startTime,
                maxTimeMs,
                strategy,
                alocadas: bestResult?.metrics?.aulas_alocadas || 0,
                demanda: bestResult?.metrics?.aulas_demanda || 0,
                fixas: bestResult?.metrics?.aulas_fixas_manuais || 0,
                cobertura: bestResult?.metrics?.cobertura_percentual || 0,
              });
            }
          }

          setTimeout(stepBatch, 0);
        }

        stepBatch();
      }
    };
  }

  return { runGreedySolver };
}

const localInstance = solverWorkerBootstrap(null);
export const runGreedySolverLocal = localInstance.runGreedySolver;

export const runGreedySolver = runGreedySolverLocal;
export default { runGreedySolver };
