// api/routes/disciplinas.js
import { Router } from "express";
import pool from "../db.js";

const router = Router();


// Middleware para verificar se o usuário tem escola associada
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}




/**
 * GET /api/disciplinas
 * Lista todas as disciplinas da escola do usuário
 */
router.get("/", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const [rows] = await pool.query(
      `
      SELECT 
        id,
        nome AS disciplina,
        etapa,
        carga,
        escola_id
      FROM disciplinas
      WHERE escola_id = ?
      ORDER BY nome, etapa
      `,
      [escola_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar disciplinas:", err);
    res.status(500).json({ error: "Não foi possível carregar as disciplinas." });
  }
});




/**
 * POST /api/disciplinas
 * Cria uma nova disciplina para a escola do usuário
 */
router.post("/", verificarEscola, async (req, res) => {
  const { nome, carga, etapa } = req.body;
  const { escola_id } = req.user;

  if (!nome || carga == null) {
    return res.status(400).json({ message: "Nome e carga são obrigatórios." });
  }

  const etapaFinal = etapa?.trim().toUpperCase() || "GERAL";

  try {
    // ✅ Validação de unicidade: nome normalizado + etapa + escola_id
    const nomeNormalizado = nome.trim();
    const [[existente]] = await pool.query(
      `SELECT id FROM disciplinas
       WHERE LOWER(TRIM(nome)) = LOWER(?) AND UPPER(TRIM(etapa)) = ? AND escola_id = ? LIMIT 1`,
      [nomeNormalizado, etapaFinal, escola_id]
    );
    if (existente) {
      return res.status(409).json({
        message: `Já existe a disciplina "${nomeNormalizado}" para a etapa "${etapaFinal}" nesta escola.`
      });
    }

    const [result] = await pool.query(
      `INSERT INTO disciplinas (nome, etapa, carga, escola_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [nomeNormalizado, etapaFinal, carga, escola_id]
    );

    const [rows] = await pool.query(
      `SELECT id, nome AS disciplina, etapa, carga, escola_id
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
 * Remove disciplina da escola do usuário
 */
router.delete("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { escola_id } = req.user;

    const [result] = await pool.query(
      "DELETE FROM disciplinas WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Disciplina não encontrada ou não pertence à sua escola." });
    }

    return res.json({ message: "Disciplina excluída com sucesso." });
  } catch (err) {
    // ✅ FIX ALTO 3: trata FK constraint — disciplina vinculada não pode ser excluída
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({
        message: "Não é possível excluir: esta disciplina está vinculada a professores, modulação ou planos de avaliação."
      });
    }
    console.error("Erro ao excluir disciplina:", err);
    return res.status(500).json({ message: "Erro ao excluir disciplina." });
  }
});




/**
 * PUT /api/disciplinas/:id
 * Atualiza disciplina da escola do usuário
 */
router.put("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, carga, etapa } = req.body;
    const { escola_id } = req.user;

    if (!nome || carga == null) {
      return res.status(400).json({ message: "Nome e carga são obrigatórios." });
    }

    const etapaFinal = etapa?.trim().toUpperCase() || "GERAL";

    // ✅ Validação de unicidade ao editar: exclui o próprio registro
    const nomeNormalizado = nome.trim();
    const [[duplicada]] = await pool.query(
      `SELECT id FROM disciplinas
       WHERE LOWER(TRIM(nome)) = LOWER(?) AND UPPER(TRIM(etapa)) = ? AND escola_id = ? AND id != ? LIMIT 1`,
      [nomeNormalizado, etapaFinal, escola_id, id]
    );
    if (duplicada) {
      return res.status(409).json({
        message: `Já existe outra disciplina "${nomeNormalizado}" para a etapa "${etapaFinal}" nesta escola.`
      });
    }

    const [result] = await pool.query(
      `UPDATE disciplinas
       SET nome = ?, etapa = ?, carga = ?
       WHERE id = ? AND escola_id = ?`,
      [nomeNormalizado, etapaFinal, carga, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Disciplina não encontrada ou não pertence à sua escola." });
    }

    return res.json({ message: "Disciplina atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar disciplina:", err);
    res.status(500).json({ message: "Erro ao atualizar disciplina." });
  }
});




export default router;