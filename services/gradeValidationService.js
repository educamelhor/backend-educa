// services/gradeValidationService.js
// -----------------------------------------------------------------------------
// Validações de consistência (pré-solve e pós-solve) para o módulo de horários.
// -----------------------------------------------------------------------------
// Retornos seguem o padrão: { errors: string[], warnings: string[], stats?: any }
// -----------------------------------------------------------------------------

const ph = (arr) => (arr.length ? arr.map(() => "?").join(",") : "NULL");

/** Valida a grade_base do turno: existência e sobreposições horárias. */
export async function validateGradeBase(pool, { escolaId, turno }) {
  const errors = [];
  const warnings = [];

  // Existe grade para o turno?
  const [rows] = await pool.execute(
    `SELECT id, dia_semana, periodo_ordem, hora_inicio, hora_fim
       FROM grade_base
      WHERE escola_id = ? AND turno = ?
      ORDER BY dia_semana, periodo_ordem`,
    [escolaId, turno]
  );
  if (!rows.length) {
    errors.push("Grade temporal (grade_base) não definida para este turno.");
    return { errors, warnings };
  }

  // Sobreposição de horários no mesmo dia (ex.: 07:20–08:00 dentro de 07:00–07:50)
  const [overlaps] = await pool.execute(
    `SELECT a.dia_semana, a.periodo_ordem p1, b.periodo_ordem p2,
            a.hora_inicio a_ini, a.hora_fim a_fim, b.hora_inicio b_ini, b.hora_fim b_fim
       FROM grade_base a
       JOIN grade_base b
         ON a.escola_id = b.escola_id
        AND a.turno     = b.turno
        AND a.dia_semana= b.dia_semana
        AND a.id        < b.id
      WHERE a.escola_id = ? AND a.turno = ?
        AND NOT (a.hora_fim <= b.hora_inicio OR b.hora_fim <= a.hora_inicio)`,
    [escolaId, turno]
  );
  if (overlaps.length) {
    const exemplos = overlaps.slice(0, 3)
      .map(o => `dia ${o.dia_semana} p${o.p1}(${o.a_ini}-${o.a_fim}) × p${o.p2}(${o.b_ini}-${o.b_fim})`);
    errors.push(`Grade temporal possui sobreposições: ${exemplos.join("; ")}${overlaps.length > 3 ? " …" : ""}`);
  }

  return { errors, warnings, stats: { periodos_totais: rows.length } };
}

/** Compara demanda (vw_demanda_turma_disciplina) x atribuicoes (grade_atribuicoes). */
export async function validateAtribuicoesVsDemanda(pool, { escolaId, turmaIds }) {
  const errors = [];
  const warnings = [];

  // Demanda por turma/disciplina
  const [demanda] = await pool.query(
    `SELECT turma_id, disciplina_id, aulas_semana
       FROM vw_demanda_turma_disciplina
      WHERE escola_id = ?
        AND turma_id IN (${ph(turmaIds)})`,
    [escolaId, ...turmaIds]
  );

  // Atribuições aplicáveis ao escopo
  const [atr] = await pool.query(
    `SELECT professor_id, turma_id, disciplina_id, carga_atribuida
       FROM grade_atribuicoes
      WHERE escola_id = ?
        AND turma_id IN (${ph(turmaIds)})`,
    [escolaId, ...turmaIds]
  );

  // Índices in-memory
  const demKey = (t, d) => `${t}:${d}`;
  const demMap = new Map();
  for (const d of demanda) demMap.set(demKey(d.turma_id, d.disciplina_id), d.aulas_semana);

  // Soma por turma/disciplina
  const soma = new Map();
  const profSet = new Set();
  for (const a of atr) {
    profSet.add(a.professor_id);
    const k = demKey(a.turma_id, a.disciplina_id);
    soma.set(k, (soma.get(k) || 0) + Number(a.carga_atribuida || 0));
  }

  // Erros: atribuições sem demanda; excedente de carga
  for (const a of atr) {
    const k = demKey(a.turma_id, a.disciplina_id);
    if (!demMap.has(k)) {
      errors.push(`Atribuição sem demanda: turma ${a.turma_id}, disciplina ${a.disciplina_id}.`);
    }
  }
  for (const [k, totalAtr] of soma.entries()) {
    const [turma_id, disciplina_id] = k.split(":").map(Number);
    const aulas = demMap.get(k) || 0;
    if (totalAtr > aulas) {
      errors.push(`Excedente: turma ${turma_id}, disciplina ${disciplina_id} → atribuído ${totalAtr} > demanda ${aulas}.`);
    } else if (totalAtr === 0) {
      warnings.push(`Sem professor: turma ${turma_id}, disciplina ${disciplina_id}.`);
    } else if (totalAtr < aulas) {
      warnings.push(`Demanda parcial: turma ${turma_id}, disciplina ${disciplina_id} → ${totalAtr}/${aulas}.`);
    }
  }

  // Warnings: demanda sem nenhuma atribuição
  for (const d of demanda) {
    const k = demKey(d.turma_id, d.disciplina_id);
    if (!soma.has(k)) {
      warnings.push(`Sem atribuição: turma ${d.turma_id}, disciplina ${d.disciplina_id} (demanda ${d.aulas_semana}).`);
    }
  }

  return { errors, warnings, stats: { professores_no_escopo: profSet.size } };
}

