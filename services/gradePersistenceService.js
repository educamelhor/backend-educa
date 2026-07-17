// services/gradePersistenceService.js
// -----------------------------------------------------------------------------
// Regras de persistência da grade (rascunho/publicado).
//  - upsertRascunhoCompleto(pool, { escolaId, turno, turmas, slots })
//  - getRascunhoByTurno(pool, { escolaId, turno })
//  - publicarRascunho(pool, { escolaId, turno, descricao })
//  - getPublicadoByTurno(pool, { escolaId, turno })
//  - ensureRascunho(pool, { escolaId, turno })
//  - ensureTurmaNoEscopo(pool, { resultadoId, turmaId })
//  - upsertDraftSlot(pool, { escolaId, turno, turma_id, dia, ordem, disciplina_id, professor_id, origem, locked })
//  - removeDraftSlot(pool, { escolaId, turno, turma_id, dia, ordem })
// -----------------------------------------------------------------------------

function normTurno(t) {
  return String(t || "").trim().toLowerCase();
}

// -----------------------------------------------------------------------------
// PASSO 3.2.6 — Garantia de H2 (conflito de professor) no UP SERT de slot
// -----------------------------------------------------------------------------
// Por que aqui?
// - O frontend (LayoutGrade) pode chamar /slot/upsert diretamente (sem /validate-slot).
// - Dependíamos de UNIQUE no banco para "choque de professor" (comentário antigo),
//   mas o TESTE B mostrou que a escrita está passando.
// - Portanto, esta camada precisa bloquear o conflito de professor de forma explícita.
//
// Regra H2 (FASE_1):
// - No mesmo rascunho (resultado_id do turno), um professor NÃO pode estar em
//   duas turmas diferentes no mesmo (dia_semana, periodo_ordem).
//
// Implementação (reforçada):
// - Executa dentro de transação (conn).
// - Faz o SELECT de conflito com FOR UPDATE (quando aplicável) para reduzir race.
// - Exclui o próprio slot de destino (turma_id+dia+ordem), pois pode ser "re-salvar".
// - Se houver registro, lança erro com code/errno de DUP_ENTRY,
//   para o router manter o comportamento atual (409 com mensagem de conflito).
// -----------------------------------------------------------------------------

