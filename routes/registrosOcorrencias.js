import express from "express";

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
