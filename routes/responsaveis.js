import express from "express";
import pool from "../db.js";

const router = express.Router();

// LISTAR RESPONSÁVEIS VINCULADOS À ESCOLA
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    
    const sql = `
      SELECT r.id, r.nome, r.cpf, r.email, r.telefone_celular, r.telefone_secundario, r.endereco, r.status_global,
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

// LISTAR RESPONSÁVEIS PARA SECRETARIA (uma linha por par aluno/responsável)
// GET /api/responsaveis/secretaria?filtro=&ano_letivo=&limit=&offset=
router.get("/secretaria", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const {
      filtro = "",
      ano_letivo,
      limit = 200,
      offset = 0,
    } = req.query;

    const where = ["ra.escola_id = ?", "ra.ativo = 1"];
    const params = [escola_id];

    if (ano_letivo) {
      where.push("m.ano_letivo = ?");
      params.push(Number(ano_letivo));
    }

    if (filtro) {
      where.push(`(
        a.estudante LIKE ? OR a.codigo LIKE ? OR
        r.nome LIKE ? OR r.cpf LIKE ?
      )`);
      const f = `%${filtro}%`;
      params.push(f, f, f, f);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    // Count
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM responsaveis_alunos ra
       INNER JOIN alunos a ON a.id = ra.aluno_id
       INNER JOIN responsaveis r ON r.id = ra.responsavel_id
       LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = ra.escola_id
       ${whereSql}`,
      params
    );
    const total = countRows[0]?.total || 0;

    // Data
    const dataParams = [...params, Number(limit), Number(offset)];
    const [rows] = await pool.query(
      `SELECT
         ra.id AS vinculo_id,
         a.codigo AS re,
         a.estudante AS aluno,
         r.id AS responsavel_id,
         r.nome AS responsavel,
         r.cpf,
         r.telefone_celular,
         r.email,
         t.nome AS turma,
         t.turno
       FROM responsaveis_alunos ra
       INNER JOIN alunos a ON a.id = ra.aluno_id
       INNER JOIN responsaveis r ON r.id = ra.responsavel_id
       LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = ra.escola_id
       LEFT JOIN turmas t ON t.id = m.turma_id
       ${whereSql}
       ORDER BY a.estudante ASC, r.nome ASC
       LIMIT ? OFFSET ?`,
      dataParams
    );

    res.json({ rows, total });
  } catch (err) {
    console.error("Erro ao listar responsáveis (secretaria):", err);
    res.status(500).json({ error: "Erro ao listar responsáveis." });
  }
});

// LISTAR ALUNOS VINCULADOS A UM RESPONSÁVEL (com status de consentimento)
router.get("/:id/alunos", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const sql = `
      SELECT
        ra.id AS vinculo_id,
        ra.aluno_id,
        a.estudante AS aluno_nome,
        a.codigo AS aluno_codigo,
        ra.consentimento_imagem,
        ra.consentimento_imagem_em,
        ra.consentimento_imagem_por
      FROM responsaveis_alunos ra
      INNER JOIN alunos a ON a.id = ra.aluno_id
      WHERE ra.responsavel_id = ? AND ra.escola_id = ? AND ra.ativo = 1
      ORDER BY a.estudante ASC
    `;
    const [rows] = await pool.query(sql, [id, escola_id]);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar alunos do responsável:", err);
    res.status(500).json({ error: "Erro ao listar alunos vinculados." });
  }
});

// REGISTRAR CONSENTIMENTO DE USO DE IMAGEM E DADOS BIOMÉTRICOS
router.post("/:id/consentimento-imagem", async (req, res) => {
  try {
    const { escola_id, usuario_id } = req.user;
    const responsavelId = req.params.id;
    const { aluno_ids } = req.body; // array de aluno_ids para consentir

    if (!Array.isArray(aluno_ids) || aluno_ids.length === 0) {
      return res.status(400).json({ error: "Informe pelo menos um aluno para registrar o consentimento." });
    }

    const placeholders = aluno_ids.map(() => "?").join(", ");
    const params = [responsavelId, escola_id, ...aluno_ids.map(Number)];

    await pool.query(
      `UPDATE responsaveis_alunos
       SET consentimento_imagem = 1,
           consentimento_imagem_em = NOW(),
           consentimento_imagem_por = ?
       WHERE responsavel_id = ?
         AND escola_id = ?
         AND aluno_id IN (${placeholders})
         AND ativo = 1`,
      [usuario_id || null, ...params]
    );

    res.json({ message: "Consentimento registrado com sucesso.", aluno_ids });
  } catch (err) {
    console.error("Erro ao registrar consentimento:", err);
    res.status(500).json({ error: "Erro ao registrar consentimento." });
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
    const { nome, cpf: cpfRaw, email, telefone_celular, telefone_secundario, endereco, aluno_id, relacionamento } = req.body;
    const cpf = cpfRaw ? cpfRaw.replace(/\D/g, '') : null;

    if (!nome) return res.status(400).json({ error: "Nome é obrigatório." });
    if (!cpf) return res.status(400).json({ error: "CPF é obrigatório." });
    if (!telefone_celular) return res.status(400).json({ error: "Telefone Principal é obrigatório." });

    if (!endereco) return res.status(400).json({ error: "Endereço é obrigatório." });
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
          "UPDATE responsaveis SET nome = ?, email = ?, telefone_celular = ?, telefone_secundario = ?, endereco = ? WHERE id = ?",
          [nome, email || null, telefone_celular || null, telefone_secundario || null, endereco || null, responsavelId]
        );
      }
    }

    if (!responsavelId) {
      const [result] = await connection.query(
        "INSERT INTO responsaveis (nome, cpf, email, telefone_celular, telefone_secundario, endereco) VALUES (?, ?, ?, ?, ?, ?)",
        [nome, cpf || null, email || null, telefone_celular || null, telefone_secundario || null, endereco || null]
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
    const { nome, cpf: cpfRaw, email, telefone_celular, telefone_secundario, endereco, aluno_id, relacionamento } = req.body;
    const cpf = cpfRaw ? cpfRaw.replace(/\D/g, '') : null;

    if (!nome) return res.status(400).json({ error: "Nome é obrigatório." });
    if (!cpf) return res.status(400).json({ error: "CPF é obrigatório." });
    if (!telefone_celular) return res.status(400).json({ error: "Telefone Principal é obrigatório." });

    if (!endereco) return res.status(400).json({ error: "Endereço é obrigatório para edição." });

    await connection.beginTransaction();

    await connection.query(
      "UPDATE responsaveis SET nome = ?, cpf = ?, email = ?, telefone_celular = ?, telefone_secundario = ?, endereco = ? WHERE id = ?",
      [nome, cpf || null, email || null, telefone_celular || null, telefone_secundario || null, endereco || null, id]
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

// VERIFICAR CONSENTIMENTO DE IMAGEM PARA UM ALUNO
// Utilizado por qualquer módulo/app para decidir se pode exibir a foto
router.get("/consentimento-imagem/aluno/:aluno_id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { aluno_id } = req.params;

    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM responsaveis_alunos
       WHERE aluno_id = ? AND escola_id = ? AND ativo = 1 AND consentimento_imagem = 1`,
      [aluno_id, escola_id]
    );

    res.json({ autorizado: (row?.total || 0) > 0 });
  } catch (err) {
    console.error("Erro ao verificar consentimento:", err);
    res.status(500).json({ error: "Erro ao verificar consentimento." });
  }
});

export default router;
