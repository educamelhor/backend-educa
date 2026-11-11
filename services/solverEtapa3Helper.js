// services/solverEtapa3Helper.js
// ============================================================================
// Motor Solver 2.0 — ETAPA 3 (Helpers Compartilhados Backend)
//  1) Pilar 1: Blocos Simultâneos / Super-Aulas de IFA & Turmas Unidas
//  2) Pilar 2: Controle Inter-Turnos & Interjornada (CLT/SEEDF) por CPF
//  3) Pilar 3: Normalização de Recursos Físicos / Salas / Laboratórios / Quadras
//  4) Suporte seguro a múltiplas turmas unidas em `grade_slot` (H2 condicional)
// ============================================================================

const PADRAO_HORARIOS_SEEDF = {
  matutino: [
    { ordem: 1, inicio: "07:15", fim: "08:05" },
    { ordem: 2, inicio: "08:05", fim: "08:55" },
    { ordem: 3, inicio: "08:55", fim: "09:45" },
    { ordem: 4, inicio: "10:00", fim: "10:50" },
    { ordem: 5, inicio: "10:50", fim: "11:40" },
    { ordem: 6, inicio: "11:40", fim: "12:30" },
  ],
  vespertino: [
    { ordem: 1, inicio: "13:00", fim: "13:50" },
    { ordem: 2, inicio: "13:50", fim: "14:40" },
    { ordem: 3, inicio: "14:40", fim: "15:30" },
    { ordem: 4, inicio: "15:45", fim: "16:35" },
    { ordem: 5, inicio: "16:35", fim: "17:25" },
    { ordem: 6, inicio: "17:25", fim: "18:15" },
  ],
  noturno: [
    { ordem: 1, inicio: "19:00", fim: "19:45" },
    { ordem: 2, inicio: "19:45", fim: "20:30" },
    { ordem: 3, inicio: "20:30", fim: "21:15" },
    { ordem: 4, inicio: "21:30", fim: "22:15" },
    { ordem: 5, inicio: "22:15", fim: "23:00" },
    { ordem: 6, inicio: "23:00", fim: "23:45" },
  ],
  integral: [
    { ordem: 1, inicio: "07:30", fim: "08:20" },
    { ordem: 2, inicio: "08:20", fim: "09:10" },
    { ordem: 3, inicio: "09:10", fim: "10:00" },
    { ordem: 4, inicio: "10:20", fim: "11:10" },
    { ordem: 5, inicio: "11:10", fim: "12:00" },
    { ordem: 6, inicio: "13:30", fim: "14:20" },
    { ordem: 7, inicio: "14:20", fim: "15:10" },
    { ordem: 8, inicio: "15:10", fim: "16:00" },
    { ordem: 9, inicio: "16:15", fim: "17:05" },
    { ordem: 10, inicio: "17:05", fim: "17:55" },
  ],
};

export function normTurnoKey(turno) {
  return String(turno || "").trim().toLowerCase();
}

export function normalizarCpfDigitos(cpf) {
  const digits = String(cpf || "").replace(/\D/g, "");
  if (digits.length !== 11) return null;
  if (/^(\d)\1{10}$/.test(digits)) return null;
  return digits;
}

