// api/routes/turmas.js

import { Router } from "express";
import pool from "../db.js";

const router = Router();

/**
 * GET /api/turmas
 * Retorna todas as turmas com seus campos básicos:
 *  - id
 *  - turma (nome da turma, ex: "1A")
 *  - serie (ex: "6º ANO")
 *  - turno (ex: "Matutino" ou "Vespertino")
 *  - escola (nome da escola)
 */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        t.id,
        t.nome        AS turma,
        t.serie,
        t.turno,
        t.escola_id,
        e.nome        AS escola
      FROM turmas t
      JOIN escolas e ON e.id = t.escola_id
      ORDER BY t.serie, t.nome
    `);

    return res.status(200).json(rows);
  } catch (err) {
    console.error("Erro ao listar turmas:", err);
    return res.status(500).json({ error: "Não foi possível carregar as turmas" });
  }
});

/**
 * POST /api/turmas
 * Cria uma nova turma. Espera no body:
 *  - nome      (string)
 *  - serie     (string)
 *  - turno     (string)
 *  - escola_id (integer)
 */
router.post("/", async (req, res) => {
  const { turma, serie, turno, escola_id } = req.body;

  // validação básica
  if (!turma || !serie || !turno || !escola_id) {
    return res.status(400).json({ message: "Todos os campos são obrigatórios." });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO turmas (nome, serie, turno, escola_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [turma, serie, turno, escola_id]
    );






    // Opcional: retornar a turma criada
    const [rows] = await pool.query(
      `SELECT
         t.id,
         t.nome    AS turma,
         t.serie,
         t.turno,
         e.nome    AS escola
       FROM turmas t
       JOIN escolas e
         ON e.id = t.escola_id
       WHERE t.id = ?`,
      [result.insertId]
    );

    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Erro ao criar turma:", err);
    return res.status(500).json({ message: "Não foi possível criar a turma." });
  }
});





// DELETE /api/turmas/:id → Remove uma turma pelo ID
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query("DELETE FROM turmas WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Turma não encontrada." });
    }

    return res.json({ message: "Turma excluída com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir turma:", err);
    return res.status(500).json({ message: "Erro ao excluir turma." });
  }
});




// PUT /api/turmas/:id → Atualiza uma turma existente
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id, turma, turno, serie } = req.body;

    if (!escola_id || !turma || !turno || !serie) {
      return res.status(400).json({ message: "Todos os campos são obrigatórios." });
    }

    const [result] = await pool.query(
      `UPDATE turmas SET escola_id = ?, nome = ?, turno = ?, serie = ? WHERE id = ?`,
      [escola_id, turma, turno, serie, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Turma não encontrada." });
    }

    return res.json({ message: "Turma atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar turma:", err);
    res.status(500).json({ message: "Erro ao atualizar turma." });
  }
});






export default router;
