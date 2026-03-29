// routes/plataforma_suporte.js
// ============================================================================
// Painel de Suporte Técnico — CEO/Plataforma
// O CEO vê TODOS os chamados de TODAS as escolas, responde e gerencia.
// ============================================================================
const express = require("express");
const router = express.Router();
const db = require("../db");

// ──────────────────────────────────────────────
// GET /api/plataforma/suporte/chamados
// Lista todos os chamados (cross-escola) com filtros
// ──────────────────────────────────────────────
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

    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM chamados c ${where}`, params);

    const [rows] = await db.query(`
      SELECT c.*,
        e.nome AS _escola_nome,
        e.apelido AS _escola_apelido
      FROM chamados c
      LEFT JOIN escolas e ON e.id = c.escola_id
      ${where}
      ORDER BY
        FIELD(c.status, 'aberto','em_andamento','respondido','fechado'),
        FIELD(c.prioridade, 'urgente','alta','media','baixa'),
        c.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset]);

    // KPI summary
    const [kpis] = await db.query(`
      SELECT
        COUNT(*) AS total_geral,
        SUM(status = 'aberto') AS abertos,
        SUM(status = 'em_andamento') AS em_andamento,
        SUM(status = 'respondido') AS respondidos,
        SUM(status = 'fechado') AS fechados,
        SUM(prioridade = 'urgente' AND status IN ('aberto','em_andamento')) AS urgentes_pendentes,
        COUNT(DISTINCT escola_id) AS escolas_com_chamados
      FROM chamados
    `);

    res.json({
      chamados: rows,
      total,
      kpis: kpis[0] || {},
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    console.error("[PlataformaSuporte] erro GET /chamados:", err.message);
    res.status(500).json({ message: "Erro ao listar chamados" });
  }
});

// ──────────────────────────────────────────────
// GET /api/plataforma/suporte/chamados/:id
// Detalhe de um chamado (acesso global CEO)
// ──────────────────────────────────────────────
router.get("/chamados/:id", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT c.*, e.nome AS _escola_nome, e.apelido AS _escola_apelido
      FROM chamados c
      LEFT JOIN escolas e ON e.id = c.escola_id
      WHERE c.id = ?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Chamado não encontrado" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[PlataformaSuporte] erro GET /chamados/:id:", err.message);
    res.status(500).json({ message: "Erro ao buscar chamado" });
  }
});

// ──────────────────────────────────────────────
// PATCH /api/plataforma/suporte/chamados/:id
// CEO responde / atualiza status
// ──────────────────────────────────────────────
router.patch("/chamados/:id", async (req, res) => {
  try {
    const { status, resposta } = req.body;
    if (!status && !resposta) return res.status(400).json({ message: "Informe status ou resposta" });

    const updates = [];
    const params = [];

    if (status) { updates.push("status = ?"); params.push(status); }
    if (resposta) {
      updates.push("resposta_ceo = ?", "respondido_em = NOW()", "respondido_por = ?");
      params.push(resposta, req.user?.nome || "CEO");
      // Se não informou status mas enviou resposta, marca como respondido
      if (!status) { updates.push("status = 'respondido'"); }
    }

    params.push(req.params.id);
    const [result] = await db.query(`UPDATE chamados SET ${updates.join(", ")} WHERE id = ?`, params);

    if (result.affectedRows === 0) return res.status(404).json({ message: "Chamado não encontrado" });
    res.json({ message: "Chamado atualizado com sucesso" });
  } catch (err) {
    console.error("[PlataformaSuporte] erro PATCH /chamados/:id:", err.message);
    res.status(500).json({ message: "Erro ao atualizar chamado" });
  }
});

module.exports = router;
