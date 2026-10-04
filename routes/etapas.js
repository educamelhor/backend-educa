import { Router } from "express";
import pool from "../db.js";

const router = Router();

function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

/**
 * GET /api/etapas
 * Lista todas as etapas da escola do usuário
 */
router.get("/", verificarEscola, async (req, res) => {
  try {
    const userEscolaId = req.user.escola_id;
    const targetEscolaId = req.query.escola_id ? Number(req.query.escola_id) : userEscolaId;

    const [rows] = await pool.query(
      `SELECT id, escola_id, nome, sigla, ordem, ativa, criado_em, atualizado_em
       FROM etapas
       WHERE escola_id = ? AND ativa = 1
       ORDER BY ordem ASC, nome ASC`,
      [targetEscolaId]
    );

    res.json(rows);
  } catch (error) {
    console.error("Erro ao buscar etapas:", error);
    res.status(500).json({ message: "Erro interno no servidor ao buscar etapas." });
  }
});

/**
 * POST /api/etapas
 * Criar nova etapa
 */
router.post("/", verificarEscola, async (req, res) => {
  try {
    const escola_id = req.user.escola_id;
    const { nome, sigla, ordem } = req.body;

    if (!nome || !nome.trim()) {
      return res.status(400).json({ message: "O nome da etapa é obrigatório." });
    }

    const [result] = await pool.query(
      `INSERT INTO etapas (escola_id, nome, sigla, ordem) VALUES (?, ?, ?, ?)`,
      [escola_id, nome.trim(), sigla ? sigla.trim() : null, Number(ordem) || 1]
    );

    const [[novaEtapa]] = await pool.query(`SELECT * FROM etapas WHERE id = ?`, [result.insertId]);
    res.status(201).json(novaEtapa);
  } catch (error) {
    console.error("Erro ao criar etapa:", error);
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Já existe uma etapa cadastrada com este nome." });
    }
    res.status(500).json({ message: "Erro interno ao criar etapa." });
  }
});

/**
 * PUT /api/etapas/:id
 * Atualizar etapa existente
 */
router.put("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const escola_id = req.user.escola_id;
    const { nome, sigla, ordem, ativa } = req.body;

    await pool.query(
      `UPDATE etapas
       SET nome = ?, sigla = ?, ordem = ?, ativa = ?
       WHERE id = ? AND escola_id = ?`,
      [nome.trim(), sigla ? sigla.trim() : null, Number(ordem) || 1, ativa !== undefined ? Number(ativa) : 1, id, escola_id]
    );

    const [[etapaAtualizada]] = await pool.query(`SELECT * FROM etapas WHERE id = ?`, [id]);
    res.json(etapaAtualizada);
  } catch (error) {
    console.error("Erro ao atualizar etapa:", error);
    res.status(500).json({ message: "Erro interno ao atualizar etapa." });
  }
});

/**
 * DELETE /api/etapas/:id
 * Excluir etapa
 */
router.delete("/:id", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const escola_id = req.user.escola_id;

    // 1. Verificar se a etapa está sendo utilizada em turmas
    const [[turmaUso]] = await pool.query(`SELECT COUNT(*) as c FROM turmas WHERE etapa_id = ?`, [id]);
    if (turmaUso && turmaUso.c > 0) {
      return res.status(400).json({ message: `Esta etapa não pode ser excluída pois está associada a ${turmaUso.c} turma(s).` });
    }

    // 2. Verificar se a etapa está sendo utilizada em professor_vinculos
    const [[vincUso]] = await pool.query(`SELECT COUNT(*) as c FROM professor_vinculos WHERE etapa_id = ?`, [id]);
    if (vincUso && vincUso.c > 0) {
      return res.status(400).json({ message: `Esta etapa não pode ser excluída pois está associada a ${vincUso.c} vínculo(s) de professor.` });
    }

    // 3. Excluir etapa
    const [result] = await pool.query(`DELETE FROM etapas WHERE id = ? AND escola_id = ?`, [id, escola_id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Etapa não encontrada ou não pertence à sua escola." });
    }

    res.json({ message: "Etapa excluída com sucesso." });
  } catch (error) {
    console.error("Erro ao deletar etapa:", error);
    res.status(500).json({ message: "Erro interno ao deletar etapa." });
  }
});

export default router;
