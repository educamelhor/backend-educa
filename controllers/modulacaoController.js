// api/controllers/modulacaoController.js
// =============================================================================
// Controlador de Horários (Multi-Escola)
// - Salvar (UPSERT não excludente): mantém alocações anteriores e atualiza/insere
// - Listar por turno: retorna turmas do turno + alocações (com e sem turma)
// - Upsert em lote (bulk) para alta performance com ON DUPLICATE KEY UPDATE
// Requisitos de BD recomendados para o bulk:
//   1) Coluna gerada: turma_id_norm = IFNULL(turma_id, 0) (STORED)
//   2) UNIQUE INDEX (escola_id, professor_id, disciplina_id, turma_id_norm)
//    → evita duplicidade mesmo quando turma_id é NULL
// =============================================================================

import pool from "../db.js";

// ============================================================================
// Auto-migration idempotente:
// 1) Garante coluna `semestre` em `modulacao`
// 2) Substitui índices únicos legados (sem `semestre`) por índice único que
//    inclui `semestre`, permitindo alocar o mesmo (prof, turma, disc) no 1º e 2º sem.
// 3) Recupera de `modulacao_historico` alocações de 1º/2º semestre que haviam
//    sido bloqueadas silenciosamente pelo ON DUPLICATE KEY do índice legado.
// ============================================================================
(async () => {
  try {
    try {
      await pool.query(
        "ALTER TABLE modulacao ADD COLUMN IF NOT EXISTS semestre TINYINT NOT NULL DEFAULT 0 COMMENT '0=anual, 1=1º sem, 2=2º sem'"
      );
    } catch {
      try { await pool.query("ALTER TABLE modulacao ADD COLUMN semestre TINYINT NOT NULL DEFAULT 0"); } catch {}
    }

    // Cria novo índice único incluindo `semestre` ANTES de remover os legados (preserva FK de escola_id)
    let novoIndiceCriado = false;
    try {
      await pool.query(
        "ALTER TABLE modulacao ADD UNIQUE KEY uq_modulacao_semestre (escola_id, professor_id, disciplina_id, turma_id_norm, semestre)"
      );
      novoIndiceCriado = true;
    } catch (e) {
      if (e?.code === "ER_DUP_KEYNAME" || String(e?.message || "").includes("Duplicate key name")) {
        novoIndiceCriado = true;
      } else {
        try {
          await pool.query(
            "ALTER TABLE modulacao ADD UNIQUE KEY uq_modulacao_semestre (escola_id, professor_id, turma_id, disciplina_id, semestre)"
          );
          novoIndiceCriado = true;
        } catch (e2) {
          if (e2?.code === "ER_DUP_KEYNAME" || String(e2?.message || "").includes("Duplicate key name")) {
            novoIndiceCriado = true;
          }
        }
      }
    }

    if (novoIndiceCriado) {
      try { await pool.query("ALTER TABLE modulacao DROP INDEX uq_horario"); } catch {}
      try { await pool.query("ALTER TABLE modulacao DROP INDEX uq_horarios_escola_prof_disc_turma"); } catch {}
    }

    // Backfill seguro a partir de modulacao_historico para alocações bloqueadas pelo índice antigo
    try {
      await pool.query(`
        INSERT IGNORE INTO modulacao (escola_id, professor_id, turma_id, disciplina_id, aulas, semestre)
        SELECT h.escola_id, h.professor_id, h.turma_id, h.disciplina_id, h.aulas, h.semestre
        FROM modulacao_historico h
        INNER JOIN (
          SELECT MAX(id) AS max_id
          FROM modulacao_historico
          WHERE turma_id IS NOT NULL
            AND semestre IN (1, 2)
          GROUP BY escola_id, professor_id, turma_id, disciplina_id, semestre
        ) latest ON latest.max_id = h.id
        WHERE h.operacao IN ('INSERT', 'UPDATE')
          AND EXISTS (
            SELECT 1 FROM modulacao m_ex
            WHERE m_ex.escola_id = h.escola_id
              AND m_ex.professor_id = h.professor_id
              AND m_ex.turma_id = h.turma_id
              AND m_ex.disciplina_id = h.disciplina_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM modulacao m_sem
            WHERE m_sem.escola_id = h.escola_id
              AND m_sem.professor_id = h.professor_id
              AND m_sem.turma_id = h.turma_id
              AND m_sem.disciplina_id = h.disciplina_id
              AND m_sem.semestre = h.semestre
          )
      `);
    } catch {}
  } catch (err) {
    console.warn("[modulacaoController] Aviso na auto-migration de modulacao:", err?.message);
  }
})();

