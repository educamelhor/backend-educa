// ──────────────────────────────────────────────────────────────
// api/controllers/alunosController.js
// ──────────────────────────────────────────────────────────────

import pool from "../db.js"; // ou seu cliente Sequelize, se for o caso

/**
 * GET /api/alunos/inativos
 * Retorna todos os alunos com status = "inativo"
 */
export const getInativos = async (req, res) => {
  try {



    const [rows] = await pool.query(
      `SELECT
      a.id,
      a.codigo,
      a.estudante,
      a.data_nascimento,
      a.sexo,
      a.turma_id,
      t.nome   AS turma,
      t.turno  AS turno,
      a.status,
      a.foto,
      a.serie
      FROM alunos AS a
      LEFT JOIN turmas AS t
      ON a.turma_id = t.id
      WHERE a.status = "inativo"
      ORDER BY a.estudante`
    );



    return res.status(200).json(rows);
  } catch (err) {
    console.error("Erro ao listar alunos inativos:", err);
    return res.status(500).json({ message: "Não foi possível buscar inativos" });
  }
};