/** Checa se disponibilidades citam apenas períodos existentes na grade. */
export async function validateDisponibilidades(pool, { escolaId, turno, profIds }) {
  const errors = [];
  const warnings = [];

  if (!profIds?.length) return { errors, warnings };

  // Mapa dia -> [periodos válidos]
  const [grows] = await pool.execute(
    `SELECT dia_semana, periodo_ordem
       FROM grade_base
      WHERE escola_id = ? AND turno = ?`,
    [escolaId, turno]
  );
  const gradeMap = new Map();
  for (const r of grows) {
    if (!gradeMap.has(r.dia_semana)) gradeMap.set(r.dia_semana, new Set());
    gradeMap.get(r.dia_semana).add(r.periodo_ordem);
  }

  const [disp] = await pool.query(
    `SELECT professor_id, dia_semana, periodos, status
       FROM grade_disponibilidades
      WHERE escola_id = ?
        AND turno = ?
        AND professor_id IN (${ph(profIds)})`,
    [escolaId, turno, ...profIds]
  );

  const vistos = new Set();
  for (const row of disp) {
    vistos.add(row.professor_id);
    let periodos = [];
    try { periodos = Array.isArray(row.periodos) ? row.periodos : JSON.parse(row.periodos || "[]"); }
    catch (_) { periodos = []; }

    const validSet = gradeMap.get(row.dia_semana) || new Set();
    for (const p of periodos) {
      if (!validSet.has(Number(p))) {
        errors.push(`Disponibilidade inválida: prof ${row.professor_id}, dia ${row.dia_semana}, período ${p} não existe na grade.`);
      }
    }
  }

  // Professores sem nenhuma disponibilidade registrada (aviso)
  for (const id of profIds) {
    if (!vistos.has(id)) warnings.push(`Professor ${id} sem disponibilidades cadastradas para este turno.`);
  }

  return { errors, warnings };
}

/** Locks válidos: slot existe; professor (se indicado) está disponível; sem duplicidade de prof no mesmo slot. */
export async function validateLocks(pool, { escolaId, turno, turmaIds }) {
  const errors = [];
  const warnings = [];

  // Locks do escopo
  const [locks] = await pool.query(
    `SELECT id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, sala_id
       FROM grade_locks
      WHERE escola_id = ?
        AND turma_id IN (${ph(turmaIds)})`,
    [escolaId, ...turmaIds]
  );
  if (!locks.length) return { errors, warnings };

  // Slots existentes (grade_base)
  const [slots] = await pool.execute(
    `SELECT dia_semana, periodo_ordem
       FROM grade_base
      WHERE escola_id = ? AND turno = ?`,
    [escolaId, turno]
  );
  const slotSet = new Set(slots.map(s => `${s.dia_semana}:${s.periodo_ordem}`));

  // 1) Slot deve existir
  for (const l of locks) {
    const key = `${l.dia_semana}:${l.periodo_ordem}`;
    if (!slotSet.has(key)) {
      errors.push(`Lock fora da grade: turma ${l.turma_id}, dia ${l.dia_semana}, período ${l.periodo_ordem}.`);
    }
  }

  // 2) Duplicidade de professor no mesmo slot (em locks)
  const dupKey = (prof, dia, per) => `${prof}:${dia}:${per}`;
  const cont = new Map();
  for (const l of locks) {
    if (!l.professor_id) continue;
    const k = dupKey(l.professor_id, l.dia_semana, l.periodo_ordem);
    cont.set(k, (cont.get(k) || 0) + 1);
  }
  for (const [k, c] of cont.entries()) {
    if (c > 1) {
      const [prof, dia, per] = k.split(":");
      errors.push(`Lock conflituoso: professor ${prof} com ${c} locks no dia ${dia}, período ${per}.`);
    }
  }

  // 3) Professor (se indicado) precisa ter disponibilidade no slot
  const profIds = [...new Set(locks.map(l => l.professor_id).filter(Boolean))];
  if (profIds.length) {
    const [disp] = await pool.query(
      `SELECT professor_id, dia_semana, periodos
         FROM grade_disponibilidades
        WHERE escola_id = ?
          AND turno = ?
          AND professor_id IN (${ph(profIds)})`,
      [escolaId, turno, ...profIds]
    );
    const dispMap = new Map(); // prof:dia -> Set(periodos)
    for (const d of disp) {
      let arr = [];
      try { arr = Array.isArray(d.periodos) ? d.periodos : JSON.parse(d.periodos || "[]"); }
      catch (_) { arr = []; }
      dispMap.set(`${d.professor_id}:${d.dia_semana}`, new Set(arr.map(Number)));
    }

    for (const l of locks) {
      if (!l.professor_id) continue;
      const s = dispMap.get(`${l.professor_id}:${l.dia_semana}`) || new Set();
      if (!s.has(Number(l.periodo_ordem))) {
        errors.push(`Lock inconsistente: prof ${l.professor_id} não está disponível (dia ${l.dia_semana}, período ${l.periodo_ordem}).`);
      }
    }
  }

  return { errors, warnings };
}