// ============================================================================
// POST /api/modulacao  → Salvar horários (UPSERT não excludente, item a item)
// Body: Array de objetos { professor_id, turma_id (null|int), disciplina_id, aulas, semestre }
// Obs: req.user.escola_id é obrigatório (middleware já define no request).
// ============================================================================
export const salvarModulacao = async (req, res) => {
  const modulacao = Array.isArray(req.body) ? req.body : [];
  const escola_id = req.user?.escola_id;

  if (!escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  if (!modulacao.length) {
    return res.status(400).json({ message: "Nenhum horário enviado." });
  }

  try {
    // UPSERT (não excludente): insere ou atualiza 'aulas'
    for (const h of modulacao) {
      const professor_id = Number(h.professor_id) || null;
      const disciplina_id = Number(h.disciplina_id) || null;
      const turma_id = h.turma_id == null ? null : Number(h.turma_id);
      const aulas = Number(h.aulas) || 0;
      const semestre = Number(h.semestre) || 1;

      if (!professor_id || !disciplina_id) continue;

      const [resIns] = await pool.query(
        `INSERT INTO modulacao (escola_id, professor_id, turma_id, disciplina_id, aulas, semestre)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE aulas = VALUES(aulas), semestre = VALUES(semestre)`,
        [escola_id, professor_id, turma_id, disciplina_id, aulas, semestre]
      );

      // Auditoria
      await pool.query(
        `INSERT INTO modulacao_historico (escola_id, modulacao_id, professor_id, turma_id, disciplina_id, semestre, aulas, operacao, usuario_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'INSERT', ?)`,
        [escola_id, resIns?.insertId || null, professor_id, turma_id, disciplina_id, semestre, aulas, req.user?.id || null]
      ).catch(() => {});
    }

    return res.json({ message: "Horários salvos com sucesso!" });
  } catch (err) {
    console.error("Erro ao salvar horários:", err);
    return res.status(500).json({ message: "Erro ao salvar horários." });
  }
};

// ============================================================================
// GET /api/modulacao?turno=Vespertino&semestre=1  → Listar horários por turno e semestre
// Retorna: { turmas: [...], alocacoes: [...] }
// - turmas: id, nome, turno, ano, regime
// - alocacoes: modulacao_id, professor_id, disciplina_id, turma_id, aulas, semestre,
//              professor_nome, disciplina_nome, turno, regime
// ============================================================================
export const listarModulacaoPorTurno = async (req, res, escolaIdFromRoute) => {
  const { turno, semestre } = req.query || {};
  const escola_id = req.user?.escola_id ?? escolaIdFromRoute;

  if (!escola_id) {
    return res.status(403).json({ erro: "Acesso negado: escola não definida." });
  }
  if (!turno) {
    return res.status(400).json({ erro: "Turno é obrigatório" });
  }

  const semFiltro = semestre ? Number(semestre) : 1;

  try {
    // 1) Turmas do turno do ano letivo vigente (apenas da escola do usuário)
    const [turmas] = await pool.query(
      `SELECT id, nome, turno, ano, regime
        FROM turmas
       WHERE turno = ? AND escola_id = ? AND ano = YEAR(CURDATE())
       ORDER BY nome`,
      [turno, escola_id]
    );

    if (!turmas.length) {
      return res.json({ turmas: [], alocacoes: [] });
    }

    // 2) Alocações com turma_id (somente turmas do turno)
    const turmaIds = turmas.map((t) => t.id);
    let alocacoes = [];

    if (turmaIds.length) {
      const placeholders = turmaIds.map(() => "?").join(",");
      const paramsComTurma = [
        escola_id,
        ...turmaIds,
        semFiltro,
        semFiltro,
        semFiltro,
        semFiltro,
      ];

      const [resultComTurma] = await pool.query(
        `SELECT
          h.id AS modulacao_id,
          h.professor_id,
          h.disciplina_id,
          h.turma_id,
          h.aulas,
          h.semestre,
          p.nome AS professor_nome,
          d.nome AS disciplina_nome,
          t.nome  AS turma_nome,
          t.turno AS turno,
          t.regime AS regime
         FROM modulacao h
         JOIN professores p ON p.id = h.professor_id
         JOIN disciplinas d ON d.id = h.disciplina_id
         JOIN turmas t      ON t.id = h.turma_id
         WHERE h.escola_id = ?
           AND h.turma_id IN (${placeholders})
           AND t.ano = YEAR(CURDATE())
           AND (
             LOWER(COALESCE(t.regime, 'anual')) <> 'semestral'
             OR h.semestre IS NULL
             OR h.semestre = 0
             OR h.semestre = ?
             OR (
               NOT EXISTS (
                 SELECT 1 FROM modulacao m2
                 WHERE m2.escola_id = h.escola_id
                   AND m2.turma_id = h.turma_id
                   AND m2.disciplina_id = h.disciplina_id
                   AND m2.semestre = ?
               )
               AND EXISTS (
                 SELECT 1 FROM professor_vinculos pv0
                 WHERE pv0.professor_id = p.id
                   AND pv0.disciplina_id = h.disciplina_id
                   AND LOWER(pv0.turno) COLLATE utf8mb4_unicode_ci = LOWER(t.turno) COLLATE utf8mb4_unicode_ci
                   AND pv0.escola_id = p.escola_id
                   AND (pv0.semestre = 0 OR pv0.semestre IS NULL)
               )
               AND NOT EXISTS (
                 SELECT 1 FROM professor_vinculos pvs
                 WHERE pvs.professor_id = p.id
                   AND pvs.disciplina_id = h.disciplina_id
                   AND LOWER(pvs.turno) COLLATE utf8mb4_unicode_ci = LOWER(t.turno) COLLATE utf8mb4_unicode_ci
                   AND pvs.escola_id = p.escola_id
                   AND pvs.semestre IN (1, 2)
               )
               AND (
                 EXISTS (
                   SELECT 1 FROM turma_cargas tc
                   WHERE tc.escola_id = h.escola_id
                     AND tc.turma_id = h.turma_id
                     AND tc.disciplina_id = h.disciplina_id
                     AND tc.semestre = ?
                 )
                 OR NOT EXISTS (
                   SELECT 1 FROM turma_cargas tc_any
                   WHERE tc_any.escola_id = h.escola_id
                     AND tc_any.turma_id = h.turma_id
                     AND tc_any.semestre = ?
                 )
               )
             )
           )`,
        paramsComTurma
      );

      // 3) Alocações SEM turma_id (válidas para a escola inteira)
      const [resultSemTurma] = await pool.query(
        `SELECT
          h.id AS modulacao_id,
          h.professor_id,
          h.disciplina_id,
          h.turma_id,
          h.aulas,
          h.semestre,
          p.nome AS professor_nome,
          d.nome AS disciplina_nome,
          NULL AS turno,
          NULL AS regime
         FROM modulacao h
         JOIN professores p ON p.id = h.professor_id
         JOIN disciplinas d ON d.id = h.disciplina_id
         WHERE h.escola_id = ?
           AND h.turma_id IS NULL
           AND (h.semestre = ? OR h.semestre = 1)`,
        [escola_id, semFiltro]
      );

      alocacoes = [...resultComTurma, ...resultSemTurma];
    }

    return res.json({ turmas, alocacoes });
  } catch (err) {
    console.error("Erro ao buscar horários:", err);
    return res.status(500).json({ erro: "Erro ao buscar horários" });
  }
};

// ============================================================================
// POST /api/modulacao/upsert  → UPSERT em lote (bulk, performático)
// Body: Array<{ professor_id, turma_id|null, disciplina_id, aulas, semestre }>
// ============================================================================
export const upsertModulacao = async (req, res, escolaIdFromRoute) => {
  try {
    const body = Array.isArray(req.body) ? req.body : [];
    const escola_id = req.user?.escola_id ?? escolaIdFromRoute;

    if (!escola_id) {
      return res.status(403).json({ message: "Acesso negado: escola não definida." });
    }
    if (body.length === 0) {
      return res.status(400).json({ message: "Payload deve ser um array com pelo menos 1 item." });
    }

    // Saneamento + deduplicação (prof + disc + turma/null + semestre)
    const mk = (r) =>
      `${escola_id}|${Number(r.professor_id)}|${Number(r.disciplina_id)}|${r.turma_id ?? "null"}|${Number(r.semestre) || 1}`;
    const vistos = new Set();
    const registros = [];
    for (const r of body) {
      const professor_id = Number(r.professor_id);
      const disciplina_id = Number(r.disciplina_id);
      const aulas = Number(r.aulas);
      const turma_id = r.turma_id == null ? null : Number(r.turma_id);
      const semestre = Number(r.semestre) || 1;
      if (!professor_id || !disciplina_id || Number.isNaN(aulas)) continue;

      const k = mk({ professor_id, disciplina_id, turma_id, semestre });
      if (vistos.has(k)) continue;
      vistos.add(k);
      registros.push({ escola_id, professor_id, disciplina_id, turma_id, aulas, semestre });
    }

    if (!registros.length) {
      return res.status(400).json({ message: "Nenhum registro válido para processar." });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const CHUNK_SIZE = 500;
      const baseSql = `
        INSERT INTO modulacao (escola_id, professor_id, disciplina_id, turma_id, aulas, semestre)
        VALUES ?
        ON DUPLICATE KEY UPDATE aulas = VALUES(aulas), semestre = VALUES(semestre)
      `;

      let processed = 0;
      for (let i = 0; i < registros.length; i += CHUNK_SIZE) {
        const slice = registros.slice(i, i + CHUNK_SIZE);
        const values = slice.map((r) => [
          r.escola_id,
          r.professor_id,
          r.disciplina_id,
          r.turma_id,
          r.aulas,
          r.semestre,
        ]);
        await conn.query(baseSql, [values]);
        processed += slice.length;

        // Auditoria
        const histValues = slice.map((r) => [
          r.escola_id,
          r.professor_id,
          r.turma_id,
          r.disciplina_id,
          r.semestre,
          r.aulas,
          'UPDATE',
          req.user?.id || null,
        ]);
        await conn.query(
          `INSERT INTO modulacao_historico (escola_id, professor_id, turma_id, disciplina_id, semestre, aulas, operacao, usuario_id)
           VALUES ?`,
          [histValues]
        ).catch(() => {});
      }

      await conn.commit();
      return res.status(200).json({ message: "UPSERT (bulk) concluído", processed });
    } catch (err) {
      await conn.rollback();
      console.error("Erro no UPSERT BULK de modulacao:", err);
      return res.status(500).json({ message: "Erro ao processar UPSERT de horários." });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error("Falha geral no UPSERT BULK de modulacao:", err);
    return res.status(500).json({ message: "Falha inesperada." });
  }
};

// ============================================================================
// GET /api/modulacao/carga-turma?turno=X&semestre=Y  → Mapa de carga real por turma
// ============================================================================
// Retorna: { [turma_id]: { [disciplina_id]: N_aulas } }
// - Para turmas anuais: sempre retorna a carga da turma (semestre 1).
// - Para turmas semestrais: filtra exatamente as disciplinas do semestre Y (1 ou 2).
// ============================================================================
export const getCargaPorTurma = async (req, res, escolaIdFromRoute) => {
  const { turno, semestre } = req.query || {};
  const escola_id = req.user?.escola_id ?? escolaIdFromRoute;

  if (!escola_id) return res.status(403).json({ erro: "Acesso negado: escola não definida." });
  if (!turno)     return res.status(400).json({ erro: "turno é obrigatório." });

  const semFiltro = semestre ? Number(semestre) : 1;

  try {
    const [rows] = await pool.query(
      `SELECT
         tc.turma_id,
         tc.disciplina_id,
         tc.semestre,
         IFNULL(tc.carga, IFNULL(d.carga, 1)) AS carga,
         t.regime
       FROM turma_cargas tc
       JOIN disciplinas d ON d.id = tc.disciplina_id
       JOIN turmas      t ON t.id  = tc.turma_id
       WHERE tc.escola_id = ?
         AND t.turno      = ?
         AND t.ano        = YEAR(CURDATE())
         AND (
           t.regime = 'anual'
           OR tc.semestre = ?
         )`,
      [escola_id, turno, semFiltro]
    );

    // Monta mapa { turma_id: { disciplina_id: carga } }
    const resultado = {};
    for (const row of rows) {
      if (!resultado[row.turma_id]) resultado[row.turma_id] = {};
      resultado[row.turma_id][row.disciplina_id] = Number(row.carga) || 1;
    }

    return res.json(resultado);
  } catch (err) {
    console.error("[modulacao/carga-turma] Erro:", err);
    return res.status(500).json({ erro: "Erro ao calcular carga por turma." });
  }
};
