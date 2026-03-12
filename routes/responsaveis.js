import express from "express";
import pool from "../db.js";

const router = express.Router();

// LISTAR RESPONSÁVEIS VINCULADOS À ESCOLA
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    
    const sql = `
      SELECT r.id, r.nome, r.cpf, r.email, r.telefone_celular, r.telefone_secundario, r.status_global,
             GROUP_CONCAT(DISTINCT a.estudante SEPARATOR ', ') AS alunos_vinculados,
             ra.ativo AS vinculo_ativo
      FROM responsaveis r
      INNER JOIN responsaveis_alunos ra ON ra.responsavel_id = r.id AND ra.escola_id = ?
      LEFT JOIN alunos a ON a.id = ra.aluno_id
      GROUP BY r.id, ra.ativo
      ORDER BY r.nome ASC
    `;
    const [rows] = await pool.query(sql, [escola_id]);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar responsáveis:", err);
    res.status(500).json({ error: "Erro ao listar responsáveis." });
  }
});

// BUSCAR ALUNOS PARA O SELECT DE VÍNCULO
router.get("/buscar-alunos", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { busca } = req.query;
    
    let sql = `SELECT id, estudante, codigo FROM alunos WHERE escola_id = ?`;
    const params = [escola_id];

    if (busca) {
      sql += ` AND estudante LIKE ?`;
      params.push(`%${busca}%`);
    }

    sql += ` ORDER BY estudante ASC LIMIT 50`;

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar alunos:", err);
    res.status(500).json({ error: "Erro ao buscar alunos." });
  }
});

// CRIAR RESPONSÁVEL
router.post("/", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { escola_id } = req.user;
    const { nome, cpf, email, telefone_celular, telefone_secundario, aluno_id, relacionamento } = req.body;

    if (!nome) return res.status(400).json({ error: "Nome é obrigatório." });
    if (!cpf) return res.status(400).json({ error: "CPF é obrigatório." });
    if (!telefone_celular) return res.status(400).json({ error: "Telefone Principal é obrigatório." });
    if (!aluno_id) return res.status(400).json({ error: "O estudante vinculado é obrigatório." });

    await connection.beginTransaction();

    let responsavelId;
    
    // Verifica se CPF já existe
    if (cpf) {
      const [[exists]] = await connection.query("SELECT id FROM responsaveis WHERE cpf = ?", [cpf]);
      if (exists) {
        responsavelId = exists.id;
        // Atualiza os dados básicos se já existe
        await connection.query(
          "UPDATE responsaveis SET nome = ?, email = ?, telefone_celular = ?, telefone_secundario = ? WHERE id = ?",
          [nome, email || null, telefone_celular || null, telefone_secundario || null, responsavelId]
        );
      }
    }

    if (!responsavelId) {
      const [result] = await connection.query(
        "INSERT INTO responsaveis (nome, cpf, email, telefone_celular, telefone_secundario) VALUES (?, ?, ?, ?, ?)",
        [nome, cpf || null, email || null, telefone_celular || null, telefone_secundario || null]
      );
      responsavelId = result.insertId;
    }

    // Se informou um aluno para vincular, vincula
    if (aluno_id) {
      // Verifica se já não tá vinculado
      const [[vinculoExiste]] = await connection.query(
        "SELECT id FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
        [responsavelId, aluno_id, escola_id]
      );

      if (!vinculoExiste) {
        await connection.query(
          `INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo)
           VALUES (?, ?, ?, ?, 1)`,
          [escola_id, responsavelId, aluno_id, relacionamento || 'RESPONSAVEL']
        );
      }
    }

    await connection.commit();
    res.status(201).json({ message: "Responsável registrado com sucesso." });
  } catch (err) {
    await connection.rollback();
    console.error("Erro ao criar responsável:", err);
    res.status(500).json({ error: "Erro ao salvar o responsável." });
  } finally {
    connection.release();
  }
});

// EDITAR RESPONSÁVEL
router.put("/:id", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { escola_id } = req.user;
    const { id } = req.params;
    const { nome, cpf, email, telefone_celular, telefone_secundario, aluno_id, relacionamento } = req.body;

    if (!nome) return res.status(400).json({ error: "Nome é obrigatório." });
    if (!cpf) return res.status(400).json({ error: "CPF é obrigatório." });
    if (!telefone_celular) return res.status(400).json({ error: "Telefone Principal é obrigatório." });

    await connection.beginTransaction();

    await connection.query(
      "UPDATE responsaveis SET nome = ?, cpf = ?, email = ?, telefone_celular = ?, telefone_secundario = ? WHERE id = ?",
      [nome, cpf || null, email || null, telefone_celular || null, telefone_secundario || null, id]
    );

    // Se informou um aluno para vincular na edição, vincula
    if (aluno_id) {
      const [[vinculoExiste]] = await connection.query(
        "SELECT id FROM responsaveis_alunos WHERE responsavel_id = ? AND aluno_id = ? AND escola_id = ?",
        [id, aluno_id, escola_id]
      );

      if (!vinculoExiste) {
        await connection.query(
          `INSERT INTO responsaveis_alunos (escola_id, responsavel_id, aluno_id, relacionamento, ativo)
           VALUES (?, ?, ?, ?, 1)`,
          [escola_id, id, aluno_id, relacionamento || 'RESPONSAVEL']
        );
      }
    }

    await connection.commit();
    res.json({ message: "Dados atualizados com sucesso." });
  } catch (err) {
    await connection.rollback();
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "Já existe um responsável registrado com esse CPF." });
    }
    console.error("Erro ao atualizar responsável:", err);
    res.status(500).json({ error: "Erro ao atualizar responsável." });
  } finally {
    connection.release();
  }
});

// EXCLUIR RESPONSÁVEL (Apenas remove o vínculo da escola)
router.delete("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    await pool.query(
      "DELETE FROM responsaveis_alunos WHERE responsavel_id = ? AND escola_id = ?",
      [id, escola_id]
    );

    res.json({ message: "Vínculo removido com sucesso." });
  } catch (err) {
    console.error("Erro ao remover responsável:", err);
    res.status(500).json({ error: "Erro ao remover vínculo." });
  }
});

export default router;
