import express from "express";

const router = express.Router();

router.get("/", async (req, res) => {
  const escola_id = req.user?.escola_id || 1;
  try {
    const [rows] = await req.db.query(
      `SELECT id, motivo, ativo 
       FROM tipos_ocorrencia 
       WHERE escola_id = ? 
       ORDER BY ativo DESC, motivo ASC`,
      [escola_id]
    );

    // Se estiver vazio e for a primeira vez, podemos popular com default
    if (rows.length === 0) {
        const defaults = [
            "Sair da sala sem autorização do professor",
            "Chegar atrasado após o intervalo",
            "Atrapalhando aula com conversa",
            "Desrespeito aos colegas/professores",
            "Uso de celular indevido em sala",
            "Outros"
        ];
        for (const m of defaults) {
            await req.db.query(
                `INSERT INTO tipos_ocorrencia (escola_id, motivo, ativo) VALUES (?, ?, 1)`,
                [escola_id, m]
            );
        }
        const [newRows] = await req.db.query(
          `SELECT id, motivo, ativo FROM tipos_ocorrencia WHERE escola_id = ? ORDER BY ativo DESC, motivo ASC`,
          [escola_id]
        );
        return res.json(newRows);
    }

    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar tipos de ocorrencia:", err);
    res.status(500).json({ error: "Erro interno." });
  }
});

router.post("/", async (req, res) => {
  const escola_id = req.user?.escola_id || 1;
  const { motivo, ativo = true } = req.body;
  
  if (!motivo) return res.status(400).json({ error: "Motivo obrigatório" });

  try {
    const [result] = await req.db.query(
      `INSERT INTO tipos_ocorrencia (escola_id, motivo, ativo) VALUES (?, ?, ?)`,
      [escola_id, motivo.trim(), ativo]
    );
    res.status(201).json({ id: result.insertId, motivo, ativo });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: "Ajuste já cadastrado para esta escola." });
    }
    console.error("Erro ao criar tipo de ocorrecia:", err);
    res.status(500).json({ error: "Erro interno." });
  }
});

router.put("/:id", async (req, res) => {
  const escola_id = req.user?.escola_id || 1;
  const { id } = req.params;
  const { motivo, ativo } = req.body;

  try {
    const fields = [];
    const values = [];
    if (motivo !== undefined) {
        fields.push("motivo = ?");
        values.push(motivo.trim());
    }
    if (ativo !== undefined) {
        fields.push("ativo = ?");
        values.push(ativo);
    }
    
    if (fields.length === 0) return res.status(400).json({ error: "Sem dados para atualizar." });

    values.push(id, escola_id);

    const [result] = await req.db.query(
      `UPDATE tipos_ocorrencia SET ${fields.join(", ")} WHERE id = ? AND escola_id = ?`,
      values
    );
    
    if (result.affectedRows === 0) return res.status(404).json({ error: "Registro não encontrado." });

    res.json({ success: true });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: "Ajuste com esse nome já cadastrado para esta escola." });
    }
    console.error("Erro ao atualizar tipo de ocorrecia:", err);
    res.status(500).json({ error: "Erro interno." });
  }
});

router.delete("/:id", async (req, res) => {
  const escola_id = req.user?.escola_id || 1;
  const { id } = req.params;

  try {
    // Soft delete ou delete físico? Melhor delete físico, pois a descrição já fica salva na occorencia_disciplinares string motivo
    const [result] = await req.db.query(
      `DELETE FROM tipos_ocorrencia WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Não encontrado." });
    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao excluir tipo de ocorrecia:", err);
    res.status(500).json({ error: "Erro ao excluir. O registro pode estar em uso." });
  }
});

export default router;
