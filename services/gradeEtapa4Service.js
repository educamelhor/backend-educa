// services/gradeEtapa4Service.js
// ============================================================================
// Motor Solver 2.0 — ETAPA 4 (Governança Executiva, Versionamento & Diários)
//  1) Pilar 1: Versionamento / Cenários A-B-C de Grade + Snapshots Automáticos
//  2) Pilar 2: Substituição de Professores com Preservação 100% do Diário + Reversão
//  3) Pilar 3: Motor Determinístico de Qualidade Pedagógica (Score 0–100 + 8 Dimensões)
// ============================================================================

import { buildSolverPayload } from "./solverPayloadService.js";
import {
  resolverVigenciaLetiva,
  resolverHorariosReaisPorTurno,
} from "../utils/vigenciaHorariosHelper.js";
import {
  normTurnoKey,
  normalizarCpfDigitos,
  mascararCpf,
  ensureGradeSlotMultiTurmaSupport,
  carregarParesTurmasUnidasPermitidas,
  saoTurmasUnidasPermitidas,
  fetchRestricoesInterTurnosPorCpf,
  normalizarRecursosFisicos,
} from "./solverEtapa3Helper.js";

let _etapa4SchemaVerified = false;

function safeJsonParse(raw, fallback = null) {
  if (raw == null) return fallback;
  if (typeof raw === "object" && !Buffer.isBuffer(raw)) return raw;
  try {
    const str = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function round1(num) {
  return Math.round((Number(num) || 0) * 10) / 10;
}

// ============================================================================
// 1. AUTO-MIGRATION IDEMPOTENTE (Zero Downtime)
// ============================================================================
export async function ensureEtapa4Schema(connOrPool) {
  if (_etapa4SchemaVerified || !connOrPool) return;
  try {
    // 1.1) Corrige armadilha legada u_escola_turno_status (escola_id, turno, status)
    //      em grade_resultado: quando status='arquivado' ocorria 2+ vezes no mesmo turno,
    //      o UNIQUE KEY antigo impedia a 2ª publicação (ER_DUP_ENTRY).
    try {
      const [idxRows] = await connOrPool.query(
        `SHOW INDEX FROM grade_resultado WHERE Key_name = 'u_escola_turno_status' AND Non_unique = 0`
      );
      if (Array.isArray(idxRows) && idxRows.length > 0) {
        await connOrPool.query(
          `ALTER TABLE grade_resultado
             DROP INDEX u_escola_turno_status,
             ADD INDEX idx_escola_turno_status (escola_id, turno, status)`
        );
      }
    } catch {
      // ignora caso já migrado
    }

    // 1.2) Tabela de Cenários A-B-C, Snapshots de Publicação e Backups Automáticos
    await connOrPool.query(`
      CREATE TABLE IF NOT EXISTS grade_cenarios (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id BIGINT NOT NULL,
        turno VARCHAR(20) NOT NULL,
        ano_letivo SMALLINT NOT NULL,
        semestre TINYINT NOT NULL DEFAULT 1,
        codigo_cenario VARCHAR(20) DEFAULT NULL COMMENT 'A | B | C | CUSTOM | PUB | BACKUP',
        nome VARCHAR(160) NOT NULL,
        descricao VARCHAR(255) DEFAULT NULL,
        tipo VARCHAR(30) NOT NULL DEFAULT 'CENARIO' COMMENT 'CENARIO | PUBLICACAO | BACKUP_AUTO',
        favorito TINYINT(1) NOT NULL DEFAULT 0,
        total_slots INT NOT NULL DEFAULT 0,
        total_fixos INT NOT NULL DEFAULT 0,
        total_turmas INT NOT NULL DEFAULT 0,
        total_professores INT NOT NULL DEFAULT 0,
        score_qualidade DECIMAL(6,2) DEFAULT NULL,
        metricas_json LONGTEXT DEFAULT NULL,
        config_snapshot_json LONGTEXT DEFAULT NULL,
        slots_json LONGTEXT NOT NULL,
        criado_por BIGINT DEFAULT NULL,
        criado_por_nome VARCHAR(140) DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_cenarios_escola_turno (escola_id, turno, ano_letivo, semestre),
        KEY idx_cenarios_codigo (escola_id, turno, codigo_cenario)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 1.3) Tabela de Histórico Auditável de Substituição de Professores (com Snapshot de Reversão)
    await connOrPool.query(`
      CREATE TABLE IF NOT EXISTS grade_substituicoes_historico (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        escola_id BIGINT NOT NULL,
        turno VARCHAR(20) NOT NULL,
        ano_letivo SMALLINT NOT NULL,
        semestre TINYINT NOT NULL DEFAULT 1,
        professor_titular_id BIGINT NOT NULL,
        professor_titular_nome VARCHAR(160) NOT NULL,
        professor_titular_cpf VARCHAR(20) DEFAULT NULL,
        professor_substituto_id BIGINT NOT NULL,
        professor_substituto_nome VARCHAR(160) NOT NULL,
        professor_substituto_cpf VARCHAR(20) DEFAULT NULL,
        motivo VARCHAR(60) NOT NULL DEFAULT 'SUBSTITUICAO_TEMPORARIA',
        observacao VARCHAR(500) DEFAULT NULL,
        data_inicio DATE DEFAULT NULL,
        data_fim_prevista DATE DEFAULT NULL,
        data_retorno_efetivo DATE DEFAULT NULL,
        inativou_titular TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(30) NOT NULL DEFAULT 'ATIVA' COMMENT 'ATIVA | REVERTIDA | DEFINITIVA',
        escopo_json LONGTEXT DEFAULT NULL,
        snapshot_reversao_json LONGTEXT DEFAULT NULL,
        realizado_por BIGINT DEFAULT NULL,
        realizado_por_nome VARCHAR(140) DEFAULT NULL,
        revertido_por BIGINT DEFAULT NULL,
        revertido_por_nome VARCHAR(140) DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reverted_at DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        KEY idx_subst_escola_turno (escola_id, turno, ano_letivo),
        KEY idx_subst_titular (escola_id, professor_titular_id),
        KEY idx_subst_substituto (escola_id, professor_substituto_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    _etapa4SchemaVerified = true;
  } catch (err) {
    console.warn("[gradeEtapa4Service] Aviso na auto-migration ETAPA 4:", err?.message || err);
  }
}

// ============================================================================
// 2. MOTOR DETERMINÍSTICO DE QUALIDADE PEDAGÓGICA (8 Dimensões + Score 0–100)
// ============================================================================
export function avaliarQualidadePedagogicaSlots({ slots = [], payload = null, turno = "matutino" }) {
  const turnoKey = normTurnoKey(turno);
  const cleanSlots = (Array.isArray(slots) ? slots : [])
    .map((s) => ({
      turma_id: Number(s.turma_id),
      dia: Number(s.dia ?? s.dia_semana),
      ordem: Number(s.ordem ?? s.periodo_ordem),
      disciplina_id: Number(s.disciplina_id),
      professor_id: Number(s.professor_id),
      locked: Boolean(Number(s.locked ?? (s.locked === true ? 1 : 0))),
      origem: String(s.origem || "solver").toLowerCase(),
      permitir_turmas_unidas: Boolean(s.permitir_turmas_unidas),
      bloco_simultaneo_id: s.bloco_simultaneo_id || null,
    }))
    .filter((s) => s.turma_id > 0 && s.dia > 0 && s.ordem > 0 && s.disciplina_id > 0 && s.professor_id > 0);

  const regrasGerais = payload?.config_pedagogica?.regras_gerais || {};
  const diasSemana = Array.isArray(payload?.dias_semana) && payload.dias_semana.length > 0
    ? payload.dias_semana.map(Number)
    : [1, 2, 3, 4, 5];
  const periodosPorDia = Number(payload?.periodos_por_dia) || (turnoKey === "noturno" ? 5 : 6);

  // Intervalo / Recreio efetivo do turno
  const govApos = Number(
    payload?.intervalos_por_turno?.[turnoKey]?.apos_periodo ??
      regrasGerais?._intervalos_governanca?.[turnoKey]?.apos_periodo ??
      0
  );
  const cfgApos =
    regrasGerais?.recreio_apos_periodo?.[turnoKey] !== undefined
      ? Number(regrasGerais.recreio_apos_periodo[turnoKey])
      : null;
  const recreioApos =
    govApos > 0 && govApos < periodosPorDia
      ? govApos
      : cfgApos !== null && cfgApos >= 0 && cfgApos < periodosPorDia
      ? cfgApos
      : 3;
  const bloquearNoRecreio =
    regrasGerais?.bloquear_duplas_no_recreio !== undefined
      ? Boolean(regrasGerais.bloquear_duplas_no_recreio)
      : true;

  // Demanda curricular total
  const demandaList = Array.isArray(payload?.demanda) ? payload.demanda : [];
  let totalDemanda = demandaList.reduce((acc, d) => acc + (Number(d.carga ?? d.aulas) || 0), 0);
  if (totalDemanda <= 0) totalDemanda = cleanSlots.length;

  const aulasAlocadas = cleanSlots.length;
  const totalFixos = cleanSlots.filter((s) => s.locked).length;
  const coberturaPct = totalDemanda > 0 ? round1(Math.min(100, (aulasAlocadas / totalDemanda) * 100)) : 100;
  const aulasNaoAlocadas = Math.max(0, totalDemanda - aulasAlocadas);

  // Índices de disponibilidade e restrições inter-turnos por CPF
  const dispoMap = new Map();
  for (const d of payload?.disponibilidades || []) {
    const pId = Number(d.professor_id);
    const dia = Number(d.dia ?? d.dia_semana);
    const ord = Number(d.ordem ?? d.periodo ?? d.periodo_ordem);
    const st = String(d.status || "livre").toLowerCase();
    if (pId && dia && ord) dispoMap.set(`${pId}|${dia}|${ord}`, st);
  }

  const interMap = new Map();
  const rawInterSlots = Array.isArray(payload?.restricoes_interturno?.slots)
    ? payload.restricoes_interturno.slots
    : Array.isArray(payload?.restricoes_interturno)
    ? payload.restricoes_interturno
    : [];
  for (const it of rawInterSlots) {
    const pId = Number(it.professor_id);
    const dia = Number(it.dia ?? it.dia_semana);
    const ord = Number(it.ordem ?? it.periodo ?? it.periodo_ordem);
    if (pId && dia && ord) interMap.set(`${pId}|${dia}|${ord}`, String(it.status || "").toLowerCase());
  }

  // Recursos físicos (Salas especiais / Quadras / Laboratórios)
  const recursosFisicos = Array.isArray(payload?.recursos_fisicos)
    ? payload.recursos_fisicos
    : normalizarRecursosFisicos(regrasGerais);

  // Blocos simultâneos / Super-Aulas IFA
  const blocosSimultaneos = Array.isArray(payload?.blocos_simultaneos) ? payload.blocos_simultaneos : [];
  const blocoTurmaDiscSet = new Set();
  for (const b of blocosSimultaneos) {
    for (const it of b.itens || b.demandas || []) {
      if (it.turma_id && it.disciplina_id) {
        blocoTurmaDiscSet.add(`${Number(it.turma_id)}|${Number(it.disciplina_id)}`);
      }
    }
  }

  // Nomes de apoio
  const profNomeMap = new Map();
  for (const m of payload?.modulacao || []) {
    if (m.professor_id && m.professor_nome) profNomeMap.set(Number(m.professor_id), m.professor_nome);
  }
  const turmaNomeMap = new Map();
  for (const t of payload?.turmas || []) {
    if (t.id) turmaNomeMap.set(Number(t.id), t.nome || t.turma || `Turma ${t.id}`);
  }

  // Agrupamento por Turma -> Dia -> Ordem e por Professor -> Dia -> Set(Ordens)
  const porTurmaDia = new Map();
  const porProfDia = new Map();
  const turmasSet = new Set();
  const profsSet = new Set();

  let violacoesIndisponibilidade = 0;
  let slotsEmEvitar = 0;
  let violacoesInterturno = 0;
  let superAulasAlocadas = 0;

  // Ocupação de recursos físicos por (recId|dia|ordem) colapsando turmas unidas do mesmo prof
  const recOcupacaoMap = new Map();

  for (const s of cleanSlots) {
    turmasSet.add(s.turma_id);
    profsSet.add(s.professor_id);

    const tk = `${s.turma_id}|${s.dia}`;
    if (!porTurmaDia.has(tk)) porTurmaDia.set(tk, new Map());
    porTurmaDia.get(tk).set(s.ordem, s);

    const pk = `${s.professor_id}|${s.dia}`;
    if (!porProfDia.has(pk)) porProfDia.set(pk, new Map());
    if (!porProfDia.get(pk).has(s.ordem)) {
      porProfDia.get(pk).set(s.ordem, []);
    }
    porProfDia.get(pk).get(s.ordem).push(s);

    if (s.bloco_simultaneo_id || blocoTurmaDiscSet.has(`${s.turma_id}|${s.disciplina_id}`)) {
      superAulasAlocadas++;
    }

    if (!s.locked) {
      const stDisp = dispoMap.get(`${s.professor_id}|${s.dia}|${s.ordem}`);
      if (stDisp === "indisponivel" || stDisp === "bloqueado" || stDisp === "excluir") {
        violacoesIndisponibilidade++;
      } else if (stDisp === "evitar") {
        slotsEmEvitar++;
      }

      const stInter = interMap.get(`${s.professor_id}|${s.dia}|${s.ordem}`);
      if (stInter === "bloqueado" || stInter === "indisponivel" || stInter === "evitar") {
        violacoesInterturno++;
      }
    }

    for (const rf of recursosFisicos) {
      const discIds = Array.isArray(rf.disciplina_ids) ? rf.disciplina_ids.map(Number) : [];
      if (discIds.includes(s.disciplina_id)) {
        const rk = `${rf.id}|${s.dia}|${s.ordem}`;
        if (!recOcupacaoMap.has(rk)) recOcupacaoMap.set(rk, { rf, profKeys: new Set() });
        // Turmas unidas com o mesmo professor contam como 1 ocupação física de quadra/lab
        recOcupacaoMap.get(rk).profKeys.add(`${s.professor_id}|${s.disciplina_id}`);
      }
    }
  }

  let violacoesSalas = 0;
  for (const { rf, profKeys } of recOcupacaoMap.values()) {
    const cap = Math.max(1, Number(rf.capacidade) || 1);
    if (profKeys.size > cap) {
      violacoesSalas += profKeys.size - cap;
    }
  }

  // Avaliação Pedagógica por Turma/Dia: Duplas Geminadas, Recreio, Separadas no mesmo dia, Limite diário
  let paresGeminados = 0;
  let violacoesRecreio = 0;
  let violacoesSeparadasMesmoDia = 0;
  let violacoesMaxDia = 0;
  const maxAulasMesmaDiscDia = Math.max(2, Number(regrasGerais?.max_aulas_mesma_disciplina_dia) || 2);

  // Pares obrigatórios de governança
  const paresGov = Array.isArray(regrasGerais?.pares_duplas_governanca)
    ? regrasGerais.pares_duplas_governanca
    : [];
  const paresObrigatorios = paresGov.filter((p) => String(p.modo || "").toLowerCase() === "obrigatorio");
  let paresObrigatoriosMeta = 0;
  let paresObrigatoriosAtendidos = 0;

  for (const [tk, ordMap] of porTurmaDia.entries()) {
    const ordensOrdenadas = Array.from(ordMap.keys()).sort((a, b) => a - b);
    const discPosicoes = new Map();

    for (const ord of ordensOrdenadas) {
      const cell = ordMap.get(ord);
      if (!discPosicoes.has(cell.disciplina_id)) discPosicoes.set(cell.disciplina_id, []);
      discPosicoes.get(cell.disciplina_id).push({ ord, locked: cell.locked });
    }

    for (const [, posList] of discPosicoes.entries()) {
      posList.sort((a, b) => a.ord - b.ord);
      const nonLockedCount = posList.filter((x) => !x.locked).length;
      if (posList.length > maxAulasMesmaDiscDia && nonLockedCount > 0) {
        violacoesMaxDia += posList.length - maxAulasMesmaDiscDia;
      }

      for (let i = 0; i < posList.length - 1; i++) {
        const a = posList[i];
        const b = posList[i + 1];
        if (b.ord === a.ord + 1) {
          const atravessaRecreio = bloquearNoRecreio && recreioApos > 0 && a.ord === recreioApos;
          if (atravessaRecreio) {
            if (!a.locked && !b.locked) violacoesRecreio++;
          } else {
            paresGeminados++;
          }
        } else if (!a.locked && !b.locked) {
          violacoesSeparadasMesmoDia++;
        }
      }
    }

    for (const po of paresObrigatorios) {
      const s1 = ordMap.get(Number(po.inicio));
      const s2 = ordMap.get(Number(po.fim));
      if (!s1 && !s2) continue;
      if (s1?.locked || s2?.locked) continue;
      paresObrigatoriosMeta++;
      if (s1 && s2 && s1.disciplina_id === s2.disciplina_id) {
        paresObrigatoriosAtendidos++;
      }
    }
  }

  // Avaliação Ergonômica Docente: Janelas Internas, Dias Trabalhados e Aulas Isoladas (1h/dia)
  let janelasProfessores = 0;
  let professoresComJanela = 0;
  let diasProfessorTotal = 0;
  let aulasIsoladasDia = 0;
  const ergonomiaPorProfessor = [];

  const profIdsOrdenados = Array.from(profsSet).sort((a, b) => a - b);
  for (const pId of profIdsOrdenados) {
    let janelasProf = 0;
    let diasAtivosProf = 0;
    let aulasFisicasProf = 0;
    let isoladasProf = 0;

    for (const dia of diasSemana) {
      const ordMap = porProfDia.get(`${pId}|${dia}`);
      if (!ordMap || ordMap.size === 0) continue;
      const ords = Array.from(ordMap.keys()).sort((a, b) => a - b);
      diasAtivosProf++;
      aulasFisicasProf += ords.length;
      if (ords.length === 1) {
        isoladasProf++;
      }
      const minOrd = ords[0];
      const maxOrd = ords[ords.length - 1];
      const janelasNoDia = Math.max(0, maxOrd - minOrd + 1 - ords.length);
      janelasProf += janelasNoDia;
    }

    janelasProfessores += janelasProf;
    if (janelasProf > 0) professoresComJanela++;
    diasProfessorTotal += diasAtivosProf;
    aulasIsoladasDia += isoladasProf;

    ergonomiaPorProfessor.push({
      professor_id: pId,
      professor_nome: profNomeMap.get(pId) || `Prof. ${pId}`,
      aulas_fisicas: aulasFisicasProf,
      dias_ativos: diasAtivosProf,
      janelas: janelasProf,
      aulas_isoladas_dia: isoladasProf,
    });
  }

  ergonomiaPorProfessor.sort((a, b) => {
    if (b.janelas !== a.janelas) return b.janelas - a.janelas;
    if (b.aulas_isoladas_dia !== a.aulas_isoladas_dia) return b.aulas_isoladas_dia - a.aulas_isoladas_dia;
    return String(a.professor_nome).localeCompare(String(b.professor_nome), "pt-BR");
  });

  const totalProfessores = profIdsOrdenados.length;
  const professoresZeroJanelas = Math.max(0, totalProfessores - professoresComJanela);
  const mediaDiasProfessor = totalProfessores > 0 ? round1(diasProfessorTotal / totalProfessores) : 0;

  // ── Cálculo Transparente do Score Global de Qualidade Pedagógica (0 a 100) ──
  // 1) Cobertura Curricular (0..35)
  const ptsCobertura = clamp((coberturaPct / 100) * 35, 0, 35);

  // 2) Ergonomia / Zero Janelas Docentes (0..20)
  const limiteRefJanelas = Math.max(4, totalProfessores * 1.5);
  const ptsJanelas = totalProfessores > 0
    ? clamp(20 * (1 - janelasProfessores / limiteRefJanelas), 0, 20)
    : 20;

  // 3) Geminação & Blindagem do Recreio (0..15)
  const metaParesEstimada = Math.max(1, Math.floor(aulasAlocadas / 3));
  const bonusGeminacao = clamp((paresGeminados / metaParesEstimada) * 10, 0, 10);
  const bonusRecreio = clamp(5 - violacoesRecreio * 2.5 - Math.max(0, paresObrigatoriosMeta - paresObrigatoriosAtendidos) * 1.0, 0, 5);
  const ptsGeminacao = round1(bonusGeminacao + bonusRecreio);

  // 4) Distribuição Semanal s/ Fragmentação no Mesmo Dia (0..10)
  const ptsDistribuicao = clamp(10 - violacoesSeparadasMesmoDia * 2.0 - violacoesMaxDia * 2.0, 0, 10);

  // 5) Concentração Docente & Redução de Dias de 1 Aula Isolada (0..5)
  const ptsConcentracao = clamp(5 - aulasIsoladasDia * 0.6, 0, 5);

  // 6) Respeito à Disponibilidade & Preferências (0..5)
  const ptsDisponibilidade = clamp(5 - violacoesIndisponibilidade * 2.5 - slotsEmEvitar * 0.35, 0, 5);

  // 7) Saúde Inter-Turnos & Interjornada CPF (0..5)
  const ptsInterturno = clamp(5 - violacoesInterturno * 2.0, 0, 5);

  // 8) Super-Aulas IFA & Capacidade de Salas/Quadras (0..5)
  const ptsSalasSuper = clamp(5 - violacoesSalas * 2.0, 0, 5);

  const scoreGlobal = round1(
    clamp(
      ptsCobertura +
        ptsJanelas +
        ptsGeminacao +
        ptsDistribuicao +
        ptsConcentracao +
        ptsDisponibilidade +
        ptsInterturno +
        ptsSalasSuper,
      0,
      100
    )
  );

  const classificacao =
    scoreGlobal >= 92
      ? "EXCELENTE"
      : scoreGlobal >= 80
      ? "OTIMO"
      : scoreGlobal >= 65
      ? "BOM"
      : "ATENCAO";

  return {
    score_global: scoreGlobal,
    classificacao,
    cobertura_pct: coberturaPct,
    total_demanda: totalDemanda,
    aulas_alocadas: aulasAlocadas,
    aulas_nao_alocadas: aulasNaoAlocadas,
    total_fixos: totalFixos,
    total_turmas: turmasSet.size || (payload?.turmas?.length || 0),
    total_professores: totalProfessores,
    janelas_professores: janelasProfessores,
    professores_com_janela: professoresComJanela,
    professores_zero_janelas: professoresZeroJanelas,
    pares_geminados: paresGeminados,
    pares_obrigatorios_meta: paresObrigatoriosMeta,
    pares_obrigatorios_atendidos: paresObrigatoriosAtendidos,
    violacoes_recreio: violacoesRecreio,
    violacoes_separadas_mesmo_dia: violacoesSeparadasMesmoDia,
    violacoes_max_dia: violacoesMaxDia,
    media_dias_professor: mediaDiasProfessor,
    dias_professor_total: diasProfessorTotal,
    aulas_isoladas_dia: aulasIsoladasDia,
    violacoes_indisponibilidade: violacoesIndisponibilidade,
    slots_em_evitar: slotsEmEvitar,
    violacoes_interturno: violacoesInterturno,
    violacoes_salas: violacoesSalas,
    super_aulas_alocadas: superAulasAlocadas,
    subscores: {
      cobertura: round1(ptsCobertura),
      janelas: round1(ptsJanelas),
      geminacao: round1(ptsGeminacao),
      distribuicao: round1(ptsDistribuicao),
      concentracao: round1(ptsConcentracao),
      disponibilidade: round1(ptsDisponibilidade),
      interturno: round1(ptsInterturno),
      salas_super: round1(ptsSalasSuper),
    },
    ergonomia_por_professor: ergonomiaPorProfessor,
  };
}

// ============================================================================
// 3. CENÁRIOS A-B-C, SNAPSHOTS AUTOMÁTICOS DE PUBLICAÇÃO E RESTAURAÇÃO SEGURA
// ============================================================================
async function buildPayloadParaAvaliacao(pool, escolaId, turnoNorm, semestre) {
  const [turmasRows] = await pool.query(
    `SELECT id FROM turmas WHERE escola_id = ? AND LOWER(turno) = ? ORDER BY id`,
    [Number(escolaId), turnoNorm]
  );
  const turmaIds = (turmasRows || []).map((r) => Number(r.id)).filter((n) => n > 0);
  if (!turmaIds.length) return null;
  try {
    return await buildSolverPayload({
      escolaId: Number(escolaId),
      turno: turnoNorm,
      turmaIds,
      semestre,
      respeitarHorarioManual: true,
    });
  } catch (err) {
    console.warn("[gradeEtapa4Service] Fallback payload simplificado:", err?.message);
    return { turmas: turmasRows, demanda: [], modulacao: [], disponibilidades: [] };
  }
}

export async function registrarSnapshotPublicacaoAutomatica(
  conn,
  { escolaId, turno, pubRow, slots, usuario = null }
) {
  if (!conn || !pubRow?.id || !Array.isArray(slots) || slots.length === 0) return null;
  await ensureEtapa4Schema(conn);
  const turnoNorm = normTurnoKey(turno);
  const vigencia = await resolverVigenciaLetiva(escolaId, null);
  const verNum = Number(pubRow.version) || 1;
  const metricas = avaliarQualidadePedagogicaSlots({ slots, payload: null, turno: turnoNorm });

  const nomeAuto = pubRow.descricao
    ? `Publicada v${verNum} — ${String(pubRow.descricao).slice(0, 90)}`
    : `Versão Publicada v${verNum}`;

  const [ins] = await conn.query(
    `INSERT INTO grade_cenarios
       (escola_id, turno, ano_letivo, semestre, codigo_cenario, nome, descricao, tipo, favorito,
        total_slots, total_fixos, total_turmas, total_professores, score_qualidade,
        metricas_json, slots_json, criado_por, criado_por_nome)
     VALUES (?, ?, ?, ?, 'PUB', ?, ?, 'PUBLICACAO', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(escolaId),
      turnoNorm,
      Number(vigencia.ano_letivo) || new Date().getFullYear(),
      Number(vigencia.semestre_referencia) || 1,
      nomeAuto,
      `Snapshot automático ao publicar nova versão oficial no turno ${turnoNorm}.`,
      metricas.aulas_alocadas,
      metricas.total_fixos,
      metricas.total_turmas,
      metricas.total_professores,
      metricas.score_qualidade ?? metricas.score_global,
      JSON.stringify(metricas),
      JSON.stringify(slots),
      usuario?.id || null,
      usuario?.nome || null,
    ]
  );
  return ins?.insertId || null;
}

export async function listarCenariosTurno(pool, { escolaId, turno, semestre = null }) {
  await ensureEtapa4Schema(pool);
  const turnoNorm = normTurnoKey(turno);
  const vigencia = await resolverVigenciaLetiva(escolaId, semestre);
  const semRef = Number(vigencia.semestre_referencia) || 1;
  const anoLetivo = Number(vigencia.ano_letivo) || new Date().getFullYear();

  const [payload, [ativosRows], [cenariosRows], [profsRows], [discsRows], [turmasRows]] = await Promise.all([
    buildPayloadParaAvaliacao(pool, escolaId, turnoNorm, semRef),
    pool.query(
      `SELECT id, status, version, descricao, published_at, created_at
         FROM grade_resultado
        WHERE escola_id = ? AND turno = ? AND status IN ('rascunho', 'publicado')
        ORDER BY FIELD(status, 'rascunho', 'publicado'), id DESC`,
      [Number(escolaId), turnoNorm]
    ),
    pool.query(
      `SELECT id, escola_id, turno, ano_letivo, semestre, codigo_cenario, nome, descricao,
              tipo, favorito, total_slots, total_fixos, total_turmas, total_professores,
              score_qualidade, metricas_json, config_snapshot_json, slots_json,
              criado_por, criado_por_nome, created_at, updated_at
         FROM grade_cenarios
        WHERE escola_id = ? AND turno = ? AND ano_letivo = ?
        ORDER BY favorito DESC, FIELD(COALESCE(codigo_cenario, ''), 'A', 'B', 'C', 'CUSTOM', 'PUB', 'BACKUP'), updated_at DESC, id DESC
        LIMIT 40`,
      [Number(escolaId), turnoNorm, anoLetivo]
    ),
    pool.query(`SELECT id, nome, cpf, status FROM professores WHERE escola_id = ? ORDER BY nome`, [Number(escolaId)]),
    pool.query(`SELECT id, nome, abreviatura FROM disciplinas WHERE escola_id = ? ORDER BY nome`, [Number(escolaId)]),
    pool.query(
      `SELECT id, nome, turno, serie, regime FROM turmas WHERE escola_id = ? AND LOWER(turno) = ? AND ano = ? ORDER BY nome`,
      [Number(escolaId), turnoNorm, anoLetivo]
    ),
  ]);

  let rascunhoAtual = null;
  let publicadoAtual = null;

  for (const row of ativosRows || []) {
    if (row.status === "rascunho" && rascunhoAtual) continue;
    if (row.status === "publicado" && publicadoAtual) continue;

    const [slotRows] = await pool.query(
      `SELECT turma_id, dia_semana AS dia, periodo_ordem AS ordem, disciplina_id, professor_id, origem, locked
         FROM grade_slot
        WHERE resultado_id = ?`,
      [row.id]
    );
    if (!slotRows || slotRows.length === 0) continue;

    const metricas = avaliarQualidadePedagogicaSlots({
      slots: slotRows,
      payload,
      turno: turnoNorm,
    });

    const item = {
      id: row.status === "rascunho" ? "ATIVO_RASCUNHO" : "ATIVO_PUBLICADO",
      resultado_id: row.id,
      codigo_cenario: row.status === "rascunho" ? "RASCUNHO" : "OFICIAL",
      nome:
        row.status === "rascunho"
          ? "📋 Rascunho Atual em Edição"
          : `🚀 Horário Publicado Oficial (v${row.version || 1})`,
      descricao: row.descricao || null,
      tipo: row.status === "rascunho" ? "ATIVO_RASCUNHO" : "ATIVO_PUBLICADO",
      is_virtual_ativo: true,
      version: row.version || 1,
      created_at: row.published_at || row.created_at,
      updated_at: row.published_at || row.created_at,
      score_qualidade: metricas.score_global,
      total_slots: metricas.aulas_alocadas,
      total_fixos: metricas.total_fixos,
      total_turmas: metricas.total_turmas,
      total_professores: metricas.total_professores,
      metricas,
      slots: slotRows,
    };

    if (row.status === "rascunho") rascunhoAtual = item;
    if (row.status === "publicado") publicadoAtual = item;
  }

  const cenarios = (cenariosRows || []).map((c) => {
    const slots = safeJsonParse(c.slots_json, []);
    // Reavalia com o payload vigente para manter comparabilidade 100% homogênea entre todos os cenários!
    const metricas = payload
      ? avaliarQualidadePedagogicaSlots({ slots, payload, turno: turnoNorm })
      : safeJsonParse(c.metricas_json, null) ||
        avaliarQualidadePedagogicaSlots({ slots, payload: null, turno: turnoNorm });

    return {
      id: Number(c.id),
      escola_id: Number(c.escola_id),
      turno: c.turno,
      ano_letivo: Number(c.ano_letivo),
      semestre: Number(c.semestre),
      codigo_cenario: c.codigo_cenario || null,
      nome: c.nome,
      descricao: c.descricao || null,
      tipo: c.tipo || "CENARIO",
      favorito: Boolean(c.favorito),
      total_slots: metricas.aulas_alocadas,
      total_fixos: metricas.total_fixos,
      total_turmas: metricas.total_turmas,
      total_professores: metricas.total_professores,
      score_qualidade: metricas.score_global,
      metricas,
      config_snapshot: safeJsonParse(c.config_snapshot_json, null),
      slots,
      criado_por: c.criado_por ? Number(c.criado_por) : null,
      criado_por_nome: c.criado_por_nome || null,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  });

  return {
    turno: turnoNorm,
    vigencia,
    ativos: {
      rascunho: rascunhoAtual,
      publicado: publicadoAtual,
    },
    cenarios,
    catalogo: {
      turmas: turmasRows || [],
      professores: (profsRows || []).map((p) => ({
        id: Number(p.id),
        nome: p.nome,
        cpf_mascarado: mascararCpf(p.cpf),
        status: p.status || "ativo",
      })),
      disciplinas: discsRows || [],
      dias_semana: payload?.dias_semana || [1, 2, 3, 4, 5],
      periodos_por_dia: Number(payload?.periodos_por_dia) || (turnoNorm === "noturno" ? 5 : 6),
    },
  };
}

export async function salvarCenarioGrade(
  pool,
  {
    escolaId,
    turno,
    semestre = null,
    codigo_cenario = null,
    nome,
    descricao = null,
    tipo = "CENARIO",
    favorito = false,
    origem_dados = "rascunho", // 'slots_tela' | 'rascunho' | 'publicado'
    slots_custom = null,
    sobrescrever_codigo = true,
    usuario = null,
  }
) {
  await ensureEtapa4Schema(pool);
  const turnoNorm = normTurnoKey(turno);
  const vigencia = await resolverVigenciaLetiva(escolaId, semestre);
  const semRef = Number(vigencia.semestre_referencia) || 1;
  const anoLetivo = Number(vigencia.ano_letivo) || new Date().getFullYear();

  let slotsFonte = [];
  if (Array.isArray(slots_custom) && slots_custom.length > 0) {
    slotsFonte = slots_custom;
  } else {
    const statusAlvo = origem_dados === "publicado" ? "publicado" : "rascunho";
    const [[resRow]] = await pool.query(
      `SELECT id FROM grade_resultado WHERE escola_id = ? AND turno = ? AND status = ? LIMIT 1`,
      [Number(escolaId), turnoNorm, statusAlvo]
    );
    if (!resRow?.id) {
      throw new Error(
        statusAlvo === "publicado"
          ? "Não há horário publicado neste turno para salvar como cenário."
          : "Não há rascunho salvo neste turno. Gere ou salve um rascunho primeiro."
      );
    }
    const [dbSlots] = await pool.query(
      `SELECT turma_id, dia_semana AS dia, periodo_ordem AS ordem, disciplina_id, professor_id, origem, locked
         FROM grade_slot
        WHERE resultado_id = ?`,
      [resRow.id]
    );
    slotsFonte = dbSlots || [];
  }

  if (!slotsFonte.length) {
    throw new Error("A grade selecionada está vazia (0 aulas alocadas).");
  }

  const payload = await buildPayloadParaAvaliacao(pool, escolaId, turnoNorm, semRef);
  const metricas = avaliarQualidadePedagogicaSlots({
    slots: slotsFonte,
    payload,
    turno: turnoNorm,
  });

  const codigoLimpo = codigo_cenario
    ? String(codigo_cenario).trim().toUpperCase().slice(0, 16)
    : null;
  const nomeFinal = String(
    nome ||
      (codigoLimpo && ["A", "B", "C"].includes(codigoLimpo)
        ? `Cenário ${codigoLimpo} (${turnoNorm.charAt(0).toUpperCase() + turnoNorm.slice(1)})`
        : `Cenário salvo em ${new Date().toLocaleDateString("pt-BR")}`)
  )
    .trim()
    .slice(0, 155);

  const configSnapshot = payload?.config_pedagogica?.regras_gerais || null;

  // Se for um slot nomeado (ex.: 'A', 'B' ou 'C') e sobrescrever_codigo === true, atualiza o registro existente
  if (sobrescrever_codigo && codigoLimpo && ["A", "B", "C"].includes(codigoLimpo) && tipo === "CENARIO") {
    const [[existente]] = await pool.query(
      `SELECT id FROM grade_cenarios
        WHERE escola_id = ? AND turno = ? AND ano_letivo = ? AND codigo_cenario = ? AND tipo = 'CENARIO'
        ORDER BY id DESC LIMIT 1`,
      [Number(escolaId), turnoNorm, anoLetivo, codigoLimpo]
    );

    if (existente?.id) {
      await pool.query(
        `UPDATE grade_cenarios
            SET semestre = ?,
                nome = ?,
                descricao = ?,
                favorito = ?,
                total_slots = ?,
                total_fixos = ?,
                total_turmas = ?,
                total_professores = ?,
                score_qualidade = ?,
                metricas_json = ?,
                config_snapshot_json = ?,
                slots_json = ?,
                criado_por = ?,
                criado_por_nome = ?
          WHERE id = ? AND escola_id = ?`,
        [
          semRef,
          nomeFinal,
          descricao || null,
          favorito ? 1 : 0,
          metricas.aulas_alocadas,
          metricas.total_fixos,
          metricas.total_turmas,
          metricas.total_professores,
          metricas.score_global,
          JSON.stringify(metricas),
          configSnapshot ? JSON.stringify(configSnapshot) : null,
          JSON.stringify(slotsFonte),
          usuario?.id || null,
          usuario?.nome || null,
          existente.id,
          Number(escolaId),
        ]
      );
      return {
        cenario_id: Number(existente.id),
        atualizado: true,
        codigo_cenario: codigoLimpo,
        nome: nomeFinal,
        score_qualidade: metricas.score_global,
        metricas,
      };
    }
  }

  const [ins] = await pool.query(
    `INSERT INTO grade_cenarios
       (escola_id, turno, ano_letivo, semestre, codigo_cenario, nome, descricao, tipo, favorito,
        total_slots, total_fixos, total_turmas, total_professores, score_qualidade,
        metricas_json, config_snapshot_json, slots_json, criado_por, criado_por_nome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(escolaId),
      turnoNorm,
      anoLetivo,
      semRef,
      codigoLimpo,
      nomeFinal,
      descricao || null,
      tipo || "CENARIO",
      favorito ? 1 : 0,
      metricas.aulas_alocadas,
      metricas.total_fixos,
      metricas.total_turmas,
      metricas.total_professores,
      metricas.score_global,
      JSON.stringify(metricas),
      configSnapshot ? JSON.stringify(configSnapshot) : null,
      JSON.stringify(slotsFonte),
      usuario?.id || null,
      usuario?.nome || null,
    ]
  );

  return {
    cenario_id: Number(ins.insertId),
    atualizado: false,
    codigo_cenario: codigoLimpo,
    nome: nomeFinal,
    score_qualidade: metricas.score_global,
    metricas,
  };
}

export async function atualizarMetadadosCenario(
  pool,
  { escolaId, cenarioId, nome, descricao, codigo_cenario, favorito }
) {
  await ensureEtapa4Schema(pool);
  const [[row]] = await pool.query(
    `SELECT id, nome, descricao, codigo_cenario, favorito FROM grade_cenarios WHERE id = ? AND escola_id = ? LIMIT 1`,
    [Number(cenarioId), Number(escolaId)]
  );
  if (!row) throw new Error("Cenário não encontrado.");

  const novoNome = nome !== undefined ? String(nome).trim().slice(0, 155) : row.nome;
  const novaDesc = descricao !== undefined ? (descricao ? String(descricao).slice(0, 250) : null) : row.descricao;
  const novoCod =
    codigo_cenario !== undefined
      ? codigo_cenario
        ? String(codigo_cenario).trim().toUpperCase().slice(0, 16)
        : null
      : row.codigo_cenario;
  const novoFav = favorito !== undefined ? (favorito ? 1 : 0) : Number(row.favorito);

  await pool.query(
    `UPDATE grade_cenarios SET nome = ?, descricao = ?, codigo_cenario = ?, favorito = ? WHERE id = ? AND escola_id = ?`,
    [novoNome, novaDesc, novoCod, novoFav, Number(cenarioId), Number(escolaId)]
  );
  return { ok: true, id: Number(cenarioId), nome: novoNome, codigo_cenario: novoCod, favorito: Boolean(novoFav) };
}

export async function excluirCenarioGrade(pool, { escolaId, cenarioId }) {
  await ensureEtapa4Schema(pool);
  const [res] = await pool.query(
    `DELETE FROM grade_cenarios WHERE id = ? AND escola_id = ?`,
    [Number(cenarioId), Number(escolaId)]
  );
  return { ok: true, removidos: res?.affectedRows || 0 };
}

export async function aplicarCenarioNaGrade(
  pool,
  { escolaId, cenarioId, publicarDireto = false, usuario = null }
) {
  await ensureEtapa4Schema(pool);
  const conn = await pool.getConnection();
  try {
    await ensureGradeSlotMultiTurmaSupport(conn);
    await conn.beginTransaction();

    const [[cenario]] = await conn.query(
      `SELECT * FROM grade_cenarios WHERE id = ? AND escola_id = ? LIMIT 1`,
      [Number(cenarioId), Number(escolaId)]
    );
    if (!cenario) throw new Error("Cenário não encontrado.");

    const turnoNorm = normTurnoKey(cenario.turno);
    const slotsCenario = safeJsonParse(cenario.slots_json, []);
    if (!Array.isArray(slotsCenario) || slotsCenario.length === 0) {
      throw new Error("Este cenário não possui aulas válidas para restauração.");
    }

    // 1) Cria backup automático de segurança do rascunho atual (se existir e tiver slots)
    const [[rasAtual]] = await conn.query(
      `SELECT id FROM grade_resultado WHERE escola_id = ? AND turno = ? AND status = 'rascunho' LIMIT 1`,
      [Number(escolaId), turnoNorm]
    );
    let backupId = null;

    if (rasAtual?.id) {
      const [slotsAtuais] = await conn.query(
        `SELECT turma_id, dia_semana AS dia, periodo_ordem AS ordem, disciplina_id, professor_id, origem, locked
           FROM grade_slot WHERE resultado_id = ?`,
        [rasAtual.id]
      );
      if (slotsAtuais?.length > 0) {
        const mBkp = avaliarQualidadePedagogicaSlots({ slots: slotsAtuais, payload: null, turno: turnoNorm });
        const [insBkp] = await conn.query(
          `INSERT INTO grade_cenarios
             (escola_id, turno, ano_letivo, semestre, codigo_cenario, nome, descricao, tipo, favorito,
              total_slots, total_fixos, total_turmas, total_professores, score_qualidade,
              metricas_json, slots_json, criado_por, criado_por_nome)
           VALUES (?, ?, ?, ?, 'BACKUP', ?, ?, 'BACKUP_AUTO', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            Number(escolaId),
            turnoNorm,
            Number(cenario.ano_letivo) || new Date().getFullYear(),
            Number(cenario.semestre) || 1,
            `Backup Automático (antes de aplicar "${String(cenario.nome).slice(0, 75)}")`,
            `Cópia automática do rascunho anterior para reversão imediata caso necessário.`,
            mBkp.aulas_alocadas,
            mBkp.total_fixos,
            mBkp.total_turmas,
            mBkp.total_professores,
            mBkp.score_global,
            JSON.stringify(mBkp),
            JSON.stringify(slotsAtuais),
            usuario?.id || null,
            usuario?.nome || null,
          ]
        );
        backupId = insBkp?.insertId || null;
      }
    }

    // 2) Garante cabeçalho de rascunho e restaura todos os slots do cenário
    let draftId = rasAtual?.id || null;
    if (!draftId) {
      const [insRas] = await conn.query(
        `INSERT INTO grade_resultado (escola_id, turno, status, version, descricao)
         VALUES (?, ?, 'rascunho', 1, ?)`,
        [Number(escolaId), turnoNorm, String(cenario.nome).slice(0, 115)]
      );
      draftId = insRas.insertId;
    } else {
      await conn.query(
        `UPDATE grade_resultado SET descricao = ? WHERE id = ?`,
        [String(cenario.nome).slice(0, 115), draftId]
      );
      await conn.query(`DELETE FROM grade_slot WHERE resultado_id = ?`, [draftId]);
      await conn.query(`DELETE FROM grade_resultado_turma WHERE resultado_id = ?`, [draftId]);
    }

    const turmaIds = Array.from(
      new Set(slotsCenario.map((s) => Number(s.turma_id)).filter((n) => n > 0))
    );
    if (turmaIds.length > 0) {
      await conn.query(
        `INSERT IGNORE INTO grade_resultado_turma (resultado_id, turma_id) VALUES ?`,
        [turmaIds.map((tid) => [draftId, tid])]
      );
    }

    for (const s of slotsCenario) {
      const tId = Number(s.turma_id);
      const dia = Number(s.dia ?? s.dia_semana);
      const ord = Number(s.ordem ?? s.periodo_ordem);
      const dId = Number(s.disciplina_id);
      const pId = Number(s.professor_id);
      if (!tId || !dia || !ord || !dId || !pId) continue;
      const origem = ["manual", "solver", "mock"].includes(String(s.origem || "").toLowerCase())
        ? String(s.origem).toLowerCase()
        : s.locked
        ? "manual"
        : "solver";
      const locked = s.locked ? 1 : 0;

      await conn.query(
        `INSERT INTO grade_slot
           (resultado_id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           disciplina_id = VALUES(disciplina_id),
           professor_id = VALUES(professor_id),
           origem = VALUES(origem),
           locked = VALUES(locked)`,
        [draftId, tId, dia, ord, dId, pId, origem, locked]
      );
    }

    // 3) Opcional: se publicarDireto === true, arquiva o publicado anterior com snapshot e promove!
    let publicadoId = null;
    if (publicarDireto) {
      const [[pubAnt]] = await conn.query(
        `SELECT id, version, descricao FROM grade_resultado WHERE escola_id = ? AND turno = ? AND status = 'publicado' LIMIT 1`,
        [Number(escolaId), turnoNorm]
      );
      let nextVersion = 1;
      if (pubAnt?.id) {
        nextVersion = (Number(pubAnt.version) || 1) + 1;
        const [pubSlotsAnt] = await conn.query(
          `SELECT turma_id, dia_semana AS dia, periodo_ordem AS ordem, disciplina_id, professor_id, origem, locked
             FROM grade_slot WHERE resultado_id = ?`,
          [pubAnt.id]
        );
        await registrarSnapshotPublicacaoAutomatica(conn, {
          escolaId,
          turno: turnoNorm,
          pubRow: pubAnt,
          slots: pubSlotsAnt,
          usuario,
        });
        await conn.query(`UPDATE grade_resultado SET status = 'arquivado' WHERE id = ?`, [pubAnt.id]);
      }

      const [insPub] = await conn.query(
        `INSERT INTO grade_resultado (escola_id, turno, status, version, descricao, published_at)
         VALUES (?, ?, 'publicado', ?, ?, NOW())`,
        [Number(escolaId), turnoNorm, nextVersion, String(cenario.nome).slice(0, 115)]
      );
      publicadoId = insPub.insertId;

      if (turmaIds.length > 0) {
        await conn.query(
          `INSERT IGNORE INTO grade_resultado_turma (resultado_id, turma_id) VALUES ?`,
          [turmaIds.map((tid) => [publicadoId, tid])]
        );
      }
      await conn.query(
        `INSERT INTO grade_slot
           (resultado_id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked)
         SELECT ?, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked
           FROM grade_slot WHERE resultado_id = ?`,
        [publicadoId, draftId]
      );
    }

    await conn.commit();
    return {
      ok: true,
      cenario_id: Number(cenario.id),
      nome_cenario: cenario.nome,
      rascunho_id: draftId,
      publicado_id: publicadoId,
      backup_criado_id: backupId,
      total_slots_restaurados: slotsCenario.length,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ============================================================================
// 4. SUBSTITUIÇÃO DE PROFESSORES COM PRESERVAÇÃO 100% DE DIÁRIOS E REVERSÃO
// ============================================================================
export async function simularSubstituicaoProfessor(
  pool,
  {
    escolaId,
    turno,
    semestre = null,
    professor_titular_id,
    professor_substituto_id,
    turma_ids_filtro = null, // Array opcional de turma_ids (se vazio/null, considera todas do titular no turno)
  }
) {
  await ensureEtapa4Schema(pool);
  const turnoNorm = normTurnoKey(turno);
  const titularId = Number(professor_titular_id);
  const substitutoId = Number(professor_substituto_id);

  if (!titularId || !substitutoId) {
    throw new Error("Selecione o professor titular e o professor substituto.");
  }
  if (titularId === substitutoId) {
    throw new Error("O professor substituto deve ser diferente do professor titular.");
  }

  const vigencia = await resolverVigenciaLetiva(escolaId, semestre);
  const anoLetivo = Number(vigencia.ano_letivo) || new Date().getFullYear();
  const semRef = Number(vigencia.semestre_referencia) || 1;

  const [[[titular]], [[substituto]]] = await Promise.all([
    pool.query(`SELECT id, nome, cpf, status FROM professores WHERE id = ? AND escola_id = ? LIMIT 1`, [
      titularId,
      Number(escolaId),
    ]),
    pool.query(`SELECT id, nome, cpf, status FROM professores WHERE id = ? AND escola_id = ? LIMIT 1`, [
      substitutoId,
      Number(escolaId),
    ]),
  ]);

  if (!titular) throw new Error("Professor titular não encontrado nesta escola.");
  if (!substituto) throw new Error("Professor substituto não encontrado nesta escola.");

  const filtroTurmasSet =
    Array.isArray(turma_ids_filtro) && turma_ids_filtro.length > 0
      ? new Set(turma_ids_filtro.map(Number).filter((n) => n > 0))
      : null;

  // 1) Grades ativas do turno (rascunho e publicado)
  const [resRows] = await pool.query(
    `SELECT id, status, version FROM grade_resultado
      WHERE escola_id = ? AND turno = ? AND status IN ('rascunho', 'publicado')`,
    [Number(escolaId), turnoNorm]
  );
  const resIds = (resRows || []).map((r) => Number(r.id));
  const resStatusById = new Map((resRows || []).map((r) => [Number(r.id), r.status]));

  let slotsTitular = [];
  let slotsSubstitutoMesmoTurno = [];

  if (resIds.length > 0) {
    const ph = resIds.map(() => "?").join(",");
    const [sTit] = await pool.query(
      `SELECT gs.id, gs.resultado_id, gs.turma_id, t.nome AS turma_nome,
              gs.dia_semana AS dia, gs.periodo_ordem AS ordem,
              gs.disciplina_id, d.nome AS disciplina_nome, gs.locked, gs.origem
         FROM grade_slot gs
         LEFT JOIN turmas t ON t.id = gs.turma_id
         LEFT JOIN disciplinas d ON d.id = gs.disciplina_id
        WHERE gs.resultado_id IN (${ph}) AND gs.professor_id = ?
        ORDER BY gs.dia_semana, gs.periodo_ordem, t.nome`,
      [...resIds, titularId]
    );
    slotsTitular = (sTit || []).filter((s) => !filtroTurmasSet || filtroTurmasSet.has(Number(s.turma_id)));

    const [sSub] = await pool.query(
      `SELECT gs.resultado_id, gs.turma_id, t.nome AS turma_nome,
              gs.dia_semana AS dia, gs.periodo_ordem AS ordem,
              gs.disciplina_id, d.nome AS disciplina_nome
         FROM grade_slot gs
         LEFT JOIN turmas t ON t.id = gs.turma_id
         LEFT JOIN disciplinas d ON d.id = gs.disciplina_id
        WHERE gs.resultado_id IN (${ph}) AND gs.professor_id = ?`,
      [...resIds, substitutoId]
    );
    slotsSubstitutoMesmoTurno = sSub || [];
  }

  // 2) Modulação regular + Agrupamentos (IFA/Eletiva) do titular no turno
  const [modTitularRows] = await pool.query(
    `SELECT m.id, m.turma_id, t.nome AS turma_nome, t.turno, m.disciplina_id, d.nome AS disciplina_nome,
            m.aulas, m.semestre
       FROM modulacao m
       JOIN turmas t ON t.id = m.turma_id AND t.escola_id = m.escola_id
       LEFT JOIN disciplinas d ON d.id = m.disciplina_id
      WHERE m.escola_id = ? AND m.professor_id = ? AND LOWER(t.turno) = ? AND t.ano = ?`,
    [Number(escolaId), titularId, turnoNorm, anoLetivo]
  );
  const modulacoesAfetadas = (modTitularRows || []).filter(
    (m) => !filtroTurmasSet || filtroTurmasSet.has(Number(m.turma_id))
  );

  const [agrTitularRows] = await pool
    .query(
      `SELECT am.id, am.agrupamento_id, a.nome AS agrupamento_nome, am.disciplina_id, d.nome AS disciplina_nome, am.aulas
         FROM agrupamento_modulacao am
         JOIN agrupamentos a ON a.id = am.agrupamento_id
         LEFT JOIN disciplinas d ON d.id = am.disciplina_id
        WHERE am.escola_id = ? AND am.professor_id = ?
          AND a.ano_letivo = ? AND a.status <> 'ENCERRADO'
          AND (LOWER(a.turno) = ? OR LOWER(a.turno) = 'integral')`,
      [Number(escolaId), titularId, anoLetivo, turnoNorm]
    )
    .catch(() => [[]]);

  // 3) Verificação de Diários / Planos Avaliativos / Notas que serão 100% preservados
  const paresTurmaDiscNomes = new Map();
  for (const m of modulacoesAfetadas) {
    if (m.turma_nome && m.disciplina_nome) {
      paresTurmaDiscNomes.set(`${m.turma_nome}|${m.disciplina_nome}`, {
        turma_nome: m.turma_nome,
        disciplina_nome: m.disciplina_nome,
        turma_id: Number(m.turma_id),
        disciplina_id: Number(m.disciplina_id),
      });
    }
  }
  for (const s of slotsTitular) {
    if (s.turma_nome && s.disciplina_nome) {
      paresTurmaDiscNomes.set(`${s.turma_nome}|${s.disciplina_nome}`, {
        turma_nome: s.turma_nome,
        disciplina_nome: s.disciplina_nome,
        turma_id: Number(s.turma_id),
        disciplina_id: Number(s.disciplina_id),
      });
    }
  }

  let planosDiarioPreservados = 0;
  let registrosNotasPreservados = 0;
  const paresArr = Array.from(paresTurmaDiscNomes.values());

  if (paresArr.length > 0) {
    try {
      const conds = paresArr.map(() => "(turmas = ? AND disciplina = ?)").join(" OR ");
      const paramsPlanos = [Number(escolaId), anoLetivo];
      for (const p of paresArr) paramsPlanos.push(p.turma_nome, p.disciplina_nome);
      const [[cntPlanos]] = await pool.query(
        `SELECT COUNT(*) AS total FROM planos_avaliacao WHERE escola_id = ? AND ano = ? AND (${conds})`,
        paramsPlanos
      );
      planosDiarioPreservados = Number(cntPlanos?.total) || 0;
    } catch {
      planosDiarioPreservados = 0;
    }

    try {
      const tIds = Array.from(new Set(paresArr.map((p) => p.turma_id).filter(Boolean)));
      const dIds = Array.from(new Set(paresArr.map((p) => p.disciplina_id).filter(Boolean)));
      if (tIds.length && dIds.length) {
        const [[cntNotas]] = await pool.query(
          `SELECT COUNT(*) AS total
             FROM notas n
             JOIN alunos a ON a.id = n.aluno_id
            WHERE n.escola_id = ? AND n.ano = ? AND a.turma_id IN (?) AND n.disciplina_id IN (?)`,
          [Number(escolaId), anoLetivo, tIds, dIds]
        );
        registrosNotasPreservados = Number(cntNotas?.total) || 0;
      }
    } catch {
      registrosNotasPreservados = 0;
    }
  }

  // 4) Checagem de Colisão H2 no mesmo turno + Inter-Turnos CPF + Disponibilidade do Substituto
  const paresUnidosSet = await carregarParesTurmasUnidasPermitidas(pool, escolaId, turnoNorm);
  const subSlotIndex = new Map();
  for (const ss of slotsSubstitutoMesmoTurno) {
    const k = `${ss.resultado_id}|${ss.dia}|${ss.ordem}`;
    if (!subSlotIndex.has(k)) subSlotIndex.set(k, []);
    subSlotIndex.get(k).push(ss);
  }

  const horariosInfo = await resolverHorariosReaisPorTurno(escolaId, anoLetivo, pool).catch(() => ({
    horarios_por_turno: {},
  }));
  const restricoesInterSub = await fetchRestricoesInterTurnosPorCpf(pool, {
    escolaId: Number(escolaId),
    turnoNorm,
    profIds: [substitutoId],
    horariosPorTurno: horariosInfo?.horarios_por_turno || {},
    diasSemana: [1, 2, 3, 4, 5, 6],
    periodosPorDia: turnoNorm === "noturno" ? 5 : 6,
    regrasGerais: {},
  });
  const interSubMap = new Map();
  for (const it of restricoesInterSub?.slots || []) {
    interSubMap.set(`${it.dia}|${it.ordem}`, it);
  }

  // Disponibilidade do substituto no turno
  const [dispSubRows] = await pool
    .query(
      `SELECT dia_semana AS dia, periodos FROM grade_disponibilidades WHERE escola_id = ? AND LOWER(turno) = ? AND professor_id = ?`,
      [Number(escolaId), turnoNorm, substitutoId]
    )
    .catch(() => [[]]);
  const dispSubMap = new Map();
  for (const r of dispSubRows || []) {
    const arr = safeJsonParse(r.periodos, []);
    for (const p of arr || []) {
      if (p?.ordem) dispSubMap.set(`${Number(r.dia)}|${Number(p.ordem)}`, String(p.status || "livre").toLowerCase());
    }
  }

  // Consolida slots únicos visíveis (priorizando rascunho se existir, senão publicado) para exibição clara
  const prefStatus = resRows.some((r) => r.status === "rascunho") ? "rascunho" : "publicado";
  const slotsVisiveis = slotsTitular.filter((s) => resStatusById.get(Number(s.resultado_id)) === prefStatus);

  const colisoesMesmoTurno = [];
  const alertasInterturnoCpf = [];
  const alertasIndisponibilidade = [];

  for (const s of slotsVisiveis) {
    const ocupadosSub = subSlotIndex.get(`${s.resultado_id}|${s.dia}|${s.ordem}`) || [];
    for (const oc of ocupadosSub) {
      if (!saoTurmasUnidasPermitidas(paresUnidosSet, Number(s.turma_id), Number(oc.turma_id), false)) {
        colisoesMesmoTurno.push({
          dia: Number(s.dia),
          ordem: Number(s.ordem),
          turma_titular: s.turma_nome || `Turma ${s.turma_id}`,
          disciplina_titular: s.disciplina_nome || "",
          turma_conflito_substituto: oc.turma_nome || `Turma ${oc.turma_id}`,
          disciplina_conflito_substituto: oc.disciplina_nome || "",
        });
      }
    }

    const interHit = interSubMap.get(`${s.dia}|${s.ordem}`);
    if (interHit) {
      alertasInterturnoCpf.push({
        dia: Number(s.dia),
        ordem: Number(s.ordem),
        turma_nome: s.turma_nome || `Turma ${s.turma_id}`,
        tipo: interHit.tipo,
        status: interHit.status,
        motivo: interHit.motivo || interHit.descricao || "Conflito/Interjornada em outro turno (CPF)",
      });
    }

    const stDisp = dispSubMap.get(`${s.dia}|${s.ordem}`);
    if (stDisp === "indisponivel" || stDisp === "bloqueado") {
      alertasIndisponibilidade.push({
        dia: Number(s.dia),
        ordem: Number(s.ordem),
        turma_nome: s.turma_nome || `Turma ${s.turma_id}`,
      });
    }
  }

  // Lista única de turmas onde o titular atua no turno (para permitir seleção granular na UI)
  const turmasTitularMap = new Map();
  for (const m of modTitularRows || []) {
    const tid = Number(m.turma_id);
    if (!turmasTitularMap.has(tid)) {
      turmasTitularMap.set(tid, {
        turma_id: tid,
        turma_nome: m.turma_nome || `Turma ${tid}`,
        disciplinas: new Set(),
        aulas_moduladas: 0,
        slots_na_grade: 0,
      });
    }
    const entry = turmasTitularMap.get(tid);
    if (m.disciplina_nome) entry.disciplinas.add(m.disciplina_nome);
    entry.aulas_moduladas += Number(m.aulas) || 0;
  }
  for (const s of slotsTitular.filter((x) => resStatusById.get(Number(x.resultado_id)) === prefStatus)) {
    const tid = Number(s.turma_id);
    if (!turmasTitularMap.has(tid)) {
      turmasTitularMap.set(tid, {
        turma_id: tid,
        turma_nome: s.turma_nome || `Turma ${tid}`,
        disciplinas: new Set(),
        aulas_moduladas: 0,
        slots_na_grade: 0,
      });
    }
    const entry = turmasTitularMap.get(tid);
    if (s.disciplina_nome) entry.disciplinas.add(s.disciplina_nome);
    entry.slots_na_grade++;
  }

  const turmasDisponiveisTitular = Array.from(turmasTitularMap.values()).map((t) => ({
    ...t,
    disciplinas: Array.from(t.disciplinas),
  }));

  return {
    ok: true,
    turno: turnoNorm,
    ano_letivo: anoLetivo,
    semestre: semRef,
    titular: {
      id: Number(titular.id),
      nome: titular.nome,
      cpf_mascarado: mascararCpf(titular.cpf),
      status: titular.status,
    },
    substituto: {
      id: Number(substituto.id),
      nome: substituto.nome,
      cpf_mascarado: mascararCpf(substituto.cpf),
      status: substituto.status,
    },
    turmas_disponiveis_titular: turmasDisponiveisTitular,
    resumo_impacto: {
      slots_grade_visiveis: slotsVisiveis.length,
      slots_rascunho_total: slotsTitular.filter((s) => resStatusById.get(Number(s.resultado_id)) === "rascunho").length,
      slots_publicado_total: slotsTitular.filter((s) => resStatusById.get(Number(s.resultado_id)) === "publicado").length,
      turmas_afetadas: new Set([
        ...modulacoesAfetadas.map((m) => Number(m.turma_id)),
        ...slotsVisiveis.map((s) => Number(s.turma_id)),
      ]).size,
      modulacoes_regulares: modulacoesAfetadas.length,
      agrupamentos_ifa: (agrTitularRows || []).length,
      planos_diario_preservados: planosDiarioPreservados,
      registros_notas_preservados: registrosNotasPreservados,
    },
    validacoes: {
      pode_substituir_direto: colisoesMesmoTurno.length === 0,
      colisoes_mesmo_turno: colisoesMesmoTurno,
      alertas_interturno_cpf: alertasInterturnoCpf,
      alertas_indisponibilidade: alertasIndisponibilidade,
    },
    slots_detalhe: slotsVisiveis.map((s) => ({
      turma_id: Number(s.turma_id),
      turma_nome: s.turma_nome,
      dia: Number(s.dia),
      ordem: Number(s.ordem),
      disciplina_id: Number(s.disciplina_id),
      disciplina_nome: s.disciplina_nome,
      locked: Boolean(s.locked),
    })),
  };
}

export async function executarSubstituicaoProfessor(
  pool,
  {
    escolaId,
    turno,
    semestre = null,
    professor_titular_id,
    professor_substituto_id,
    turma_ids_filtro = null,
    motivo = "SUBSTITUICAO_TEMPORARIA",
    observacao = null,
    data_inicio = null,
    data_fim_prevista = null,
    sincronizar_modulacao = true,
    manter_fixacoes = true,
    pular_slots_em_colisao = false,
    inativar_titular = false,
    usuario = null,
  }
) {
  await ensureEtapa4Schema(pool);
  const simulacao = await simularSubstituicaoProfessor(pool, {
    escolaId,
    turno,
    semestre,
    professor_titular_id,
    professor_substituto_id,
    turma_ids_filtro,
  });

  if (simulacao.validacoes.colisoes_mesmo_turno.length > 0 && !pular_slots_em_colisao) {
    const c0 = simulacao.validacoes.colisoes_mesmo_turno[0];
    const err = new Error(
      `Choque de horário no turno: ${simulacao.substituto.nome} já leciona na turma ${c0.turma_conflito_substituto} (${c0.dia}º dia, ${c0.ordem}º horário). Marque a opção de pular/desalocar os horários conflitantes ou ajuste o horário do substituto primeiro.`
    );
    err.code = "SUBSTITUICAO_COLISAO_TURNO";
    err.simulacao = simulacao;
    throw err;
  }

  const turnoNorm = normTurnoKey(turno);
  const titularId = Number(professor_titular_id);
  const substitutoId = Number(professor_substituto_id);
  const filtroTurmasSet =
    Array.isArray(turma_ids_filtro) && turma_ids_filtro.length > 0
      ? new Set(turma_ids_filtro.map(Number).filter((n) => n > 0))
      : null;

  const conn = await pool.getConnection();
  try {
    await ensureGradeSlotMultiTurmaSupport(conn);
    await conn.beginTransaction();

    const [[titularRow]] = await conn.query(
      `SELECT id, nome, cpf, status FROM professores WHERE id = ? AND escola_id = ? LIMIT 1`,
      [titularId, Number(escolaId)]
    );
    const [[substitutoRow]] = await conn.query(
      `SELECT id, nome, cpf, status FROM professores WHERE id = ? AND escola_id = ? LIMIT 1`,
      [substitutoId, Number(escolaId)]
    );
    if (substitutoRow?.status === "inativo") {
      throw new Error("O professor substituto está inativo. Ative o cadastro dele antes de substituir.");
    }

    const paresUnidosSet = await carregarParesTurmasUnidasPermitidas(conn, escolaId, turnoNorm);

    // 1) Snapshot e atualização atômica dos slots em grade_slot (rascunho + publicado do turno)
    const [resRows] = await conn.query(
      `SELECT id, status FROM grade_resultado
        WHERE escola_id = ? AND turno = ? AND status IN ('rascunho', 'publicado')`,
      [Number(escolaId), turnoNorm]
    );
    const resIds = (resRows || []).map((r) => Number(r.id));
    const snapshotSlots = [];
    let slotsTransferidosCount = 0;
    let slotsPuladosColisaoCount = 0;

    if (resIds.length > 0) {
      const ph = resIds.map(() => "?").join(",");
      const [slotsTit] = await conn.query(
        `SELECT id, resultado_id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked
           FROM grade_slot
          WHERE resultado_id IN (${ph}) AND professor_id = ? FOR UPDATE`,
        [...resIds, titularId]
      );

      for (const s of slotsTit || []) {
        if (filtroTurmasSet && !filtroTurmasSet.has(Number(s.turma_id))) continue;

        // Verifica se substituto já ocupa outra turma não-unida neste mesmo resultado_id/dia/ordem
        const [confSub] = await conn.query(
          `SELECT turma_id FROM grade_slot
            WHERE resultado_id = ? AND professor_id = ? AND dia_semana = ? AND periodo_ordem = ? AND turma_id <> ?`,
          [s.resultado_id, substitutoId, s.dia_semana, s.periodo_ordem, s.turma_id]
        );
        const temColisao = (confSub || []).some(
          (c) => !saoTurmasUnidasPermitidas(paresUnidosSet, Number(s.turma_id), Number(c.turma_id), false)
        );
        if (temColisao) {
          slotsPuladosColisaoCount++;
          continue;
        }

        snapshotSlots.push({ ...s });
        const novoLocked = manter_fixacoes ? Number(s.locked) : 0;
        await conn.query(
          `UPDATE grade_slot SET professor_id = ?, locked = ? WHERE id = ?`,
          [substitutoId, novoLocked, s.id]
        );
        slotsTransferidosCount++;
      }
    }

    // 2) Snapshot e transferência atômica da Modulação Regular + Vínculos + Agrupamentos (IFA)
    //    (Essencial para liberar imediatamente Planos de Avaliação / Diários / Chamada / Meu Horário ao substituto
    //     sem apagar absolutamente NENHUM registro histórico lançado pelo titular!)
    const snapshotModulacao = [];
    const snapshotAgrupamentoMod = [];

    if (sincronizar_modulacao) {
      const [modRows] = await conn.query(
        `SELECT m.id, m.escola_id, m.professor_id, m.turma_id, m.disciplina_id, m.aulas, COALESCE(m.semestre, 0) AS semestre,
                t.turno, t.nome AS turma_nome, d.nome AS disciplina_nome
           FROM modulacao m
           JOIN turmas t ON t.id = m.turma_id AND t.escola_id = m.escola_id
           LEFT JOIN disciplinas d ON d.id = m.disciplina_id
          WHERE m.escola_id = ? AND m.professor_id = ? AND LOWER(t.turno) = ? AND t.ano = ? FOR UPDATE`,
        [Number(escolaId), titularId, turnoNorm, simulacao.ano_letivo]
      );

      for (const m of modRows || []) {
        if (filtroTurmasSet && !filtroTurmasSet.has(Number(m.turma_id))) continue;
        snapshotModulacao.push({
          id: m.id,
          escola_id: m.escola_id,
          professor_id: m.professor_id,
          turma_id: m.turma_id,
          disciplina_id: m.disciplina_id,
          aulas: m.aulas,
          semestre: m.semestre,
          turma_nome: m.turma_nome,
          disciplina_nome: m.disciplina_nome,
        });

        // Garante vínculo ativo em professor_vinculos para o substituto
        await conn
          .query(
            `INSERT IGNORE INTO professor_vinculos (professor_id, escola_id, turno, disciplina_id, aulas, semestre, status)
             VALUES (?, ?, ?, ?, ?, ?, 'ativo')`,
            [substitutoId, Number(escolaId), m.turno || turnoNorm.toUpperCase(), m.disciplina_id, m.aulas || 1, m.semestre || 0]
          )
          .catch(async () => {
            await conn
              .query(
                `INSERT IGNORE INTO professor_vinculos (professor_id, escola_id, turno, disciplina_id, aulas, status)
                 VALUES (?, ?, ?, ?, ?, 'ativo')`,
                [substitutoId, Number(escolaId), m.turno || turnoNorm.toUpperCase(), m.disciplina_id, m.aulas || 1]
              )
              .catch(() => {});
          });

        // Transfere a linha de modulação para o substituto e registra em modulacao_historico
        await conn.query(`DELETE FROM modulacao WHERE id = ? AND escola_id = ?`, [m.id, Number(escolaId)]);
        const [insMod] = await conn.query(
          `INSERT INTO modulacao (escola_id, professor_id, turma_id, disciplina_id, aulas, semestre)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE aulas = VALUES(aulas)`,
          [Number(escolaId), substitutoId, m.turma_id, m.disciplina_id, m.aulas || 1, m.semestre || 0]
        );

        await conn
          .query(
            `INSERT INTO modulacao_historico (escola_id, modulacao_id, professor_id, turma_id, disciplina_id, semestre, aulas, operacao, usuario_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'SUBSTITUICAO_SAIDA', ?),
                    (?, ?, ?, ?, ?, ?, ?, 'SUBSTITUICAO_ENTRADA', ?)`,
            [
              Number(escolaId), m.id, titularId, m.turma_id, m.disciplina_id, m.semestre || 0, m.aulas || 1, usuario?.id || null,
              Number(escolaId), insMod?.insertId || null, substitutoId, m.turma_id, m.disciplina_id, m.semestre || 0, m.aulas || 1, usuario?.id || null,
            ]
          )
          .catch(() => {});
      }

      // Se não restringiu turmas específicas, transfere também agrupamento_modulacao (IFAs/Eletivas do turno)
      if (!filtroTurmasSet) {
        const [agrRows] = await conn
          .query(
            `SELECT am.id, am.agrupamento_id, am.professor_id, am.disciplina_id, am.aulas
               FROM agrupamento_modulacao am
               JOIN agrupamentos a ON a.id = am.agrupamento_id
              WHERE am.escola_id = ? AND am.professor_id = ?
                AND a.ano_letivo = ? AND a.status <> 'ENCERRADO'
                AND (LOWER(a.turno) = ? OR LOWER(a.turno) = 'integral') FOR UPDATE`,
            [Number(escolaId), titularId, simulacao.ano_letivo, turnoNorm]
          )
          .catch(() => [[]]);

        for (const am of agrRows || []) {
          snapshotAgrupamentoMod.push({ ...am });
          await conn
            .query(`UPDATE agrupamento_modulacao SET professor_id = ? WHERE id = ? AND escola_id = ?`, [
              substitutoId,
              am.id,
              Number(escolaId),
            ])
            .catch(() => {});
        }
      }
    }

    // 3) Inativação opcional do cadastro do titular (somente quando solicitado em troca definitiva/desligamento)
    const statusAnteriorTitular = titularRow?.status || "ativo";
    if (inativar_titular) {
      await conn.query(`UPDATE professores SET status = 'inativo' WHERE id = ? AND escola_id = ?`, [
        titularId,
        Number(escolaId),
      ]);
    }

    // 4) Grava registro auditável completo em grade_substituicoes_historico
    const statusRegistro = motivo === "TROCA_DEFINITIVA" ? "DEFINITIVA" : "ATIVA";
    const escopoResumo = {
      turmas_nomes: Array.from(
        new Set([
          ...snapshotModulacao.map((m) => m.turma_nome).filter(Boolean),
          ...simulacao.slots_detalhe.map((s) => s.turma_nome).filter(Boolean),
        ])
      ),
      disciplinas_nomes: Array.from(
        new Set([
          ...snapshotModulacao.map((m) => m.disciplina_nome).filter(Boolean),
          ...simulacao.slots_detalhe.map((s) => s.disciplina_nome).filter(Boolean),
        ])
      ),
      slots_transferidos: slotsTransferidosCount,
      slots_pulados_colisao: slotsPuladosColisaoCount,
      modulacoes_transferidas: snapshotModulacao.length,
      agrupamentos_transferidos: snapshotAgrupamentoMod.length,
      planos_diario_preservados: simulacao.resumo_impacto.planos_diario_preservados,
      registros_notas_preservados: simulacao.resumo_impacto.registros_notas_preservados,
    };

    const snapshotReversao = {
      status_anterior_titular: statusAnteriorTitular,
      slots: snapshotSlots,
      modulacao: snapshotModulacao,
      agrupamento_modulacao: snapshotAgrupamentoMod,
    };

    const [insHist] = await conn.query(
      `INSERT INTO grade_substituicoes_historico
         (escola_id, turno, ano_letivo, semestre,
          professor_titular_id, professor_titular_nome, professor_titular_cpf,
          professor_substituto_id, professor_substituto_nome, professor_substituto_cpf,
          motivo, observacao, data_inicio, data_fim_prevista, inativou_titular, status,
          escopo_json, snapshot_reversao_json, realizado_por, realizado_por_nome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(escolaId),
        turnoNorm,
        simulacao.ano_letivo,
        simulacao.semestre,
        titularId,
        titularRow.nome,
        normalizarCpfDigitos(titularRow.cpf),
        substitutoId,
        substitutoRow.nome,
        normalizarCpfDigitos(substitutoRow.cpf),
        String(motivo || "SUBSTITUICAO_TEMPORARIA").slice(0, 55),
        observacao ? String(observacao).slice(0, 490) : null,
        data_inicio || new Date().toISOString().slice(0, 10),
        data_fim_prevista || null,
        inativar_titular ? 1 : 0,
        statusRegistro,
        JSON.stringify(escopoResumo),
        JSON.stringify(snapshotReversao),
        usuario?.id || null,
        usuario?.nome || null,
      ]
    );

    await conn.commit();
    return {
      ok: true,
      substituicao_id: Number(insHist.insertId),
      escopo: escopoResumo,
      message: `Substituição concluída com sucesso! Horário atualizado e ${escopoResumo.planos_diario_preservados} plano(s)/diário(s) preservados integralmente.`,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function listarHistoricoSubstituicoes(pool, { escolaId, turno = null }) {
  await ensureEtapa4Schema(pool);
  const params = [Number(escolaId)];
  let whereTurno = "";
  if (turno && String(turno).trim().toLowerCase() !== "todos") {
    whereTurno = " AND turno = ?";
    params.push(normTurnoKey(turno));
  }

  const [rows] = await pool.query(
    `SELECT id, escola_id, turno, ano_letivo, semestre,
            professor_titular_id, professor_titular_nome, professor_titular_cpf,
            professor_substituto_id, professor_substituto_nome, professor_substituto_cpf,
            motivo, observacao,
            DATE_FORMAT(data_inicio, '%Y-%m-%d') AS data_inicio,
            DATE_FORMAT(data_fim_prevista, '%Y-%m-%d') AS data_fim_prevista,
            DATE_FORMAT(data_retorno_efetivo, '%Y-%m-%d') AS data_retorno_efetivo,
            inativou_titular, status, escopo_json,
            realizado_por_nome, revertido_por_nome, created_at, reverted_at
       FROM grade_substituicoes_historico
      WHERE escola_id = ?${whereTurno}
      ORDER BY FIELD(status, 'ATIVA', 'DEFINITIVA', 'REVERTIDA'), created_at DESC, id DESC
      LIMIT 60`,
    params
  );

  return (rows || []).map((r) => ({
    id: Number(r.id),
    turno: r.turno,
    ano_letivo: Number(r.ano_letivo),
    semestre: Number(r.semestre),
    professor_titular_id: Number(r.professor_titular_id),
    professor_titular_nome: r.professor_titular_nome,
    professor_titular_cpf: mascararCpf(r.professor_titular_cpf),
    professor_substituto_id: Number(r.professor_substituto_id),
    professor_substituto_nome: r.professor_substituto_nome,
    professor_substituto_cpf: mascararCpf(r.professor_substituto_cpf),
    motivo: r.motivo,
    observacao: r.observacao,
    data_inicio: r.data_inicio,
    data_fim_prevista: r.data_fim_prevista,
    data_retorno_efetivo: r.data_retorno_efetivo,
    inativou_titular: Boolean(r.inativou_titular),
    status: r.status,
    escopo: safeJsonParse(r.escopo_json, {}),
    realizado_por_nome: r.realizado_por_nome || null,
    revertido_por_nome: r.revertido_por_nome || null,
    created_at: r.created_at,
    reverted_at: r.reverted_at,
  }));
}

export async function reverterSubstituicaoProfessor(
  pool,
  { escolaId, substituicaoId, data_retorno_efetivo = null, observacao_retorno = null, usuario = null }
) {
  await ensureEtapa4Schema(pool);
  const conn = await pool.getConnection();
  try {
    await ensureGradeSlotMultiTurmaSupport(conn);
    await conn.beginTransaction();

    const [[hist]] = await conn.query(
      `SELECT * FROM grade_substituicoes_historico WHERE id = ? AND escola_id = ? LIMIT 1 FOR UPDATE`,
      [Number(substituicaoId), Number(escolaId)]
    );
    if (!hist) throw new Error("Registro de substituição não encontrado.");
    if (hist.status === "REVERTIDA") {
      throw new Error("Esta substituição já foi encerrada/revertida anteriormente.");
    }

    const titularId = Number(hist.professor_titular_id);
    const substitutoId = Number(hist.professor_substituto_id);
    const turnoNorm = normTurnoKey(hist.turno);
    const snap = safeJsonParse(hist.snapshot_reversao_json, {});

    // 1) Reativa cadastro do titular caso tenha sido inativado na substituição
    await conn.query(
      `UPDATE professores SET status = ? WHERE id = ? AND escola_id = ?`,
      [snap?.status_anterior_titular || "ativo", titularId, Number(escolaId)]
    );

    // 2) Restaura Modulação Regular e Agrupamentos de volta ao titular
    //    (Preservando 100% de todas as notas/diários lançados pelo substituto durante a licença!)
    let modRestauradas = 0;
    for (const m of snap?.modulacao || []) {
      await conn.query(
        `DELETE FROM modulacao
          WHERE escola_id = ? AND professor_id = ? AND turma_id = ? AND disciplina_id = ? AND COALESCE(semestre, 0) = ?`,
        [Number(escolaId), substitutoId, m.turma_id, m.disciplina_id, m.semestre || 0]
      );
      await conn.query(
        `INSERT INTO modulacao (escola_id, professor_id, turma_id, disciplina_id, aulas, semestre)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE aulas = VALUES(aulas)`,
        [Number(escolaId), titularId, m.turma_id, m.disciplina_id, m.aulas || 1, m.semestre || 0]
      );
      modRestauradas++;
    }

    for (const am of snap?.agrupamento_modulacao || []) {
      await conn
        .query(
          `UPDATE agrupamento_modulacao SET professor_id = ? WHERE id = ? AND escola_id = ? AND professor_id = ?`,
          [titularId, am.id, Number(escolaId), substitutoId]
        )
        .catch(() => {});
    }

    // 3) Restaura slots do turno (rascunho + publicado atuais) onde o substituto ocupa as turmas do escopo
    const turmasEscopoIds = Array.from(
      new Set([
        ...(snap?.modulacao || []).map((m) => Number(m.turma_id)),
        ...(snap?.slots || []).map((s) => Number(s.turma_id)),
      ].filter((n) => n > 0))
    );

    let slotsRestaurados = 0;
    const [resRows] = await conn.query(
      `SELECT id FROM grade_resultado WHERE escola_id = ? AND turno = ? AND status IN ('rascunho', 'publicado')`,
      [Number(escolaId), turnoNorm]
    );
    const resIds = (resRows || []).map((r) => Number(r.id));

    if (resIds.length > 0 && turmasEscopoIds.length > 0) {
      const phRes = resIds.map(() => "?").join(",");
      const phTur = turmasEscopoIds.map(() => "?").join(",");
      const [slotsAtuaisSub] = await conn.query(
        `SELECT id, resultado_id, turma_id, dia_semana, periodo_ordem
           FROM grade_slot
          WHERE resultado_id IN (${phRes}) AND professor_id = ? AND turma_id IN (${phTur}) FOR UPDATE`,
        [...resIds, substitutoId, ...turmasEscopoIds]
      );

      const paresUnidosSet = await carregarParesTurmasUnidasPermitidas(conn, escolaId, turnoNorm);
      for (const s of slotsAtuaisSub || []) {
        const [confTit] = await conn.query(
          `SELECT turma_id FROM grade_slot
            WHERE resultado_id = ? AND professor_id = ? AND dia_semana = ? AND periodo_ordem = ? AND turma_id <> ?`,
          [s.resultado_id, titularId, s.dia_semana, s.periodo_ordem, s.turma_id]
        );
        const temColisao = (confTit || []).some(
          (c) => !saoTurmasUnidasPermitidas(paresUnidosSet, Number(s.turma_id), Number(c.turma_id), false)
        );
        if (!temColisao) {
          await conn.query(`UPDATE grade_slot SET professor_id = ? WHERE id = ?`, [titularId, s.id]);
          slotsRestaurados++;
        }
      }
    }

    const obsFinal = observacao_retorno
      ? `${hist.observacao ? `${hist.observacao} | ` : ""}Retorno: ${String(observacao_retorno).slice(0, 200)}`
      : hist.observacao;

    await conn.query(
      `UPDATE grade_substituicoes_historico
          SET status = 'REVERTIDA',
              data_retorno_efetivo = ?,
              observacao = ?,
              revertido_por = ?,
              revertido_por_nome = ?,
              reverted_at = NOW()
        WHERE id = ? AND escola_id = ?`,
      [
        data_retorno_efetivo || new Date().toISOString().slice(0, 10),
        obsFinal,
        usuario?.id || null,
        usuario?.nome || null,
        Number(substituicaoId),
        Number(escolaId),
      ]
    );

    await conn.commit();
    return {
      ok: true,
      substituicao_id: Number(substituicaoId),
      modulacoes_restauradas: modRestauradas,
      slots_restaurados: slotsRestaurados,
      message: `Retorno do professor titular (${hist.professor_titular_nome}) concluído! Horário e modulação restaurados preservando todo o histórico do período.`,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
