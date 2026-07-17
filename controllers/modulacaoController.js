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
// POST /api/modulacao  → Salvar horários (UPSERT não excludente, item a item)
// Body: Array de objetos { professor_id, turma_id (null|int), disciplina_id, aulas }
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

      if (!professor_id || !disciplina_id) continue;

      await pool.query(
        `INSERT INTO modulacao (escola_id, professor_id, turma_id, disciplina_id, aulas)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE aulas = VALUES(aulas)`,
        [escola_id, professor_id, turma_id, disciplina_id, aulas]
      );
    }

    return res.json({ message: "Horários salvos com sucesso!" });
  } catch (err) {
    console.error("Erro ao salvar horários:", err);
    return res.status(500).json({ message: "Erro ao salvar horários." });
  }
};

// ============================================================================
// GET /api/modulacao?turno=Vespertino  → Listar horários por turno
// Retorna: { turmas: [...], alocacoes: [...] }
// - turmas: id, nome (do turno + escola do usuário)
// - alocacoes: professor_id, disciplina_id, turma_id (pode ser null), aulas,
//              professor_nome, disciplina_nome, turno (NULL quando turma_id IS NULL)
// Obs: Também funciona se a rota passar escola_id como 3º argumento (compat).
// ============================================================================
export const listarModulacaoPorTurno = async (req, res, escolaIdFromRoute) => {
  const { turno } = req.query || {};
  const escola_id = req.user?.escola_id ?? escolaIdFromRoute;

  if (!escola_id) {
    return res.status(403).json({ erro: "Acesso negado: escola não definida." });
  }
  if (!turno) {
    return res.status(400).json({ erro: "Turno é obrigatório" });
  }

  try {
    // 1) Turmas do turno do ano letivo vigente (apenas da escola do usuário)
    const [turmas] = await pool.query(
      `SELECT id, nome, turno, ano
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
      const paramsComTurma = [escola_id, ...turmaIds];

      const [resultComTurma] = await pool.query(
        `SELECT
          h.professor_id,
          h.disciplina_id,
          h.turma_id,
          h.aulas,
          p.nome AS professor_nome,
          d.nome AS disciplina_nome,
          t.nome  AS turma_nome,
          t.turno AS turno
         FROM modulacao h
         JOIN professores p ON p.id = h.professor_id
         JOIN disciplinas d ON d.id = h.disciplina_id
         JOIN turmas t      ON t.id = h.turma_id
         WHERE h.escola_id = ?
           AND h.turma_id IN (${placeholders})
           AND t.ano = YEAR(CURDATE())`,
        paramsComTurma
      );

      // 3) Alocações SEM turma_id (válidas para a escola inteira)
      const [resultSemTurma] = await pool.query(
        `SELECT
          h.professor_id,
          h.disciplina_id,
          h.turma_id,
          h.aulas,
          p.nome AS professor_nome,
          d.nome AS disciplina_nome,
          NULL AS turno
         FROM modulacao h
         JOIN professores p ON p.id = h.professor_id
         JOIN disciplinas d ON d.id = h.disciplina_id
         WHERE h.escola_id = ?
           AND h.turma_id IS NULL`,
        [escola_id]
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
// Body: Array<{ professor_id, turma_id|null, disciplina_id, aulas }>
// - Usa escola_id do usuário logado (ou do 3º argumento quando a rota repassa).
// - Recomendado ter UNIQUE INDEX (escola_id, professor_id, disciplina_id, turma_id_norm)
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

    // Saneamento + deduplicação (prof + disc + turma/null)
    const mk = (r) =>
      `${escola_id}|${Number(r.professor_id)}|${Number(r.disciplina_id)}|${r.turma_id ?? "null"}`;
    const vistos = new Set();
    const registros = [];
    for (const r of body) {
      const professor_id = Number(r.professor_id);
      const disciplina_id = Number(r.disciplina_id);
      const aulas = Number(r.aulas);
      const turma_id = r.turma_id == null ? null : Number(r.turma_id);
      if (!professor_id || !disciplina_id || Number.isNaN(aulas)) continue;

      const k = mk({ professor_id, disciplina_id, turma_id });
      if (vistos.has(k)) continue;
      vistos.add(k);
      registros.push({ escola_id, professor_id, disciplina_id, turma_id, aulas });
    }

    if (!registros.length) {
      return res.status(400).json({ message: "Nenhum registro válido para processar." });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const CHUNK_SIZE = 500;
      const baseSql = `
        INSERT INTO modulacao (escola_id, professor_id, disciplina_id, turma_id, aulas)
        VALUES ?
        ON DUPLICATE KEY UPDATE aulas = VALUES(aulas)
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
        ]);
        await conn.query(baseSql, [values]);
        processed += slice.length;
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
// GET /api/modulacao/carga-turma?turno=X  → Mapa de carga real por turma
// ============================================================================
// Retorna: { [turma_id]: { [disciplina_id]: N_aulas } }
//
// Lógica correta e simplificada:
//   A tabela DISCIPLINAS já é cadastrada por Etapa + Turno + Carga.
//   Exemplo: ARTES|Fundamental|Noturno = carga 1; ARTES|Médio|Noturno = carga 3.
//   A tabela TURMA_CARGAS vincula cada turma à disciplina específica de sua etapa/turno.
//   Basta fazer JOIN turma_cargas → disciplinas para obter a carga real diretamente.
//   Nenhuma tabela auxiliar de configuração é necessária.
// ============================================================================
export const getCargaPorTurma = async (req, res, escolaIdFromRoute) => {
  const { turno } = req.query || {};
  const escola_id = req.user?.escola_id ?? escolaIdFromRoute;

  if (!escola_id) return res.status(403).json({ erro: "Acesso negado: escola não definida." });
  if (!turno)     return res.status(400).json({ erro: "turno é obrigatório." });

  try {
    // JOIN direto: turma_cargas → disciplinas → turmas
    // O disciplina_id em turma_cargas já aponta para o registro correto
    // de disciplinas (com etapa+turno+carga da turma).
    const [rows] = await pool.query(
      `SELECT
         tc.turma_id,
         tc.disciplina_id,
         IFNULL(d.carga, 1) AS carga
       FROM turma_cargas tc
       JOIN disciplinas d ON d.id = tc.disciplina_id
       JOIN turmas      t ON t.id  = tc.turma_id
       WHERE tc.escola_id = ?
         AND t.turno      = ?
         AND t.ano        = YEAR(CURDATE())`,
      [escola_id, turno]
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
