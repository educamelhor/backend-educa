import express from "express";
import pool from "../db.js";

const router = express.Router();

// ============================================================================
// GET /api/registros-ocorrencias
// Lista todos os registros de ocorrências (tabela GLOBAL do regimento)
// Sem filtro por escola_id — dados universais para escolas cívico-militares
// ============================================================================
router.get("/", async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT id, medida_disciplinar, tipo_ocorrencia, descricao_ocorrencia, pontos, ativo 
       FROM registros_ocorrencias 
       ORDER BY ativo DESC, medida_disciplinar ASC, tipo_ocorrencia ASC, descricao_ocorrencia ASC`
    );

    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar registros de ocorrências:", err);
    res.status(500).json({ error: "Erro interno." });
  }
});

// ============================================================================
// GET /api/registros-ocorrencias/historico
// Histórico completo de ocorrências disciplinares da escola
// Filtros: status, turma, turno, aluno_nome, data_inicio, data_fim, tipo_ocorrencia
// ============================================================================
router.get("/historico", async (req, res) => {
  try {
    const escola_id = req.escola_id ?? req.user?.escola_id;
    if (!escola_id) return res.status(400).json({ error: "Escola não identificada." });
    const {
      status,
      turma_id,
      turno,
      aluno_nome,
      data_inicio,
      data_fim,
      tipo_ocorrencia,
      convocar_responsavel,
      page = 1,
      limit = 50,
    } = req.query;

    let where = "WHERE o.escola_id = ?";
    const params = [escola_id];

    if (status) {
      where += " AND o.status = ?";
      params.push(status);
    }
    if (turma_id) {
      where += " AND a.turma_id = ?";
      params.push(turma_id);
    }
    if (turno) {
      where += " AND t.turno = ?";
      params.push(turno);
    }
    if (aluno_nome) {
      where += " AND a.estudante LIKE ?";
      params.push(`%${aluno_nome}%`);
    }
    if (data_inicio) {
      where += " AND o.data_ocorrencia >= ?";
      params.push(data_inicio);
    }
    if (data_fim) {
      where += " AND o.data_ocorrencia <= ?";
      params.push(data_fim);
    }
    if (tipo_ocorrencia) {
      where += " AND o.tipo_ocorrencia = ?";
      params.push(tipo_ocorrencia);
    }
    if (convocar_responsavel === "1") {
      where += " AND o.convocar_responsavel = 1";
    }

    // Contagem total para paginação
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM ocorrencias_disciplinares o
       JOIN alunos a ON a.id = o.aluno_id AND a.escola_id = o.escola_id
       LEFT JOIN turmas t ON t.id = a.turma_id
       ${where}`,
      params
    );
    const total = countRows[0]?.total || 0;

    // Dados paginados
    const offset = (Number(page) - 1) * Number(limit);
    const [rows] = await pool.query(
      `SELECT
         o.id,
         o.aluno_id,
         o.data_ocorrencia,
         o.motivo,
         o.tipo_ocorrencia,
         o.descricao,
         o.convocar_responsavel,
         o.data_comparecimento_responsavel,
         o.status,
         o.criado_em,
         o.dias_suspensao,
         ANY_VALUE(a.estudante)                             AS aluno_nome,
         ANY_VALUE(a.codigo)                               AS aluno_codigo,
         ANY_VALUE(t.nome)                                 AS turma_nome,
         ANY_VALUE(t.turno)                                AS turma_turno,
         ANY_VALUE(COALESCE(r.medida_disciplinar, o.tipo_ocorrencia)) AS medida_disciplinar,
         ANY_VALUE(COALESCE(r.pontos, 0))                  AS pontos,
         ANY_VALUE(resp.nome)                              AS responsavel_nome,
         ANY_VALUE(resp.telefone_celular)                  AS responsavel_telefone,
         ANY_VALUE(u.nome)                                 AS registrado_por
       FROM ocorrencias_disciplinares o
       JOIN alunos a ON a.id = o.aluno_id AND a.escola_id = o.escola_id
       LEFT JOIN turmas t ON t.id = a.turma_id
       LEFT JOIN registros_ocorrencias r
         ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
       LEFT JOIN responsaveis_alunos ra ON ra.aluno_id = o.aluno_id AND ra.escola_id = o.escola_id AND ra.ativo = 1
       LEFT JOIN responsaveis resp ON resp.id = ra.responsavel_id
       LEFT JOIN usuarios u ON u.id = o.usuario_finalizacao_id
       ${where}
       GROUP BY o.id, o.aluno_id, o.data_ocorrencia, o.motivo, o.tipo_ocorrencia,
                o.descricao, o.convocar_responsavel, o.data_comparecimento_responsavel,
                o.status, o.criado_em, o.dias_suspensao
       ORDER BY o.criado_em DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    // KPIs (totais por status)
    const [kpis] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN o.status = 'REGISTRADA' THEN 1 ELSE 0 END) AS registradas,
         SUM(CASE WHEN o.status = 'FINALIZADA' THEN 1 ELSE 0 END) AS finalizadas,
         SUM(CASE WHEN o.status = 'CANCELADA' THEN 1 ELSE 0 END) AS canceladas,
         SUM(CASE WHEN o.convocar_responsavel = 1 AND o.data_comparecimento_responsavel IS NULL AND o.status != 'CANCELADA' THEN 1 ELSE 0 END) AS aguardando_responsavel
       FROM ocorrencias_disciplinares o
       JOIN alunos a ON a.id = o.aluno_id AND a.escola_id = o.escola_id
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE o.escola_id = ?`,
      [escola_id]
    );

    res.json({
      registros: rows,
      kpis: kpis[0] || {},
      paginacao: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error("Erro ao listar histórico disciplinar:", err);
    res.status(500).json({ error: "Erro interno." });
  }
});