/** Validações PRÉ-SOLVE: agrega todas as anteriores. */
export async function validatePreSolve(pool, { escolaId, turno, turmaIds }) {
  const out = { errors: [], warnings: [], stats: {} };

  const g = await validateGradeBase(pool, { escolaId, turno });
  out.errors.push(...g.errors); out.warnings.push(...g.warnings); out.stats = { ...out.stats, ...g.stats };

  const a = await validateAtribuicoesVsDemanda(pool, { escolaId, turmaIds });
  out.errors.push(...a.errors); out.warnings.push(...a.warnings); out.stats = { ...out.stats, ...a.stats };

  // Para validar disponibilidades, precisamos saber os professores do escopo:
  const [profRows] = await pool.query(
    `SELECT DISTINCT professor_id
       FROM grade_atribuicoes
      WHERE escola_id = ?
        AND turma_id IN (${ph(turmaIds)})`,
    [escolaId, ...turmaIds]
  );
  const profIds = profRows.map(r => r.professor_id);

  const d = await validateDisponibilidades(pool, { escolaId, turno, profIds });
  out.errors.push(...d.errors); out.warnings.push(...d.warnings);

  const l = await validateLocks(pool, { escolaId, turno, turmaIds });
  out.errors.push(...l.errors); out.warnings.push(...l.warnings);

  return out;
}

/** (Opcional) Valida solução proposta pelo solver antes de salvar. */
export async function validateSolution(pool, { escolaId, turno, solucao }) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(solucao) || !solucao.length) {
    errors.push("Solução vazia."); return { errors, warnings };
  }

  // 1) Único lançamento por turma/dia/período
  const key = (t,d,p) => `${t}:${d}:${p}`;
  const seen = new Set();
  for (const s of solucao) {
    const k = key(s.turma_id, s.dia_semana, s.periodo_ordem);
    if (seen.has(k)) errors.push(`Duplicidade em célula: turma ${s.turma_id}, dia ${s.dia_semana}, período ${s.periodo_ordem}.`);
    seen.add(k);
  }

  // 2) Colisão de professor no mesmo slot
  const kprof = (p,d,per) => `${p}:${d}:${per}`;
  const seenProf = new Set();
  for (const s of solucao) {
    const kp = kprof(s.professor_id, s.dia_semana, s.periodo_ordem);
    if (seenProf.has(kp)) errors.push(`Conflito de professor ${s.professor_id} no dia ${s.dia_semana}, período ${s.periodo_ordem}.`);
    seenProf.add(kp);
  }

  // 3) Slots existentes?
  const [slots] = await pool.execute(
    `SELECT dia_semana, periodo_ordem
       FROM grade_base
      WHERE escola_id = ? AND turno = ?`,
    [escolaId, turno]
  );
  const slotSet = new Set(slots.map(s => `${s.dia_semana}:${s.periodo_ordem}`));
  for (const s of solucao) {
    if (!slotSet.has(`${s.dia_semana}:${s.periodo_ordem}`)) {
      errors.push(`Alocação em slot inexistente: dia ${s.dia_semana}, período ${s.periodo_ordem}.`);
    }
  }

  return { errors, warnings };
}