export function mascararCpf(cpf) {
  const d = normalizarCpfDigitos(cpf);
  if (!d) return null;
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

export function normalizarNomePessoa(nome) {
  return String(nome || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hhmmToMinutes(str) {
  const m = String(str || "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 29 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

export function formatMinutesDuration(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h > 0 && r > 0) return `${h}h${String(r).padStart(2, "0")}m`;
  if (h > 0) return `${h}h`;
  return `${r}min`;
}

/**
 * Retorna mapa `{ [ordem]: { ordem, inicio, fim, iniMin, fimMin, fonte } }` para um turno,
 * mesclando `horariosPorTurno` da Governança com fallback realista SEEDF.
 */
export function obterHorariosEfetivosTurno(turno, horariosPorTurno = {}, maxPeriodos = 6) {
  const tKey = normTurnoKey(turno);
  const govMap = horariosPorTurno?.[tKey] || {};
  const padraoLista = PADRAO_HORARIOS_SEEDF[tKey] || PADRAO_HORARIOS_SEEDF.matutino;
  const padraoPorOrdem = {};
  for (const item of padraoLista) {
    padraoPorOrdem[item.ordem] = item;
  }

  const total = Math.max(
    Number(maxPeriodos) || 5,
    ...Object.keys(govMap).map(Number).filter((n) => n > 0),
    5
  );

  const resultado = {};
  let ultimoFimMin = null;
  const duracaoPadrao = tKey === "noturno" ? 45 : 50;

  for (let ord = 1; ord <= total; ord++) {
    const g = govMap[ord] || govMap[String(ord)];
    const p = padraoPorOrdem[ord];

    let inicio = g?.inicio || p?.inicio || null;
    let fim = g?.fim || p?.fim || null;
    let fonte = g?.inicio && g?.fim ? "governanca" : "padrao_seedf";

    let iniMin = hhmmToMinutes(inicio);
    let fimMin = hhmmToMinutes(fim);

    if (iniMin == null || fimMin == null) {
      iniMin = ultimoFimMin != null ? ultimoFimMin : (tKey === "noturno" ? 19 * 60 : tKey === "vespertino" ? 13 * 60 : 7 * 60 + 15);
      fimMin = iniMin + duracaoPadrao;
      const toHHMM = (v) => `${String(Math.floor((v % 1440) / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
      inicio = toHHMM(iniMin);
      fim = toHHMM(fimMin);
      fonte = "estimado";
    }

    if (fimMin <= iniMin) {
      fimMin += 1440;
    }
    ultimoFimMin = fimMin;

    resultado[ord] = {
      ordem: ord,
      inicio,
      fim,
      iniMin,
      fimMin,
      fonte,
    };
  }

  return resultado;
}

/**
 * Normaliza as regras de controle Inter-Turnos / Interjornada por CPF.
 */
export function normalizarRegrasInterturno(regrasGerais = {}) {
  const raw = regrasGerais?.interturno_regras || {};
  const interjornadaHoras =
    raw.interjornada_min_horas !== undefined && raw.interjornada_min_horas !== null
      ? Math.max(0, Number(raw.interjornada_min_horas) || 0)
      : 11;
  const transicaoMin =
    raw.transicao_turno_min_minutos !== undefined && raw.transicao_turno_min_minutos !== null
      ? Math.max(0, Number(raw.transicao_turno_min_minutos) || 0)
      : 30;
  const maxAulasDiaCpf =
    raw.max_aulas_dia_cpf !== undefined && raw.max_aulas_dia_cpf !== null
      ? Math.max(0, Number(raw.max_aulas_dia_cpf) || 0)
      : 12;

  return {
    ativo: raw.ativo !== false,
    interjornada_min_horas: interjornadaHoras,
    interjornada_min_minutos: Math.round(interjornadaHoras * 60),
    interjornada_modo: raw.interjornada_modo === "soft" ? "soft" : "hard",
    transicao_turno_min_minutos: transicaoMin,
    transicao_turno_modo: raw.transicao_turno_modo === "hard" ? "hard" : "soft",
    max_aulas_dia_cpf: maxAulasDiaCpf,
    max_aulas_dia_modo: raw.max_aulas_dia_modo === "soft" ? "soft" : "hard",
  };
}

/**
 * Normaliza a lista de Recursos Físicos / Salas Especiais / Laboratórios / Quadras.
 */
export function normalizarRecursosFisicos(regrasGerais = {}) {
  const lista = Array.isArray(regrasGerais)
    ? regrasGerais
    : Array.isArray(regrasGerais?.recursos_fisicos)
    ? regrasGerais.recursos_fisicos
    : [];
  const out = [];
  for (let i = 0; i < lista.length; i++) {
    const r = lista[i];
    if (!r || r.ativo === false) continue;
    const discIds = Array.isArray(r.disciplina_ids)
      ? Array.from(new Set(r.disciplina_ids.map(Number).filter((n) => n > 0)))
      : [];
    if (discIds.length === 0) continue;
    const cap = Math.max(1, Number(r.capacidade) || 1);
    out.push({
      id: String(r.id || `rec_${i + 1}`),
      nome: String(r.nome || `Espaço Compartilhado ${i + 1}`).trim(),
      icone: String(r.icone || "🏛️").trim(),
      capacidade: cap,
      disciplina_ids: discIds,
      modo: r.modo === "soft" ? "soft" : "hard",
      ativo: true,
    });
  }
  return out;
}

/**
 * Consolida Blocos Simultâneos (Super-Aulas de IFA / Eletivas / Turmas Unidas)
 * unindo `agrupamentos` cadastrados na escola + `regras_gerais.blocos_simultaneos`.
 */
export function buildBlocosSimultaneosConsolidados({
  agrupamentos = [],
  demanda = [],
  modulacao = [],
  turmas = [],
  regrasGerais = {},
  turnoNorm = "",
}) {
  const tKey = normTurnoKey(turnoNorm);
  const turmaIdsTurno = new Set((turmas || []).map((t) => Number(t.id ?? t.turma_id)).filter((n) => n > 0));

  // Índice rápido de demanda e modulação por `${turma_id}-${disciplina_id}`
  const demandaMap = new Map();
  for (const d of demanda || []) {
    const tid = Number(d.turma_id);
    const did = Number(d.disciplina_id);
    const carga = Number(d.carga ?? d.aulas_semanais ?? d.aulas ?? 0);
    if (tid > 0 && did > 0 && carga > 0) {
      demandaMap.set(`${tid}-${did}`, carga);
    }
  }

  const modMap = new Map();
  for (const m of modulacao || []) {
    const tid = Number(m.turma_id);
    const did = Number(m.disciplina_id);
    const pid = Number(m.professor_id);
    if (tid > 0 && did > 0 && pid > 0) {
      modMap.set(`${tid}-${did}`, {
        professor_id: pid,
        aulas: Number(m.aulas) || 0,
      });
    }
  }

  const blocos = [];
  const paresJaAgrupados = new Set();

  // 1) Blocos explícitos configurados pelo gestor em `regras_gerais.blocos_simultaneos`
  const configBlocos = Array.isArray(regrasGerais?.blocos_simultaneos)
    ? regrasGerais.blocos_simultaneos
    : [];

  for (let idx = 0; idx < configBlocos.length; idx++) {
    const b = configBlocos[idx];
    if (!b || b.ativo === false) continue;
    if (b.turno && normTurnoKey(b.turno) !== tKey) continue;

    const permitirMesmoProf = b.permitir_mesmo_prof_simultaneo !== false;
    const itensResolvidos = [];
    const seenPairs = new Set();

    // Suporta tanto `itens: [{ turma_id, disciplina_id }]` quanto `{ turma_ids, disciplina_ids }`
    if (Array.isArray(b.itens) && b.itens.length > 0) {
      for (const it of b.itens) {
        const tid = Number(it?.turma_id);
        const did = Number(it?.disciplina_id);
        if (!tid || !did) continue;
        if (turmaIdsTurno.size > 0 && !turmaIdsTurno.has(tid)) continue;
        const pairKey = `${tid}-${did}`;
        if (seenPairs.has(pairKey)) continue;
        const mod = modMap.get(pairKey);
        const carga = demandaMap.get(pairKey) || mod?.aulas || Number(b.aulas_sincronizadas) || 0;
        const profId = Number(it?.professor_id || mod?.professor_id || 0);
        if (carga > 0 && profId > 0) {
          seenPairs.add(pairKey);
          itensResolvidos.push({
            turma_id: tid,
            disciplina_id: did,
            professor_id: profId,
            aulas_semanais: carga,
          });
        }
      }
    }

    const tIdsCfg = Array.isArray(b.turma_ids) ? b.turma_ids.map(Number).filter((n) => n > 0) : [];
    const dIdsCfg = Array.isArray(b.disciplina_ids) ? b.disciplina_ids.map(Number).filter((n) => n > 0) : [];
    if (tIdsCfg.length >= 2 && dIdsCfg.length >= 1) {
      for (const tid of tIdsCfg) {
        if (turmaIdsTurno.size > 0 && !turmaIdsTurno.has(tid)) continue;
        for (const did of dIdsCfg) {
          const pairKey = `${tid}-${did}`;
          if (seenPairs.has(pairKey)) continue;
          const mod = modMap.get(pairKey);
          const carga = demandaMap.get(pairKey) || mod?.aulas || 0;
          if (carga > 0 && mod?.professor_id > 0) {
            seenPairs.add(pairKey);
            itensResolvidos.push({
              turma_id: tid,
              disciplina_id: did,
              professor_id: mod.professor_id,
              aulas_semanais: carga,
            });
          }
        }
      }
    }

    // Precisa envolver ao menos 2 turmas distintas para ser um bloco simultâneo real
    const turmasDistintas = Array.from(new Set(itensResolvidos.map((i) => i.turma_id)));
    if (turmasDistintas.length < 2) continue;

    // Se numa mesma turma houver 2+ disciplinas na lista, mantém a primeira com maior carga para evitar auto-colisão na turma
    const itemPorTurma = new Map();
    for (const item of itensResolvidos) {
      const atual = itemPorTurma.get(item.turma_id);
      if (!atual || item.aulas_semanais > atual.aulas_semanais) {
        itemPorTurma.set(item.turma_id, item);
      }
    }
    const itensUnicosPorTurma = Array.from(itemPorTurma.values());
    if (itensUnicosPorTurma.length < 2) continue;

    const minCarga = Math.min(...itensUnicosPorTurma.map((i) => i.aulas_semanais));
    const aulasSinc =
      Number(b.aulas_sincronizadas) > 0
        ? Math.min(Number(b.aulas_sincronizadas), minCarga)
        : minCarga;
    if (aulasSinc <= 0) continue;

    for (const it of itensUnicosPorTurma) {
      paresJaAgrupados.add(`${it.turma_id}-${it.disciplina_id}`);
    }

    blocos.push({
      id: String(b.id || `bloco_cfg_${idx + 1}`),
      nome: String(b.nome || `Bloco Simultâneo ${idx + 1}`).trim(),
      tipo: String(b.tipo || "IFA_SIMULTANEO"),
      origem: "config",
      turno: tKey,
      aulas_sincronizadas: aulasSinc,
      permitir_mesmo_prof_simultaneo: permitirMesmoProf,
      modo: b.modo === "soft" ? "soft" : "hard",
      turma_ids: itensUnicosPorTurma.map((i) => i.turma_id),
      disciplina_ids: Array.from(new Set(itensUnicosPorTurma.map((i) => i.disciplina_id))),
      itens: itensUnicosPorTurma,
    });
  }

  // 2) Auto-hidratação a partir da tabela `agrupamentos` (IFA / Eletivas / Projetos com >= 2 turmas de origem)
  for (const agr of agrupamentos || []) {
    if (!agr) continue;
    if (agr.turno && normTurnoKey(agr.turno) !== tKey) continue;
    const origens = Array.isArray(agr.turmas_origem)
      ? agr.turmas_origem.map(Number).filter((tid) => tid > 0 && (turmaIdsTurno.size === 0 || turmaIdsTurno.has(tid)))
      : [];
    if (origens.length < 2) continue;

    const discCandidatas = new Set();
    if (Number(agr.origem_disciplina_legada_id) > 0) {
      discCandidatas.add(Number(agr.origem_disciplina_legada_id));
    }
    for (const m of agr.modulacao || []) {
      if (Number(m?.disciplina_id) > 0) discCandidatas.add(Number(m.disciplina_id));
    }
    if (discCandidatas.size === 0) continue;

    const itemPorTurma = new Map();
    for (const tid of origens) {
      for (const did of discCandidatas) {
        const pairKey = `${tid}-${did}`;
        if (paresJaAgrupados.has(pairKey)) continue;
        const mod = modMap.get(pairKey);
        const carga = demandaMap.get(pairKey) || mod?.aulas || 0;
        if (carga > 0 && mod?.professor_id > 0) {
          const prev = itemPorTurma.get(tid);
          if (!prev || carga > prev.aulas_semanais) {
            itemPorTurma.set(tid, {
              turma_id: tid,
              disciplina_id: did,
              professor_id: mod.professor_id,
              aulas_semanais: carga,
            });
          }
        }
      }
    }

    const itensAgr = Array.from(itemPorTurma.values());
    if (itensAgr.length < 2) continue;

    const minCarga = Math.min(...itensAgr.map((i) => i.aulas_semanais));
    if (minCarga <= 0) continue;

    for (const it of itensAgr) {
      paresJaAgrupados.add(`${it.turma_id}-${it.disciplina_id}`);
    }

    blocos.push({
      id: `agr_${agr.id}`,
      nome: String(agr.nome || `Agrupamento ${agr.id}`).trim(),
      tipo: String(agr.tipo || "IFA"),
      origem: "agrupamento",
      turno: tKey,
      aulas_sincronizadas: minCarga,
      permitir_mesmo_prof_simultaneo: true,
      modo: "hard",
      turma_ids: itensAgr.map((i) => i.turma_id),
      disciplina_ids: Array.from(new Set(itensAgr.map((i) => i.disciplina_id))),
      itens: itensAgr,
    });
  }

  return blocos;
}

/**
 * Calcula quantos slots físicos cada professor economiza graças a Turmas Unidas
 * (1 professor lecionando simultaneamente para K >= 2 turmas no mesmo bloco).
 */
export function calcularDescontoAulasUnidasPorProfessor(blocosSimultaneos = []) {
  const descontoMap = new Map();

  for (const b of blocosSimultaneos || []) {
    if (!b || b.permitir_mesmo_prof_simultaneo === false) continue;
    const syncCount = Number(b.aulas_sincronizadas) || 0;
    if (syncCount <= 0) continue;

    const porProf = new Map();
    for (const it of b.itens || []) {
      const pid = Number(it.professor_id);
      const tid = Number(it.turma_id);
      if (!pid || !tid) continue;
      if (!porProf.has(pid)) porProf.set(pid, new Set());
      porProf.get(pid).add(tid);
    }

    for (const [pid, turmasSet] of porProf.entries()) {
      if (turmasSet.size >= 2) {
        const economia = (turmasSet.size - 1) * syncCount;
        const atual = descontoMap.get(pid) || { desconto_slots: 0, blocos_unidos: [] };
        atual.desconto_slots += economia;
        atual.blocos_unidos.push({
          id: b.id,
          nome: b.nome,
          turmas_count: turmasSet.size,
          aulas_sincronizadas: syncCount,
          economia_slots: economia,
        });
        descontoMap.set(pid, atual);
      }
    }
  }

  return descontoMap;
}

/**
 * Resolve conflitos Inter-Turnos e de Interjornada (CLT/SEEDF) cruzando por CPF
 * (e mesmo `professor_id` ou nome completo exato quando sem CPF) todas as grades
 * ativas (`rascunho` não-vazio > `publicado`) nos DEMAIS turnos da escola.
 */
export async function fetchRestricoesInterTurnosPorCpf(
  pool,
  {
    escolaId,
    turnoNorm,
    profIds = [],
    horariosPorTurno = {},
    diasSemana = [1, 2, 3, 4, 5],
    periodosPorDia = 5,
    regrasGerais = {},
  }
) {
  const tAtual = normTurnoKey(turnoNorm);
  const regras = normalizarRegrasInterturno(regrasGerais);
  const targetProfIds = Array.from(new Set((profIds || []).map(Number).filter((n) => n > 0)));

  const emptyResult = {
    regras,
    slots: [],
    carga_outros_turnos_por_dia: {},
    ocupacao_outros_turnos: {},
    resumo_professores_multiturno: [],
  };

  if (!escolaId || !tAtual || targetProfIds.length === 0 || !regras.ativo) {
    return emptyResult;
  }

  try {
    // 1) Carrega todos os professores da escola para formar clusters por CPF / ID / Nome
    const [allProfs] = await pool.query(
      `SELECT id, nome, cpf
         FROM professores
        WHERE escola_id = ?`,
      [Number(escolaId)]
    );

    if (!allProfs || allProfs.length === 0) return emptyResult;

    const profById = new Map();
    const idsByCpf = new Map();
    const idsByNomeSemCpf = new Map();

    for (const p of allProfs) {
      const id = Number(p.id);
      const cpfNorm = normalizarCpfDigitos(p.cpf);
      const nomeNorm = normalizarNomePessoa(p.nome);
      profById.set(id, { id, nome: p.nome || `Prof ${id}`, cpf: p.cpf, cpfNorm, nomeNorm });

      if (cpfNorm) {
        if (!idsByCpf.has(cpfNorm)) idsByCpf.set(cpfNorm, new Set());
        idsByCpf.get(cpfNorm).add(id);
      } else if (nomeNorm.length >= 8) {
        if (!idsByNomeSemCpf.has(nomeNorm)) idsByNomeSemCpf.set(nomeNorm, new Set());
        idsByNomeSemCpf.get(nomeNorm).add(id);
      }
    }

    // Mapeia cada professor do turno atual -> todos os `professor_id` equivalentes na escola
    const clusterPorTarget = new Map();
    const todosIdsEquivalentes = new Set();

    for (const pid of targetProfIds) {
      const info = profById.get(pid);
      const eqSet = new Set([pid]);
      if (info?.cpfNorm && idsByCpf.has(info.cpfNorm)) {
        for (const otherId of idsByCpf.get(info.cpfNorm)) eqSet.add(otherId);
      } else if (!info?.cpfNorm && info?.nomeNorm && idsByNomeSemCpf.has(info.nomeNorm)) {
        for (const otherId of idsByNomeSemCpf.get(info.nomeNorm)) eqSet.add(otherId);
      }
      clusterPorTarget.set(pid, eqSet);
      for (const x of eqSet) todosIdsEquivalentes.add(x);
    }

    if (todosIdsEquivalentes.size === 0) return emptyResult;

    // 2) Busca grades ativas (`rascunho` ou `publicado`) nos OUTROS turnos da escola
    const [resultadosOutros] = await pool.query(
      `SELECT gr.id, LOWER(gr.turno) AS turno, gr.status,
              (SELECT COUNT(*) FROM grade_slot gs0 WHERE gs0.resultado_id = gr.id) AS total_slots
         FROM grade_resultado gr
        WHERE gr.escola_id = ?
          AND LOWER(gr.turno) <> ?
          AND gr.status IN ('rascunho', 'publicado')
        ORDER BY FIELD(gr.status, 'rascunho', 'publicado'), gr.id DESC`,
      [Number(escolaId), tAtual]
    );

    // Escolhe 1 grade ativa por outro turno (prioriza `rascunho` com slots > 0; senão `publicado` com slots > 0)
    const resultadoPorOutroTurno = new Map();
    for (const r of resultadosOutros || []) {
      const tk = normTurnoKey(r.turno);
      if (!tk || tk === tAtual) continue;
      if (Number(r.total_slots) <= 0) continue;
      if (!resultadoPorOutroTurno.has(tk)) {
        resultadoPorOutroTurno.set(tk, {
          resultado_id: Number(r.id),
          turno: tk,
          status: r.status,
        });
      }
    }

    if (resultadoPorOutroTurno.size === 0) return emptyResult;

    const resultadoIds = Array.from(resultadoPorOutroTurno.values()).map((r) => r.resultado_id);
    const eqIdsArr = Array.from(todosIdsEquivalentes);

    const [slotsOutros] = await pool.query(
      `SELECT
         gs.resultado_id,
         LOWER(gr.turno) AS turno,
         gr.status AS status_grade,
         gs.professor_id,
         gs.turma_id,
         gs.disciplina_id,
         gs.dia_semana AS dia,
         gs.periodo_ordem AS ordem,
         t.nome AS turma_nome,
         d.nome AS disciplina_nome
       FROM grade_slot gs
       JOIN grade_resultado gr ON gr.id = gs.resultado_id
       LEFT JOIN turmas t ON t.id = gs.turma_id
       LEFT JOIN disciplinas d ON d.id = gs.disciplina_id
      WHERE gs.resultado_id IN (?)
        AND gs.professor_id IN (?)`,
      [resultadoIds, eqIdsArr]
    );

    if (!slotsOutros || slotsOutros.length === 0) return emptyResult;

    // 3) Horários em minutos do turno atual e dos outros turnos
    const horariosAtualMap = obterHorariosEfetivosTurno(tAtual, horariosPorTurno, periodosPorDia);
    const horariosOutrosCache = new Map();
    const getHorariosOutro = (tk, maxOrd = 6) => {
      if (!horariosOutrosCache.has(tk)) {
        horariosOutrosCache.set(tk, obterHorariosEfetivosTurno(tk, horariosPorTurno, Math.max(6, maxOrd)));
      }
      return horariosOutrosCache.get(tk);
    };

    // Indexa aulas de outros turnos por `professor_id` equivalente
    const aulasPorEqProf = new Map();
    for (const s of slotsOutros) {
      const eqPid = Number(s.professor_id);
      if (!aulasPorEqProf.has(eqPid)) aulasPorEqProf.set(eqPid, []);
      aulasPorEqProf.get(eqPid).push(s);
    }

    const restricoesSlots = [];
    const cargaOutrosPorDia = {};
    const ocupacaoOutrosTurnos = {};
    const resumoMultiturno = [];

    const diasSet = new Set((diasSemana || [1, 2, 3, 4, 5]).map(Number));
    const maxOrdAtual = Math.max(1, Number(periodosPorDia) || 5);

    for (const targetPid of targetProfIds) {
      const eqSet = clusterPorTarget.get(targetPid) || new Set([targetPid]);
      // Deduplica aulas nos outros turnos por `(turno, dia, ordem)` para não contar turmas unidas em dobro
      const aulasUnicasMap = new Map();

      for (const eqPid of eqSet) {
        const lista = aulasPorEqProf.get(eqPid) || [];
        for (const item of lista) {
          const tk = normTurnoKey(item.turno);
          const dia = Number(item.dia);
          const ord = Number(item.ordem);
          const key = `${tk}|${dia}|${ord}`;
          if (!aulasUnicasMap.has(key)) {
            const hMap = getHorariosOutro(tk, ord);
            const hSlot = hMap[ord] || { inicio: "00:00", fim: "00:50", iniMin: 0, fimMin: 50 };
            aulasUnicasMap.set(key, {
              turno: tk,
              status_grade: item.status_grade,
              dia,
              ordem: ord,
              inicio: hSlot.inicio,
              fim: hSlot.fim,
              iniMin: hSlot.iniMin,
              fimMin: hSlot.fimMin,
              turma_id: Number(item.turma_id),
              turma_nome: item.turma_nome || `Turma ${item.turma_id}`,
              disciplina_id: Number(item.disciplina_id),
              disciplina_nome: item.disciplina_nome || "",
            });
          } else {
            const ex = aulasUnicasMap.get(key);
            if (item.turma_nome && !String(ex.turma_nome).includes(item.turma_nome)) {
              ex.turma_nome = `${ex.turma_nome} + ${item.turma_nome}`;
            }
          }
        }
      }

      const aulasOutros = Array.from(aulasUnicasMap.values());
      if (aulasOutros.length === 0) continue;

      ocupacaoOutrosTurnos[targetPid] = aulasOutros;
      cargaOutrosPorDia[targetPid] = {};
      const outrosTurnosSet = new Set();

      for (const ao of aulasOutros) {
        outrosTurnosSet.add(ao.turno);
        cargaOutrosPorDia[targetPid][ao.dia] = (cargaOutrosPorDia[targetPid][ao.dia] || 0) + 1;
      }

      let countRelogio = 0;
      let countInterjornada = 0;
      let countTransicao = 0;

      // Avalia cada (dia, ordem) candidato no turno atual contra as aulas já alocadas nos outros turnos
      for (const dia of diasSet) {
        for (let ord = 1; ord <= maxOrdAtual; ord++) {
          const hAtual = horariosAtualMap[ord];
          if (!hAtual) continue;

          let restricaoMaisForte = null;
          const registrarCandidata = (cand) => {
            if (!restricaoMaisForte) {
              restricaoMaisForte = cand;
              return;
            }
            // Prioriza 'bloqueado' sobre 'evitar', e SOBREPOSICAO > INTERJORNADA > TRANSICAO
            const pesoStatus = (s) => (s === "bloqueado" ? 2 : 1);
            if (pesoStatus(cand.status) > pesoStatus(restricaoMaisForte.status)) {
              restricaoMaisForte = cand;
            }
          };

          for (const ao of aulasOutros) {
            // A) Mesmo dia: verifica sobreposição direta de relógio e intervalo mínimo de transição
            if (ao.dia === dia) {
              const overlap = Math.min(hAtual.fimMin, ao.fimMin) - Math.max(hAtual.iniMin, ao.iniMin);
              if (overlap > 0) {
                registrarCandidata({
                  professor_id: targetPid,
                  dia,
                  ordem: ord,
                  status: "bloqueado",
                  motivo: "SOBREPOSICAO_INTERTURNO",
                  turno_origem: ao.turno,
                  ordem_origem: ao.ordem,
                  horario_origem: `${ao.inicio}–${ao.fim}`,
                  horario_atual: `${hAtual.inicio}–${hAtual.fim}`,
                  descanso_minutos: 0,
                  detalhe: `Choque de relógio com ${ao.turno.toUpperCase()} (${ao.ordem}º horário ${ao.inicio}–${ao.fim}, ${ao.turma_nome})`,
                });
                continue;
              }

              if (regras.transicao_turno_min_minutos > 0) {
                const gapMesmoDia =
                  hAtual.iniMin >= ao.fimMin
                    ? hAtual.iniMin - ao.fimMin
                    : ao.iniMin - hAtual.fimMin;
                if (gapMesmoDia >= 0 && gapMesmoDia < regras.transicao_turno_min_minutos) {
                  registrarCandidata({
                    professor_id: targetPid,
                    dia,
                    ordem: ord,
                    status: regras.transicao_turno_modo === "hard" ? "bloqueado" : "evitar",
                    motivo: "TRANSICAO_TURNO",
                    turno_origem: ao.turno,
                    ordem_origem: ao.ordem,
                    horario_origem: `${ao.inicio}–${ao.fim}`,
                    horario_atual: `${hAtual.inicio}–${hAtual.fim}`,
                    descanso_minutos: gapMesmoDia,
                    detalhe: `Transição curta (${formatMinutesDuration(gapMesmoDia)} < ${regras.transicao_turno_min_minutos}min) com ${ao.turno.toUpperCase()} (${ao.ordem}º ${ao.inicio}–${ao.fim})`,
                  });
                }
              }
            }

            // B) Interjornada Entre Dias Consecutivos (ex.: Noturno em `dia - 1` -> Matutino em `dia`,
            //    ou gerando Noturno em `dia` quando o professor já leciona Matutino em `dia + 1`)
            if (regras.interjornada_min_minutos > 0) {
              // Caso B1: Aula de outro turno na noite anterior (`ao.dia === dia - 1`, ex.: Noturno >= 18h)
              //          e aula atual cedo (`hAtual.iniMin <= 13:00`)
              if (ao.dia === dia - 1 && ao.fimMin >= 18 * 60 && hAtual.iniMin <= 13 * 60) {
                const descanso = 1440 - ao.fimMin + hAtual.iniMin;
                if (descanso >= 0 && descanso < regras.interjornada_min_minutos) {
                  registrarCandidata({
                    professor_id: targetPid,
                    dia,
                    ordem: ord,
                    status: regras.interjornada_modo === "hard" ? "bloqueado" : "evitar",
                    motivo: "INTERJORNADA_CLT",
                    turno_origem: ao.turno,
                    ordem_origem: ao.ordem,
                    horario_origem: `${ao.inicio}–${ao.fim}`,
                    horario_atual: `${hAtual.inicio}–${hAtual.fim}`,
                    descanso_minutos: descanso,
                    detalhe: `Interjornada de ${formatMinutesDuration(descanso)} (< ${regras.interjornada_min_horas}h) após ${ao.turno.toUpperCase()} do dia anterior (${ao.ordem}º até ${ao.fim})`,
                  });
                }
              }

              // Caso B2: Gerando turno da noite (`hAtual.fimMin >= 18h` em `dia`) e professor já tem aula
              //          na manhã seguinte (`ao.dia === dia + 1` e `ao.iniMin <= 13h`)
              if (ao.dia === dia + 1 && hAtual.fimMin >= 18 * 60 && ao.iniMin <= 13 * 60) {
                const descanso = 1440 - hAtual.fimMin + ao.iniMin;
                if (descanso >= 0 && descanso < regras.interjornada_min_minutos) {
                  registrarCandidata({
                    professor_id: targetPid,
                    dia,
                    ordem: ord,
                    status: regras.interjornada_modo === "hard" ? "bloqueado" : "evitar",
                    motivo: "INTERJORNADA_CLT",
                    turno_origem: ao.turno,
                    ordem_origem: ao.ordem,
                    horario_origem: `${ao.inicio}–${ao.fim}`,
                    horario_atual: `${hAtual.inicio}–${hAtual.fim}`,
                    descanso_minutos: descanso,
                    detalhe: `Interjornada de ${formatMinutesDuration(descanso)} (< ${regras.interjornada_min_horas}h) antes do ${ao.turno.toUpperCase()} do dia seguinte (${ao.ordem}º às ${ao.inicio})`,
                  });
                }
              }
            }
          }

          if (restricaoMaisForte) {
            restricoesSlots.push(restricaoMaisForte);
            if (restricaoMaisForte.motivo === "SOBREPOSICAO_INTERTURNO") countRelogio++;
            else if (restricaoMaisForte.motivo === "INTERJORNADA_CLT") countInterjornada++;
            else if (restricaoMaisForte.motivo === "TRANSICAO_TURNO") countTransicao++;
          }
        }
      }

      const infoProf = profById.get(targetPid);
      resumoMultiturno.push({
        professor_id: targetPid,
        professor_nome: infoProf?.nome || `Professor ${targetPid}`,
        cpf_mascarado: mascararCpf(infoProf?.cpf),
        possui_cpf: Boolean(infoProf?.cpfNorm),
        outros_turnos: Array.from(outrosTurnosSet),
        total_aulas_outros_turnos: aulasOutros.length,
        bloqueios_relogio: countRelogio,
        bloqueios_interjornada: countInterjornada,
        alertas_transicao: countTransicao,
      });
    }

    return {
      regras,
      slots: restricoesSlots,
      carga_outros_turnos_por_dia: cargaOutrosPorDia,
      ocupacao_outros_turnos: ocupacaoOutrosTurnos,
      resumo_professores_multiturno: resumoMultiturno,
    };
  } catch (err) {
    console.warn("[solverEtapa3Helper] Aviso ao calcular restrições inter-turnos por CPF:", err?.message || err);
    return emptyResult;
  }
}

// ============================================================================
// Suporte seguro a múltiplas turmas unidas em `grade_slot`
// ============================================================================
let _gradeSlotIndexVerified = false;

/**
 * Garante idempotentemente que `grade_slot` permita 1 professor em 2+ turmas unidas
 * no mesmo `(resultado_id, dia_semana, periodo_ordem)` convertendo eventual índice
 * legado `UNIQUE KEY u_unico_prof` em índice normal `idx_res_prof_slot` (mantendo H2 via código).
 */
export async function ensureGradeSlotMultiTurmaSupport(conn) {
  if (_gradeSlotIndexVerified || !conn) return;
  try {
    const [idxRows] = await conn.query(
      `SHOW INDEX FROM grade_slot WHERE Key_name = 'u_unico_prof' AND Non_unique = 0`
    );
    if (Array.isArray(idxRows) && idxRows.length > 0) {
      await conn.query(
        `ALTER TABLE grade_slot
           DROP INDEX u_unico_prof,
           ADD INDEX idx_res_prof_slot (resultado_id, professor_id, dia_semana, periodo_ordem)`
      );
    }
    _gradeSlotIndexVerified = true;
  } catch {
    // Em ambientes restritos ou caso já tenha sido migrado, segue silenciosamente
    _gradeSlotIndexVerified = true;
  }
}

/**
 * Retorna um `Set` de chaves `"minTurmaId-maxTurmaId"` que estão autorizadas a
 * compartilhar o mesmo professor simultaneamente no turno (via `blocos_simultaneos`
 * ou `agrupamentos` ativos).
 */
export async function carregarParesTurmasUnidasPermitidas(conn, escolaId, turnoNorm) {
  const pares = new Set();
  if (!conn || !escolaId) return pares;
  const tKey = normTurnoKey(turnoNorm);

  const registrarGrupoTurmas = (turmaIds = []) => {
    const ids = Array.from(new Set(turmaIds.map(Number).filter((n) => n > 0))).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pares.add(`${ids[i]}-${ids[j]}`);
      }
    }
  };

  try {
    const [[cfgRow]] = await conn.query(
      `SELECT periodos FROM escola_configuracao_grade WHERE escola_id = ? LIMIT 1`,
      [Number(escolaId)]
    );
    if (cfgRow?.periodos) {
      const parsed = typeof cfgRow.periodos === "string" ? JSON.parse(cfgRow.periodos) : cfgRow.periodos;
      const blocosCfg = parsed?._regras_gerais?.blocos_simultaneos;
      if (Array.isArray(blocosCfg)) {
        for (const b of blocosCfg) {
          if (!b || b.ativo === false || b.permitir_mesmo_prof_simultaneo === false) continue;
          if (b.turno && normTurnoKey(b.turno) !== tKey) continue;
          const tIds = [
            ...(Array.isArray(b.turma_ids) ? b.turma_ids : []),
            ...(Array.isArray(b.itens) ? b.itens.map((it) => it?.turma_id) : []),
          ];
          registrarGrupoTurmas(tIds);
        }
      }
    }
  } catch {
    // ignora
  }

  try {
    const [agrRows] = await conn.query(
      `SELECT g.id, GROUP_CONCAT(DISTINCT aa.turma_origem_id) AS turmas_csv
         FROM agrupamentos g
         JOIN agrupamento_alunos aa ON aa.agrupamento_id = g.id AND aa.ativo = 1
        WHERE g.escola_id = ?
          AND COALESCE(g.status, 'ATIVO') <> 'ENCERRADO'
          AND (? = '' OR LOWER(g.turno) = ?)
        GROUP BY g.id`,
      [Number(escolaId), tKey, tKey]
    );
    for (const r of agrRows || []) {
      if (!r?.turmas_csv) continue;
      registrarGrupoTurmas(String(r.turmas_csv).split(","));
    }
  } catch {
    // ignora
  }

  return pares;
}

export function saoTurmasUnidasPermitidas(paresSet, turmaA, turmaB, explicitFlag = false) {
  if (explicitFlag) return true;
  const a = Number(turmaA);
  const b = Number(turmaB);
  if (!a || !b || a === b) return true;
  if (!paresSet || paresSet.size === 0) return false;
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  return paresSet.has(key);
}
