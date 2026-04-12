// routes/frequencia.js
// ============================================================================
// Módulo FREQUÊNCIA — Rotas da API
// - CRUD completo de justificativas de faltas (atestados)
// - CRUD de busca ativa (contatos com famílias)
// - Relatórios de alunos faltosos
// - Encaminhamentos ao Conselho Tutelar
// ============================================================================

import { Router } from "express";

const router = Router();

// ─────────────────────────────────────────────────
// JUSTIFICATIVAS (Atestados) — CRUD COMPLETO
// ─────────────────────────────────────────────────

// GET /api/frequencia/justificativas
router.get("/justificativas", async (req, res) => {
  try {
    const { escola_id, turma_id, tipo } = req.query;
    if (!escola_id) return res.status(400).json({ error: "escola_id obrigatório" });

    let sql = `
      SELECT
        fj.*,
        a.estudante AS aluno_nome,
        t.nome AS turma_nome,
        u.nome AS registrado_por_nome
      FROM frequencia_justificativas fj
      LEFT JOIN alunos a ON fj.aluno_id = a.id
      LEFT JOIN turmas t ON fj.turma_id = t.id
      LEFT JOIN usuarios u ON fj.registrado_por = u.id
      WHERE fj.escola_id = ?
    `;
    const params = [escola_id];

    if (turma_id) {
      sql += " AND fj.turma_id = ?";
      params.push(turma_id);
    }
    if (tipo) {
      sql += " AND fj.tipo = ?";
      params.push(tipo);
    }

    sql += " ORDER BY fj.criado_em DESC";

    const [rows] = await req.db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao listar justificativas:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// POST /api/frequencia/justificativas
// Verifica duplicata (mesmo aluno + tipo + período) antes de inserir
router.post("/justificativas", async (req, res) => {
  try {
    const { escola_id, turma_id, aluno_id, tipo, data_inicio, data_fim, dias, observacao } = req.body;
    if (!escola_id || !aluno_id || !tipo || !data_inicio || !data_fim) {
      return res.status(400).json({ error: "Campos obrigatórios: escola_id, aluno_id, tipo, data_inicio, data_fim" });
    }

    // Verificação de duplicata
    const [duplicados] = await req.db.query(
      `SELECT id FROM frequencia_justificativas
       WHERE escola_id = ? AND aluno_id = ? AND tipo = ? AND data_inicio = ? AND data_fim = ?
       LIMIT 1`,
      [escola_id, aluno_id, tipo, data_inicio, data_fim]
    );
    if (duplicados.length > 0) {
      return res.status(409).json({
        error: "Justificativa duplicada",
        message: "Já existe um registro com os mesmos aluno, tipo e período. Use editar para atualizar.",
        id_existente: duplicados[0].id,
      });
    }

    const registrado_por = req.user?.usuario_id ?? req.user?.usuarioId ?? null;

    const [result] = await req.db.query(
      `INSERT INTO frequencia_justificativas
        (escola_id, turma_id, aluno_id, tipo, data_inicio, data_fim, dias, observacao, registrado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, turma_id || null, aluno_id, tipo, data_inicio, data_fim, dias || 1, observacao || null, registrado_por]
    );

    res.status(201).json({ id: result.insertId, message: "Justificativa registrada" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao registrar justificativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// PUT /api/frequencia/justificativas/:id
router.put("/justificativas/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { tipo, data_inicio, data_fim, dias, observacao } = req.body;
    const escola_id = req.escola_id;

    if (!tipo || !data_inicio || !data_fim) {
      return res.status(400).json({ error: "Campos obrigatórios: tipo, data_inicio, data_fim" });
    }

    // Garante que o registro pertence a esta escola
    const [[registro]] = await req.db.query(
      "SELECT id, aluno_id FROM frequencia_justificativas WHERE id = ? AND escola_id = ? LIMIT 1",
      [id, escola_id]
    );
    if (!registro) {
      return res.status(404).json({ error: "Registro não encontrado" });
    }

    // Verifica duplicata para o mesmo aluno (exceto o próprio registro)
    const [duplicados] = await req.db.query(
      `SELECT id FROM frequencia_justificativas
       WHERE escola_id = ? AND aluno_id = ? AND tipo = ? AND data_inicio = ? AND data_fim = ? AND id != ?
       LIMIT 1`,
      [escola_id, registro.aluno_id, tipo, data_inicio, data_fim, id]
    );
    if (duplicados.length > 0) {
      return res.status(409).json({
        error: "Justificativa duplicada",
        message: "Já existe outro registro com os mesmos aluno, tipo e período.",
      });
    }

    await req.db.query(
      `UPDATE frequencia_justificativas
       SET tipo = ?, data_inicio = ?, data_fim = ?, dias = ?, observacao = ?, atualizado_em = NOW()
       WHERE id = ? AND escola_id = ?`,
      [tipo, data_inicio, data_fim, dias || 1, observacao || null, id, escola_id]
    );

    res.json({ message: "Justificativa atualizada com sucesso" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao atualizar justificativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// DELETE /api/frequencia/justificativas/:id
router.delete("/justificativas/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const escola_id = req.escola_id;

    const [result] = await req.db.query(
      "DELETE FROM frequencia_justificativas WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Registro não encontrado" });
    }

    res.json({ message: "Justificativa excluída com sucesso" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao excluir justificativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// ─────────────────────────────────────────────────
// BUSCA ATIVA (Contatos com famílias)
// ─────────────────────────────────────────────────

// GET /api/frequencia/busca-ativa
router.get("/busca-ativa", async (req, res) => {
  try {
    const { escola_id, turma_id, aluno_id } = req.query;
    if (!escola_id) return res.status(400).json({ error: "escola_id obrigatório" });

    let sql = `
      SELECT
        fba.*,
        a.estudante AS aluno_nome,
        t.nome AS turma_nome,
        u.nome AS registrado_por_nome
      FROM frequencia_busca_ativa fba
      LEFT JOIN alunos a ON fba.aluno_id = a.id
      LEFT JOIN turmas t ON fba.turma_id = t.id
      LEFT JOIN usuarios u ON fba.registrado_por = u.id
      WHERE fba.escola_id = ?
    `;
    const params = [escola_id];

    if (turma_id) { sql += " AND fba.turma_id = ?"; params.push(turma_id); }
    if (aluno_id) { sql += " AND fba.aluno_id = ?"; params.push(aluno_id); }

    sql += " ORDER BY fba.criado_em DESC";

    const [rows] = await req.db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao listar busca ativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// POST /api/frequencia/busca-ativa
router.post("/busca-ativa", async (req, res) => {
  try {
    const { escola_id, turma_id, aluno_id, data_contato, meio_contato, resultado, observacao } = req.body;
    if (!escola_id || !aluno_id || !meio_contato || !resultado) {
      return res.status(400).json({ error: "Campos obrigatórios: escola_id, aluno_id, meio_contato, resultado" });
    }

    const registrado_por = req.user?.usuario_id ?? req.user?.usuarioId ?? null;

    const [result] = await req.db.query(
      `INSERT INTO frequencia_busca_ativa
        (escola_id, turma_id, aluno_id, data_contato, meio_contato, resultado, observacao, registrado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, turma_id || null, aluno_id, data_contato || new Date(), meio_contato, resultado, observacao || null, registrado_por]
    );

    res.status(201).json({ id: result.insertId, message: "Contato registrado" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao registrar busca ativa:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// ─────────────────────────────────────────────────
// RELATÓRIOS — Alunos mais faltosos
// ─────────────────────────────────────────────────

// GET /api/frequencia/relatorios/faltosos
router.get("/relatorios/faltosos", async (req, res) => {
  try {
    const { escola_id, turma_id } = req.query;
    if (!escola_id) return res.status(400).json({ error: "escola_id obrigatório" });

    let sql = `
      SELECT
        a.id AS aluno_id,
        a.estudante AS aluno_nome,
        t.nome AS turma_nome,
        COUNT(fj.id) AS total_faltas,
        SUM(fj.dias) AS total_dias_falta,
        SUM(CASE WHEN fj.tipo IS NOT NULL THEN fj.dias ELSE 0 END) AS justificadas,
        0 AS nao_justificadas,
        '—' AS percentual_frequencia
      FROM alunos a
      LEFT JOIN turmas t ON a.turma_id = t.id
      LEFT JOIN frequencia_justificativas fj ON fj.aluno_id = a.id AND fj.escola_id = a.escola_id
      WHERE a.escola_id = ? AND a.ativo = 1
    `;
    const params = [escola_id];

    if (turma_id) { sql += " AND a.turma_id = ?"; params.push(turma_id); }

    sql += `
      GROUP BY a.id, a.estudante, t.nome
      HAVING total_faltas > 0
      ORDER BY total_dias_falta DESC
      LIMIT 100
    `;

    const [rows] = await req.db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao gerar relatório faltosos:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// ─────────────────────────────────────────────────
// CONSELHO TUTELAR — Relatório individual + Encaminhamentos
// ─────────────────────────────────────────────────

// GET /api/frequencia/conselho-tutelar/relatorio
router.get("/conselho-tutelar/relatorio", async (req, res) => {
  try {
    const { escola_id, aluno_id } = req.query;
    if (!escola_id || !aluno_id) return res.status(400).json({ error: "escola_id e aluno_id obrigatórios" });

    const [[aluno]] = await req.db.query(
      "SELECT a.estudante AS aluno_nome, t.nome AS turma_nome FROM alunos a LEFT JOIN turmas t ON a.turma_id = t.id WHERE a.id = ?",
      [aluno_id]
    );

    const [justificativas] = await req.db.query(
      "SELECT * FROM frequencia_justificativas WHERE aluno_id = ? AND escola_id = ? ORDER BY data_inicio DESC",
      [aluno_id, escola_id]
    );

    const [buscaAtiva] = await req.db.query(
      "SELECT * FROM frequencia_busca_ativa WHERE aluno_id = ? AND escola_id = ? ORDER BY data_contato DESC",
      [aluno_id, escola_id]
    );

    const totalDias = justificativas.reduce((s, j) => s + (j.dias || 1), 0);

    res.json({
      aluno_nome: aluno?.aluno_nome || "",
      turma_nome: aluno?.turma_nome || "",
      total_faltas: totalDias,
      justificadas: totalDias,
      nao_justificadas: 0,
      busca_ativa_total: buscaAtiva.length,
      justificativas: justificativas.map(j => ({
        ...j,
        tipo_label: j.tipo?.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      })),
      busca_ativa: buscaAtiva,
    });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao gerar relatório CT:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// GET /api/frequencia/conselho-tutelar/encaminhamentos
router.get("/conselho-tutelar/encaminhamentos", async (req, res) => {
  try {
    const { escola_id } = req.query;
    if (!escola_id) return res.status(400).json({ error: "escola_id obrigatório" });

    const [rows] = await req.db.query(`
      SELECT
        fec.*,
        a.estudante AS aluno_nome,
        t.nome AS turma_nome,
        u.nome AS registrado_por_nome
      FROM frequencia_encaminhamentos_ct fec
      LEFT JOIN alunos a ON fec.aluno_id = a.id
      LEFT JOIN turmas t ON fec.turma_id = t.id
      LEFT JOIN usuarios u ON fec.registrado_por = u.id
      WHERE fec.escola_id = ?
      ORDER BY fec.criado_em DESC
    `, [escola_id]);

    res.json(rows);
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao listar encaminhamentos:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

// POST /api/frequencia/conselho-tutelar/encaminhamentos
router.post("/conselho-tutelar/encaminhamentos", async (req, res) => {
  try {
    const { escola_id, turma_id, aluno_id, motivo } = req.body;
    if (!escola_id || !aluno_id) return res.status(400).json({ error: "escola_id e aluno_id obrigatórios" });

    const registrado_por = req.user?.id || null;

    const [result] = await req.db.query(
      `INSERT INTO frequencia_encaminhamentos_ct
        (escola_id, turma_id, aluno_id, motivo, registrado_por)
       VALUES (?, ?, ?, ?, ?)`,
      [escola_id, turma_id || null, aluno_id, motivo || null, registrado_por]
    );

    res.status(201).json({ id: result.insertId, message: "Encaminhamento registrado" });
  } catch (err) {
    console.error("[FREQUENCIA] Erro ao registrar encaminhamento:", err.message);
    res.status(500).json({ error: "Erro interno" });
  }
});

export default router;