// ============================================================================
// POST /api/registros-ocorrencias
// DESABILITADO no EDUCA.MELHOR_escola
// Será reabilitado futuramente no EDUCA.MELHOR_ceo
// ============================================================================
// router.post("/", async (req, res) => {
//   const { 
//     medida_disciplinar, 
//     tipo_ocorrencia, 
//     descricao_ocorrencia, 
//     pontos = 0, 
//     ativo = true 
//   } = req.body;
//   
//   if (!medida_disciplinar || !tipo_ocorrencia || !descricao_ocorrencia) {
//     return res.status(400).json({ error: "Medida Disciplinar, Tipo de Ocorrência e Descrição são obrigatórios." });
//   }
// 
//   try {
//     const [result] = await req.db.query(
//       `INSERT INTO registros_ocorrencias (medida_disciplinar, tipo_ocorrencia, descricao_ocorrencia, pontos, ativo) 
//        VALUES (?, ?, ?, ?, ?)`,
//       [medida_disciplinar.trim(), tipo_ocorrencia.trim(), descricao_ocorrencia.trim(), pontos, ativo]
//     );
//     res.status(201).json({ 
//       id: result.insertId, 
//       medida_disciplinar, 
//       tipo_ocorrencia, 
//       descricao_ocorrencia, 
//       pontos, 
//       ativo 
//     });
//   } catch (err) {
//     if (err.code === "ER_DUP_ENTRY") {
//         return res.status(400).json({ error: "Essa descrição de ocorrência já está cadastrada." });
//     }
//     console.error("Erro ao criar registro de ocorrência:", err);
//     res.status(500).json({ error: "Erro interno." });
//   }
// });

// ============================================================================
// PUT /api/registros-ocorrencias/:id
// DESABILITADO no EDUCA.MELHOR_escola
// Será reabilitado futuramente no EDUCA.MELHOR_ceo
// ============================================================================
// router.put("/:id", async (req, res) => {
//   const { id } = req.params;
//   const { medida_disciplinar, tipo_ocorrencia, descricao_ocorrencia, pontos, ativo } = req.body;
// 
//   try {
//     const fields = [];
//     const values = [];
// 
//     if (medida_disciplinar !== undefined) {
//         fields.push("medida_disciplinar = ?");
//         values.push(medida_disciplinar.trim());
//     }
//     if (tipo_ocorrencia !== undefined) {
//         fields.push("tipo_ocorrencia = ?");
//         values.push(tipo_ocorrencia.trim());
//     }
//     if (descricao_ocorrencia !== undefined) {
//         fields.push("descricao_ocorrencia = ?");
//         values.push(descricao_ocorrencia.trim());
//     }
//     if (pontos !== undefined) {
//         fields.push("pontos = ?");
//         values.push(pontos);
//     }
//     if (ativo !== undefined) {
//         fields.push("ativo = ?");
//         values.push(ativo);
//     }
//     
//     if (fields.length === 0) return res.status(400).json({ error: "Sem dados para atualizar." });
// 
//     values.push(id);
// 
//     const [result] = await req.db.query(
//       `UPDATE registros_ocorrencias SET ${fields.join(", ")} WHERE id = ?`,
//       values
//     );
//     
//     if (result.affectedRows === 0) return res.status(404).json({ error: "Registro não encontrado." });
// 
//     res.json({ success: true });
//   } catch (err) {
//     if (err.code === "ER_DUP_ENTRY") {
//         return res.status(400).json({ error: "Essa descrição de ocorrência já está cadastrada." });
//     }
//     console.error("Erro ao atualizar registro de ocorrência:", err);
//     res.status(500).json({ error: "Erro interno." });
//   }
// });

// ============================================================================
// DELETE /api/registros-ocorrencias/:id
// DESABILITADO no EDUCA.MELHOR_escola
// Será reabilitado futuramente no EDUCA.MELHOR_ceo
// ============================================================================
// router.delete("/:id", async (req, res) => {
//   const { id } = req.params;
// 
//   try {
//     const [result] = await req.db.query(
//       `DELETE FROM registros_ocorrencias WHERE id = ?`,
//       [id]
//     );
//     if (result.affectedRows === 0) return res.status(404).json({ error: "Não encontrado." });
//     res.json({ success: true });
//   } catch (err) {
//     console.error("Erro ao excluir registro de ocorrência:", err);
//     res.status(500).json({ error: "Erro ao excluir. O registro pode estar em uso." });
//   }
// });

export default router;
