// src/routes/turmas.js
import express from "express";
import pool from "../db.js";

const router = express.Router();


// Middleware para validar e forÃ§ar filtro por escola
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola nÃ£o definida." });
  }
  next();
}




/**
 * ================================
 * LISTAR TURMAS (somente da escola)
 * GET /api/turmas
 * ================================
 */
router.get("/", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { filtro = "", ano = "" } = req.query;

    let sql = `
      SELECT
        t.id,
        t.nome AS turma,
        t.nome_oficial,
        t.etapa,
        t.ano,
        t.serie,
        t.turno,
        t.escola_id,
        e.nome AS escola
      FROM turmas t
      JOIN escolas e ON e.id = t.escola_id
      WHERE t.escola_id = ?
    `;
    const params = [escola_id];

    if (ano) {
      sql += " AND t.ano = ?";
      params.push(ano);
    }

    if (filtro) {
      sql += " AND (t.nome LIKE ? OR t.serie LIKE ? OR t.turno LIKE ?)";
      const likeFiltro = `%${filtro}%`;
      params.push(likeFiltro, likeFiltro, likeFiltro);
    }

    sql += " ORDER BY t.serie, t.nome";

    const [rows] = await pool.query(sql, params);
    return res.status(200).json(rows);
  } catch (err) {
    console.error("Erro ao listar turmas:", err);
    return res.status(500).json({ error: "NÃ£o foi possÃ­vel carregar as turmas" });
  }
});





/**
 * ================================
 * CRIAR TURMA (vinculada Ã  escola)
 * POST /api/turmas
 * ================================
 */
router.post("/", verificarEscola, async (req, res) => {
  try {
    const { nome, etapa, ano, serie, turno } = req.body;
    const { escola_id } = req.user;

    const [result] = await pool.query(
      "INSERT INTO turmas (nome, etapa, ano, serie, turno, escola_id) VALUES (?, ?, ?, ?, ?, ?)",
      [nome, etapa, ano, serie, turno, escola_id]
    );
    return res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error("Erro ao criar turma:", err);
    return res.status(500).json({ error: "NÃ£o foi possÃ­vel criar a turma" });
  }
});






/**
 * ================================
 * EDITAR TURMA (somente da escola)
 * PUT /api/turmas/:id
 * ================================
 */
router.put("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, etapa, ano, serie, turno } = req.body;
    const { escola_id } = req.user;

    const [result] = await pool.query(
      "UPDATE turmas SET nome=?, etapa=?, ano=?, serie=?, turno=? WHERE id=? AND escola_id=?",
      [nome, etapa, ano, serie, turno, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Turma nÃ£o encontrada ou nÃ£o pertence Ã  sua escola" });
    }

    return res.status(200).json({ message: "Turma atualizada com sucesso" });
  } catch (err) {
    console.error("Erro ao atualizar turma:", err);
    return res.status(500).json({ error: "NÃ£o foi possÃ­vel atualizar a turma" });
  }
});





/**
 * ================================
 * EXCLUIR TURMA (somente da escola)
 * DELETE /api/turmas/:id
 * ================================
 */
router.delete("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    const [result] = await pool.query(
      "DELETE FROM turmas WHERE id=? AND escola_id=?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Turma nÃ£o encontrada ou nÃ£o pertence Ã  sua escola" });
    }

    return res.status(200).json({ message: "Turma excluÃ­da com sucesso" });
  } catch (err) {
    console.error("Erro ao excluir turma:", err);
    return res.status(500).json({ error: "NÃ£o foi possÃ­vel excluir a turma" });
  }
});

/**
 * ================================
 * LISTAR ALUNOS DE UMA TURMA
 * GET /api/turmas/:id/alunos
 * ================================
 * Busca alunos matriculados em uma turma especÃ­fica (ano letivo atual).
 * Fonte canÃ´nica: tabela `matriculas`.
 */
