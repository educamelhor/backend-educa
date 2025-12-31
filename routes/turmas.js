// src/routes/turmas.js
import express from "express";
import pool from "../db.js";

const router = express.Router();


// Middleware para validar e forçar filtro por escola
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
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
    const { filtro = "" } = req.query;

    let sql = `
      SELECT
        t.id,
        t.nome AS turma,
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
    return res.status(500).json({ error: "Não foi possível carregar as turmas" });
  }
});





/**
 * ================================
 * CRIAR TURMA (vinculada à escola)
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
    return res.status(500).json({ error: "Não foi possível criar a turma" });
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
      return res.status(404).json({ error: "Turma não encontrada ou não pertence à sua escola" });
    }

    return res.status(200).json({ message: "Turma atualizada com sucesso" });
  } catch (err) {
    console.error("Erro ao atualizar turma:", err);
    return res.status(500).json({ error: "Não foi possível atualizar a turma" });
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
      return res.status(404).json({ error: "Turma não encontrada ou não pertence à sua escola" });
    }

    return res.status(200).json({ message: "Turma excluída com sucesso" });
  } catch (err) {
    console.error("Erro ao excluir turma:", err);
    return res.status(500).json({ error: "Não foi possível excluir a turma" });
  }
});

export default router;
