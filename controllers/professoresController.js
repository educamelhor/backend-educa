import pool from "../db.js";  // ajuste o caminho se necessário

/**
 * PUT /api/professores/inativar/:id
 * Marca o professor como inativo no banco
 */
export const inactivateProfessor = async (req, res) => {
  const { id } = req.params;
  try {
    // Ajuste o nome da tabela/campos conforme seu esquema
    await pool.query("UPDATE professores SET status = 'inativo' WHERE id = ?", [id]);
    // Retorna o registro atualizado (opcional)
    const [rows] = await pool.query("SELECT * FROM professores WHERE id = ?", [id]);
    return res.status(200).json(rows[0]);
  } catch (err) {
    console.error("Erro ao inativar professor:", err);
    return res.status(500).json({ message: "Não foi possível inativar professor" });
  }
};


export const getProfessores = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        p.*, 
        d.disciplina AS disciplina_nome 
      FROM professores p
      JOIN disciplinas d ON p.disciplina_id = d.id
    `);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar professores:", err);
    res.status(500).json({ message: "Erro ao buscar professores" });
  }
};