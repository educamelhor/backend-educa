import express from "express";
import pool from "../db.js";

const router = express.Router();

// ============================================================================
// Liberações Antecipadas de Alunos (Escolas Regulares)
// ============================================================================

// [GET] /api/liberacoes - Listar histórico com paginação e filtros
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const {
      page = 1,
      limit = 30,
      turno = "",
      turma_id = "",
      aluno_nome = "",
      data_inicio = "",
      data_fim = "",
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);
    const where = ["la.escola_id = ?"];
    const params = [escola_id];

    if (turno) {
      where.push("t.turno = ?");
      params.push(turno);
    }
    if (turma_id) {
      where.push("la.turma_id = ?");
      params.push(turma_id);
    }
    if (aluno_nome) {
      where.push("a.estudante LIKE ?");
      params.push(`%${aluno_nome}%`);
    }
    if (data_inicio) {
      where.push("DATE(la.data_hora_saida) >= ?");
      params.push(data_inicio);
    }
    if (data_fim) {
      where.push("DATE(la.data_hora_saida) <= ?");
      params.push(data_fim);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    // Total de registros para paginação
    const [[kpiRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM liberacoes_alunos la
       LEFT JOIN turmas t ON t.id = la.turma_id
       LEFT JOIN alunos a ON a.id = la.aluno_id
       ${whereSql}`,
      params
    );
    const total = kpiRow?.total || 0;

    // Registros detalhados
    const dataParams = [...params, Number(limit), offset];
    const [rows] = await pool.query(
      `SELECT
         la.id,
         la.data_hora_saida,
         la.responsavel_cadastrado_id,
         la.responsavel_nome_avulso,
         la.responsavel_parentesco_avulso,
         la.responsavel_telefone_avulso,
         la.motivo,
         la.observacao,
         la.registrado_por,
         la.criado_em,
         a.id        AS aluno_id,
         a.estudante AS aluno_nome,
         a.codigo    AS aluno_codigo,
         t.id        AS turma_id,
         t.nome      AS turma_nome,
         t.turno,
         r.nome      AS responsavel_cadastrado_nome,
         ra.relacionamento AS responsavel_parentesco
       FROM liberacoes_alunos la
       INNER JOIN alunos a ON a.id = la.aluno_id
       LEFT JOIN turmas t ON t.id = la.turma_id
       LEFT JOIN responsaveis r ON r.id = la.responsavel_cadastrado_id
       LEFT JOIN responsaveis_alunos ra ON ra.responsavel_id = la.responsavel_cadastrado_id
                                       AND ra.aluno_id = la.aluno_id
                                       AND ra.escola_id = la.escola_id
       ${whereSql}
       ORDER BY la.data_hora_saida DESC
       LIMIT ? OFFSET ?`,
      dataParams
    );

    res.json({
      registros: rows,
      paginacao: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error("[Liberação] Erro ao listar:", err);
    res.status(500).json({ error: "Erro ao carregar registros de liberação." });
  }
});

// [GET] /api/liberacoes/buscar-alunos - Buscar estudantes matriculados
router.get("/buscar-alunos", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { turno = "", turma_id = "", nome = "" } = req.query;

    const ANO = String(new Date().getFullYear());
    const where = ["m.escola_id = ?", "m.ano_letivo = ?"];
    const params = [escola_id, ANO];

    if (turno) {
      where.push("t.turno = ?");
      params.push(turno);
    }
    if (turma_id) {
      where.push("m.turma_id = ?");
      params.push(turma_id);
    }
    if (nome) {
      where.push("a.estudante LIKE ?");
      params.push(`%${nome}%`);
    }

    const [rows] = await pool.query(
      `SELECT
         a.id,
         a.estudante,
         a.codigo,
         t.id    AS turma_id,
         t.nome  AS turma_nome,
         t.turno
       FROM alunos a
       INNER JOIN matriculas m ON m.aluno_id = a.id
       INNER JOIN turmas t ON t.id = m.turma_id
       WHERE ${where.join(" AND ")}
       ORDER BY a.estudante ASC
       LIMIT 200`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("[Liberação] Erro ao buscar alunos:", err);
    res.status(500).json({ error: "Erro ao buscar alunos." });
  }
});

// [GET] /api/liberacoes/responsaveis-aluno/:aluno_id - Buscar responsáveis vinculados
router.get("/responsaveis-aluno/:aluno_id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { aluno_id } = req.params;

    const [rows] = await pool.query(
      `SELECT
         r.id,
         r.nome,
         r.cpf,
         r.telefone_celular,
         r.telefone_secundario,
         ra.relacionamento
       FROM responsaveis r
       INNER JOIN responsaveis_alunos ra ON ra.responsavel_id = r.id
                                         AND ra.aluno_id = ?
                                         AND ra.escola_id = ?
                                         AND ra.ativo = 1
       ORDER BY r.nome ASC`,
      [aluno_id, escola_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("[Liberação] Erro ao buscar responsáveis:", err);
    res.status(500).json({ error: "Erro ao buscar responsáveis." });
  }
});

// [POST] /api/liberacoes - Registrar saída antecipada
router.post("/", async (req, res) => {
  try {
    const { escola_id, usuario_id, usuarioId } = req.user;
    const uid = usuario_id || usuarioId;

    let registrado_por = req.user?.nome || null;
    if (!registrado_por && uid) {
      try {
        const [[usuRow]] = await pool.query(
          "SELECT nome FROM usuarios WHERE id = ? LIMIT 1",
          [uid]
        );
        registrado_por = usuRow?.nome || null;
      } catch {}
    }

    const {
      aluno_id,
      turma_id,
      motivo,
      observacao,
      responsavel_cadastrado_id,
      responsavel_nome_avulso,
      responsavel_parentesco_avulso,
      responsavel_telefone_avulso,
    } = req.body;

    if (!aluno_id) {
      return res.status(400).json({ error: "Estudante é obrigatório." });
    }
    if (!motivo) {
      return res.status(400).json({ error: "Motivo é obrigatório." });
    }
    if (!responsavel_cadastrado_id && !responsavel_nome_avulso) {
      return res.status(400).json({ error: "Informe o responsável (cadastrado ou avulso)." });
    }

    const [result] = await pool.query(
      `INSERT INTO liberacoes_alunos
         (escola_id, aluno_id, turma_id, motivo, observacao,
          responsavel_cadastrado_id,
          responsavel_nome_avulso, responsavel_parentesco_avulso, responsavel_telefone_avulso,
          registrado_por, data_hora_saida, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        escola_id,
        aluno_id,
        turma_id || null,
        motivo,
        observacao || null,
        responsavel_cadastrado_id || null,
        responsavel_nome_avulso || null,
        responsavel_parentesco_avulso || null,
        responsavel_telefone_avulso || null,
        registrado_por || "Sistema",
      ]
    );

    res.status(201).json({ id: result.insertId, message: "Liberação registrada com sucesso." });
  } catch (err) {
    console.error("[Liberação] Erro ao registrar:", err);
    res.status(500).json({ error: "Erro ao registrar liberação." });
  }
});

// [DELETE] /api/liberacoes/:id - Excluir registro de saída
router.delete("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const [result] = await pool.query(
      "DELETE FROM liberacoes_alunos WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Registro não encontrado ou sem permissão." });
    }

    res.json({ message: "Liberação excluída com sucesso." });
  } catch (err) {
    console.error("[Liberação] Erro ao excluir:", err);
    res.status(500).json({ error: "Erro ao excluir liberação." });
  }
});

export default router;