router.get("/:id/alunos", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;
    // Aceita 'ano' OU 'ano_letivo' (frontend pode enviar qualquer um dos dois)
    const anoLetivo = req.query.ano || req.query.ano_letivo || new Date().getFullYear();

    // Query principal: status 'ativo' OU 'matriculado'
    const [rows] = await pool.query(
      `
      SELECT
        a.id,
        a.estudante AS nome,
        a.codigo    AS matricula
      FROM matriculas m
      INNER JOIN alunos a ON a.id = m.aluno_id
      WHERE m.turma_id   = ?
        AND m.escola_id  = ?
        AND m.ano_letivo = ?
        AND m.status IN ('ativo', 'matriculado')
      ORDER BY a.estudante ASC
      `,
      [id, escola_id, anoLetivo]
    );

    // Fallback: se a query principal retornou vazio, tenta SEM filtro de status
    // (cobre casos onde o status foi gravado com valor diferente do esperado)
    if (rows.length === 0) {
      const [rowsFallback] = await pool.query(
        `
        SELECT
          a.id,
          a.estudante AS nome,
          a.codigo    AS matricula
        FROM matriculas m
        INNER JOIN alunos a ON a.id = m.aluno_id
        WHERE m.turma_id   = ?
          AND m.escola_id  = ?
          AND m.ano_letivo = ?
        ORDER BY a.estudante ASC
        `,
        [id, escola_id, anoLetivo]
      );
      return res.json({ ok: true, alunos: rowsFallback, fallback: "sem-status" });
    }

    // === Fallback 3: por NOME da turma ===
    // Cobre o caso onde o aluno foi matriculado com id de uma turma diferente
    // mas com o mesmo nome (ex: dois registros de "7 ANO A" na tabela turmas).
    // Isso acontece quando a secretaria usa um turma_id e a modulacao usa outro.
    const [[turmaNomeRow]] = await pool.query(
      "SELECT nome FROM turmas WHERE id = ? AND escola_id = ? LIMIT 1",
      [id, escola_id]
    );
    if (turmaNomeRow?.nome) {
      const [rowsByNome] = await pool.query(
        `SELECT DISTINCT a.id, a.estudante AS nome, a.codigo AS matricula
         FROM matriculas m
         INNER JOIN alunos a ON a.id = m.aluno_id
         INNER JOIN turmas t ON t.id = m.turma_id
         WHERE t.nome       = ?
           AND m.escola_id  = ?
           AND m.ano_letivo = ?
         ORDER BY a.estudante ASC`,
        [turmaNomeRow.nome, escola_id, anoLetivo]
      );
      return res.json({ ok: true, alunos: rowsByNome, fallback: "nome-turma" });
    }

    return res.json({ ok: true, alunos: [] });
  } catch (err) {
    console.error("Erro ao listar alunos da turma:", err);
    return res.status(500).json({ ok: false, error: "NÃ£o foi possÃ­vel carregar os alunos da turma." });
  }
});

/**
 * ==========================================
 * ATUALIZAR NOME OFICIAL DA TURMA (Mapeamento)
 * PATCH /api/turmas/:id/nome-oficial
 * ==========================================
 */
router.patch("/:id/nome-oficial", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome_oficial } = req.body;
    const { escola_id } = req.user;

    await pool.query(
      "UPDATE turmas SET nome_oficial = ? WHERE id = ? AND escola_id = ?",
      [nome_oficial, id, escola_id]
    );

    return res.status(200).json({ success: true, message: "Nome oficial da turma atualizado com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar nome oficial da turma:", err);
    return res.status(500).json({ error: "NÃ£o foi possÃ­vel atualizar o nome oficial da turma." });
  }
});


/**
 * DIAGNOSTICO TEMPORARIO — GET /api/turmas/diagnostico/aluno?codigo=488943
 * Remove apos resolver o bug.
 */
router.get("/diagnostico/aluno", verificarEscola, async (req, res) => {
  try {
    const { codigo } = req.query;
    const { escola_id } = req.user;
    if (!codigo) return res.status(400).json({ error: "Informe o codigo." });
    const [[aluno]] = await pool.query(
      "SELECT id, codigo, estudante, turma_id AS turma_id_alunos, status FROM alunos WHERE codigo = ? AND escola_id = ?",
      [codigo, escola_id]
    );
    if (!aluno) return res.json({ ok: false, msg: "Aluno nao encontrado." });
    const [matriculas] = await pool.query(
      "SELECT m.id, m.turma_id, m.ano_letivo, m.status, t.nome AS turma_nome, t.turno FROM matriculas m LEFT JOIN turmas t ON t.id = m.turma_id WHERE m.aluno_id = ? AND m.escola_id = ? ORDER BY m.ano_letivo DESC",
      [aluno.id, escola_id]
    );
    return res.json({ ok: true, aluno, matriculas });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;