function makeDupEntryError(message) {
  const err = new Error(message || "Conflito: choque de turma/professor no mesmo dia/período.");
  // Compatibilidade com o tratamento atual no router (gradePublish.js):
  // if (e?.code === "ER_DUP_ENTRY" || e?.errno === 1062) => 409
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

// -----------------------------------------------------------------------------
// Helpers internos para permitir transação compartilhada (conn)
// -----------------------------------------------------------------------------

async function ensureRascunhoConn(conn, { escolaId, turno }) {
  const turnoNorm = normTurno(turno);

  const [[draft]] = await conn.query(
    `SELECT id FROM grade_resultado
      WHERE escola_id=? AND turno=? AND status='rascunho'
      LIMIT 1`,
    [escolaId, turnoNorm]
  );

  if (draft?.id) return draft.id;

  const [ins] = await conn.query(
    `INSERT INTO grade_resultado (escola_id, turno, status, version)
     VALUES (?, ?, 'rascunho', 1)`,
    [escolaId, turnoNorm]
  );

  return ins.insertId;
}

async function ensureTurmaNoEscopoConn(conn, { resultadoId, turmaId }) {
  await conn.query(
    `INSERT IGNORE INTO grade_resultado_turma (resultado_id, turma_id) VALUES (?, ?)`,
    [resultadoId, Number(turmaId)]
  );
}

// -----------------------------------------------------------------------------
// PASSO 1 — Persistência completa (rascunho → publicação)
// -----------------------------------------------------------------------------

export async function upsertRascunhoCompleto(pool, { escolaId, turno, turmas, slots }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const turnoNorm = normTurno(turno);

    // Remove rascunho anterior (se existir) para este turno
    const [olds] = await conn.query(
      `SELECT id FROM grade_resultado WHERE escola_id=? AND turno=? AND status='rascunho' LIMIT 1`,
      [escolaId, turnoNorm]
    );
    if (olds?.[0]?.id) {
      await conn.query(`DELETE FROM grade_resultado WHERE id=?`, [olds[0].id]);
    }

    // Cria cabeçalho rascunho
    const [ins] = await conn.query(
      `INSERT INTO grade_resultado (escola_id, turno, status, version) VALUES (?, ?, 'rascunho', 1)`,
      [escolaId, turnoNorm]
    );
    const resultadoId = ins.insertId;

    // Escopo de turmas
    if (Array.isArray(turmas) && turmas.length) {
      const values = turmas.map((tid) => [resultadoId, Number(tid)]);
      await conn.query(
        `INSERT INTO grade_resultado_turma (resultado_id, turma_id) VALUES ?`,
        [values]
      );
    }

    // Slots (espera: { turma_id, dia, ordem, disciplina_id, professor_id, origem?, locked? })
    for (const s of slots || []) {
      const turma_id = Number(s.turma_id);
      const dia = Number(s.dia);
      const ordem = Number(s.ordem);
      const disciplina_id = Number(s.disciplina_id);
      const professor_id = Number(s.professor_id);
      const origem = String(s.origem || "manual").toLowerCase();
      const locked = s.locked ? 1 : 0;

      if (!turma_id || !dia || !ordem || !disciplina_id || !professor_id) {
        throw new Error("Slot inválido: campos obrigatórios ausentes.");
      }

      // PASSO 3.2.6 — H2 no rascunho completo também (mesma regra)
      // (mantido; aqui já estamos na transação do rascunho completo)
      const [conf] = await conn.query(
        `
        SELECT turma_id
          FROM grade_slot
         WHERE resultado_id = ?
           AND professor_id = ?
           AND dia_semana = ?
           AND periodo_ordem = ?
           AND NOT (turma_id = ? AND dia_semana = ? AND periodo_ordem = ?)
         LIMIT 1
        `,
        [resultadoId, professor_id, dia, ordem, turma_id, dia, ordem]
      );
      if (conf?.[0]?.turma_id) {
        throw makeDupEntryError("Conflito: choque de turma/professor no mesmo dia/período.");
      }

      await conn.query(
        `INSERT INTO grade_slot
           (resultado_id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [resultadoId, turma_id, dia, ordem, disciplina_id, professor_id, origem, locked]
      );
    }

    await conn.commit();
    return { resultado_id: resultadoId, status: "rascunho" };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export async function getRascunhoByTurno(pool, { escolaId, turno }) {
  const turnoNorm = normTurno(turno);

  const [[res]] = await pool.query(
    `SELECT id, escola_id, turno, status, version, descricao, published_at, created_at
       FROM grade_resultado
      WHERE escola_id=? AND turno=? AND status='rascunho'
      LIMIT 1`,
    [escolaId, turnoNorm]
  );
  if (!res) return null;

  const [turmas] = await pool.query(
    `SELECT turma_id FROM grade_resultado_turma WHERE resultado_id=?`,
    [res.id]
  );

  const [slots] = await pool.query(
    `SELECT turma_id, dia_semana AS dia, periodo_ordem AS ordem, disciplina_id, professor_id, origem, locked
       FROM grade_slot
      WHERE resultado_id=?`,
    [res.id]
  );

  return {
    resultado: {
      id: res.id,
      turno: res.turno,
      status: res.status,
      turmas: turmas.map((t) => t.turma_id),
      version: res.version,
      descricao: res.descricao,
      published_at: res.published_at,
      created_at: res.created_at,
    },
    slots,
  };
}

export async function publicarRascunho(pool, { escolaId, turno, descricao }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const turnoNorm = normTurno(turno);

    // Existe rascunho?
    const [[ras]] = await conn.query(
      `SELECT id FROM grade_resultado WHERE escola_id=? AND turno=? AND status='rascunho' LIMIT 1`,
      [escolaId, turnoNorm]
    );
    if (!ras?.id) throw new Error("Não há rascunho para publicar.");

    // Arquivar publicado atual (se houver)
    const [[pub]] = await conn.query(
      `SELECT id FROM grade_resultado WHERE escola_id=? AND turno=? AND status='publicado' LIMIT 1`,
      [escolaId, turnoNorm]
    );
    if (pub?.id) {
      await conn.query(`UPDATE grade_resultado SET status='arquivado' WHERE id=?`, [pub.id]);
    }

    // Promover rascunho → publicado
    await conn.query(
      `UPDATE grade_resultado
          SET status='publicado',
              descricao=?,
              published_at=NOW(),
              version=IFNULL(version, 0) + 1
        WHERE id=?`,
      [descricao || null, ras.id]
    );

    await conn.commit();
    return { resultado_id: ras.id, status: "publicado" };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export async function getPublicadoByTurno(pool, { escolaId, turno }) {
  const turnoNorm = normTurno(turno);

  const [[res]] = await pool.query(
    `SELECT id, escola_id, turno, status, version, descricao, published_at, created_at
       FROM grade_resultado
      WHERE escola_id=? AND turno=? AND status='publicado'
      LIMIT 1`,
    [escolaId, turnoNorm]
  );
  if (!res) return null;

  const [turmas] = await pool.query(
    `SELECT turma_id FROM grade_resultado_turma WHERE resultado_id=?`,
    [res.id]
  );

  const [slots] = await pool.query(
    `SELECT turma_id, dia_semana AS dia, periodo_ordem AS ordem, disciplina_id, professor_id, origem, locked
       FROM grade_slot
      WHERE resultado_id=?`,
    [res.id]
  );

  return {
    resultado: {
      id: res.id,
      turno: res.turno,
      status: res.status,
      turmas: turmas.map((t) => t.turma_id),
      version: res.version,
      descricao: res.descricao,
      published_at: res.published_at,
      created_at: res.created_at,
    },
    slots,
  };
}

// -----------------------------------------------------------------------------
// PASSO 2.1 — Operações incrementais de rascunho (slot)
// -----------------------------------------------------------------------------

/** Garante que existe um rascunho para (escola, turno). Retorna resultado_id. */
export async function ensureRascunho(pool, { escolaId, turno }) {
  const turnoNorm = normTurno(turno);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[draft]] = await conn.query(
      `SELECT id FROM grade_resultado
        WHERE escola_id=? AND turno=? AND status='rascunho'
        LIMIT 1`,
      [escolaId, turnoNorm]
    );

    if (draft?.id) {
      await conn.commit();
      return draft.id;
    }

    const [ins] = await conn.query(
      `INSERT INTO grade_resultado (escola_id, turno, status, version)
       VALUES (?, ?, 'rascunho', 1)`,
      [escolaId, turnoNorm]
    );

    await conn.commit();
    return ins.insertId;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Garante que a turma está no escopo do rascunho. */
export async function ensureTurmaNoEscopo(pool, { resultadoId, turmaId }) {
  await pool.query(
    `INSERT IGNORE INTO grade_resultado_turma (resultado_id, turma_id) VALUES (?, ?)`,
    [resultadoId, Number(turmaId)]
  );
}

/** Upsert de 1 slot no rascunho (cria ou atualiza). */
export async function upsertDraftSlot(
  pool,
  {
    escolaId,
    turno,
    turma_id,
    dia,
    ordem,
    disciplina_id,
    professor_id,
    origem = "manual",
    locked = false,
  }
) {
  // ---------------------------------------------------------------------------
  // PASSO 3.2.6 (reforçado) — Executa a regra H2 em transação, reduzindo race.
  // ---------------------------------------------------------------------------
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const resultadoId = await ensureRascunhoConn(conn, { escolaId, turno });
    await ensureTurmaNoEscopoConn(conn, { resultadoId, turmaId: turma_id });

    const profId = Number(professor_id);
    const diaNum = Number(dia);
    const ordemNum = Number(ordem);
    const turmaId = Number(turma_id);

    // -------------------------------------------------------------------------
    // H2: Conflito de professor no mesmo (dia, ordem) em outra turma
    // - Usamos FOR UPDATE para evitar que dois inserts simultâneos passem juntos.
    // - Se seu MySQL estiver em MyISAM/sem suporte, ele ignora; ainda assim a checagem funciona.
    // -------------------------------------------------------------------------
    const [profConflict] = await conn.query(
      `
      SELECT turma_id
        FROM grade_slot
       WHERE resultado_id = ?
         AND professor_id = ?
         AND dia_semana = ?
         AND periodo_ordem = ?
         AND NOT (turma_id = ? AND dia_semana = ? AND periodo_ordem = ?)
       LIMIT 1
       FOR UPDATE
      `,
      [resultadoId, profId, diaNum, ordemNum, turmaId, diaNum, ordemNum]
    );

    if (profConflict?.[0]?.turma_id) {
      throw makeDupEntryError("Conflito: choque de turma/professor no mesmo dia/período.");
    }

    // INSERT ... ON DUPLICATE KEY UPDATE para a UNIQUE de turma (resultado, turma, dia, ordem).
    // Choque de professor (resultado, professor, dia, ordem) se houver UNIQUE no banco gera ER_DUP_ENTRY (1062).
    const sql = `
      INSERT INTO grade_slot
        (resultado_id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        disciplina_id = VALUES(disciplina_id),
        professor_id  = VALUES(professor_id),
        origem        = VALUES(origem),
        locked        = VALUES(locked)
    `;

    const params = [
      resultadoId,
      turmaId,
      diaNum,
      ordemNum,
      Number(disciplina_id),
      profId,
      String(origem).toLowerCase(),
      locked ? 1 : 0,
    ];

    await conn.query(sql, params);

    await conn.commit();

    return {
      resultado_id: resultadoId,
      slot: {
        turma_id: turmaId,
        dia: diaNum,
        ordem: ordemNum,
        disciplina_id: Number(disciplina_id),
        professor_id: profId,
        origem: String(origem).toLowerCase(),
        locked: !!locked,
      },
    };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Remove 1 slot do rascunho. */
export async function removeDraftSlot(pool, { escolaId, turno, turma_id, dia, ordem }) {
  const resultadoId = await ensureRascunho(pool, { escolaId, turno });
  const [res] = await pool.query(
    `DELETE FROM grade_slot
      WHERE resultado_id=? AND turma_id=? AND dia_semana=? AND periodo_ordem=?`,
    [resultadoId, Number(turma_id), Number(dia), Number(ordem)]
  );
  return { resultado_id: resultadoId, removed: res.affectedRows || 0 };
}
