// api/routes/disciplinas.js
import { Router } from "express";
import pool from "../db.js";

const router = Router();

/**
 * GET /api/disciplinas
 * Lista todas as disciplinas
 */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        id,
        nome    AS disciplina,
        carga
      FROM disciplinas
      ORDER BY nome
    `);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar disciplinas:", err);
    res.status(500).json({ error: "Não foi possível carregar as disciplinas." });
  }
});

/**
 * POST /api/disciplinas
 * Cria uma nova disciplina. Espera no body:
 *  - nome  (string)
 *  - carga (number)
 */
router.post("/", async (req, res) => {
  const { nome, carga } = req.body;

  // validação básica
  if (!nome || carga == null) {
    return res.status(400).json({ message: "Nome e carga são obrigatórios." });
  }

  try {
    // insere a nova disciplina
    const [result] = await pool.query(
      `INSERT INTO disciplinas (nome, carga, created_at, updated_at)
       VALUES (?, ?, NOW(), NOW())`,
      [nome, carga]
    );

    // retorna o registro recém-criado
    const [rows] = await pool.query(
      `SELECT id, nome AS disciplina, carga
       FROM disciplinas
       WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Erro ao criar disciplina:", err);
    res.status(500).json({ message: "Não foi possível criar a disciplina." });
  }
});




/**
 * DELETE /api/disciplinas/:id
 * Remove uma disciplina pelo ID.
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query("DELETE FROM disciplinas WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Disciplina não encontrada." });
    }

    return res.json({ message: "Disciplina excluída com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir disciplina:", err);
    return res.status(500).json({ message: "Erro ao excluir disciplina." });
  }
});





// PUT /api/disciplinas/:id → Atualiza uma disciplina existente
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, carga } = req.body;

    if (!nome || !carga) {
      return res.status(400).json({ message: "Nome e carga são obrigatórios." });
    }

    const [result] = await pool.query(
      `UPDATE disciplinas SET nome = ?, carga = ? WHERE id = ?`,
      [nome, carga, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Disciplina não encontrada." });
    }

    return res.json({ message: "Disciplina atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar disciplina:", err);
    res.status(500).json({ message: "Erro ao atualizar disciplina." });
  }
});





export default router;
