// routes/plataforma_suporte.js
// ============================================================================
// Painel de Suporte Técnico — CEO/Plataforma
// Vê todos chamados, responde via thread de mensagens, gerencia status
// ============================================================================
import express from "express";
import pool from "../db.js";

const router = express.Router();

// ── GET /api/plataforma/suporte/chamados ──
router.get("/chamados", async (req, res) => {
  try {
    const { status, categoria, escola_id, prioridade, page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

    let where = "WHERE 1=1";
    const params = [];

    if (status) { where += " AND c.status = ?"; params.push(status); }
    if (categoria) { where += " AND c.categoria = ?"; params.push(categoria); }
    if (escola_id) { where += " AND c.escola_id = ?"; params.push(escola_id); }
    if (prioridade) { where += " AND c.prioridade = ?"; params.push(prioridade); }

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM chamados c ${where}`, params);

    const [rows] = await pool.query(`
      SELECT c.*, e.nome AS _escola_nome, e.apelido AS _escola_apelido,
        (SELECT COUNT(*) FROM chamados_mensagens WHERE chamado_id = c.id) AS total_mensagens
      FROM chamados c
      LEFT JOIN escolas e ON e.id = c.escola_id
      ${where}
      ORDER BY
        FIELD(c.status, 'aberto','reaberto','em_andamento','respondido','fechado'),
        FIELD(c.prioridade, 'urgente','alta','media','baixa'),
        c.updated_at DESC
      LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset]);

    const [kpis] = await pool.query(`
      SELECT
        COUNT(*) AS total_geral,
        SUM(status = 'aberto') AS abertos,
        SUM(status = 'reaberto') AS reabertos,
        SUM(status = 'em_andamento') AS em_andamento,
        SUM(status = 'respondido') AS respondidos,
        SUM(status = 'fechado') AS fechados,
        SUM(prioridade = 'urgente' AND status IN ('aberto','reaberto','em_andamento')) AS urgentes_pendentes,
        ROUND(AVG(CASE WHEN avaliacao IS NOT NULL THEN avaliacao END), 1) AS media_avaliacao,
        COUNT(DISTINCT escola_id) AS escolas_com_chamados
      FROM chamados
    `);

    res.json({ chamados: rows, total, kpis: kpis[0] || {}, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error("[PlataformaSuporte] GET /chamados:", err.message);
    res.status(500).json({ message: "Erro ao listar chamados" });
  }
});

// ── GET /api/plataforma/suporte/chamados/:id — Detalhe + thread ──
router.get("/chamados/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.*, e.nome AS _escola_nome, e.apelido AS _escola_apelido
      FROM chamados c LEFT JOIN escolas e ON e.id = c.escola_id WHERE c.id = ?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Chamado não encontrado" });

    const [mensagens] = await pool.query(
      `SELECT * FROM chamados_mensagens WHERE chamado_id = ? ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ ...rows[0], mensagens });
  } catch (err) {
    console.error("[PlataformaSuporte] GET /chamados/:id:", err.message);
    res.status(500).json({ message: "Erro ao buscar chamado" });
  }
});

// ── POST /api/plataforma/suporte/chamados/:id/mensagem — CEO responde ──
router.post("/chamados/:id/mensagem", async (req, res) => {
  try {
    const { mensagem, status } = req.body;
    if (!mensagem?.trim() && !status) return res.status(400).json({ message: "Mensagem ou status obrigatório" });

    const ceoNome = req.user?.nome || "Equipe Técnica";

    if (mensagem?.trim()) {
      await pool.query(`
        INSERT INTO chamados_mensagens (chamado_id, autor_id, autor_nome, autor_tipo, mensagem)
        VALUES (?, ?, ?, 'ceo', ?)
      `, [req.params.id, req.user?.usuario_id || 0, ceoNome, mensagem.trim()]);

      // Também salvar a última resposta no campo legado
      await pool.query(`
        UPDATE chamados SET resposta_ceo = ?, respondido_em = NOW(), respondido_por = ? WHERE id = ?
      `, [mensagem.trim(), ceoNome, req.params.id]);
    }

    // Atualizar status
    const newStatus = status || (mensagem?.trim() ? "respondido" : null);
    if (newStatus) {
      await pool.query(`UPDATE chamados SET status = ? WHERE id = ?`, [newStatus, req.params.id]);
    }

    res.json({ message: "Resposta enviada" });
  } catch (err) {
    console.error("[PlataformaSuporte] POST mensagem:", err.message);
    res.status(500).json({ message: "Erro ao enviar resposta" });
  }
});

// ── PATCH /api/plataforma/suporte/chamados/:id — Update status (legacy) ──
router.patch("/chamados/:id", async (req, res) => {
  try {
    const { status, resposta } = req.body;
    if (!status && !resposta) return res.status(400).json({ message: "Informe status ou resposta" });

    const ceoNome = req.user?.nome || "CEO";
    const updates = [];
    const params = [];

    if (status) { updates.push("status = ?"); params.push(status); }
    if (resposta) {
      updates.push("resposta_ceo = ?", "respondido_em = NOW()", "respondido_por = ?");
      params.push(resposta, ceoNome);
      if (!status) updates.push("status = 'respondido'");

      // Também inserir na thread
      await pool.query(`
        INSERT INTO chamados_mensagens (chamado_id, autor_id, autor_nome, autor_tipo, mensagem)
        VALUES (?, ?, ?, 'ceo', ?)
      `, [req.params.id, req.user?.usuario_id || 0, ceoNome, resposta]);
    }

    params.push(req.params.id);
    await pool.query(`UPDATE chamados SET ${updates.join(", ")} WHERE id = ?`, params);
    res.json({ message: "Chamado atualizado" });
  } catch (err) {
    console.error("[PlataformaSuporte] PATCH:", err.message);
    res.status(500).json({ message: "Erro ao atualizar" });
  }
});

export default router;
