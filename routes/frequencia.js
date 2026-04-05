// routes/frequencia.js
// ============================================================================
// Módulo FREQUÊNCIA — Rotas da API
// - CRUD de justificativas de faltas (atestados)
// - CRUD de busca ativa (contatos com famílias)
// - Relatórios de alunos faltosos
// - Encaminhamentos ao Conselho Tutelar
// ============================================================================

import { Router } from "express";

const router = Router();

// ─────────────────────────────────────────────────
// JUSTIFICATIVAS (Atestados)
// ─────────────────────────────────────────────────

// GET /api/frequencia/justificativas
router.get("/justificativas", async (req, res) => {
  try {
    const { escola_id, turma_id, tipo } = req.query;
    if (!escola_id) return res.status(400).json({ error: "escola_id obrigatório" });

    let sql = `
      SELECT
        fj.*,
        a.nome AS aluno_nome,
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
router.post("/justificativas", async (req, res) => {
  try {
    const { escola_id, turma_id, aluno_id, tipo, data_inicio, data_fim, dias, observacao } = req.body;
    if (!escola_id || !aluno_id || !tipo || !data_inicio || !data_fim) {
      return res.status(400).json({ error: "Campos obrigatórios: escola_id, aluno_id, tipo, data_inicio, data_fim" });
    }

    const registrado_por = req.usuario?.id || null;

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
        a.nome AS aluno_nome,
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

    const registrado_por = req.usuario?.id || null;

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

    // Conta justificativas como proxy para faltas
    // Em uma implementação completa, integraria com o diário de classe
    let sql = `
      SELECT
        a.id AS aluno_id,
        a.nome AS aluno_nome,
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
      GROUP BY a.id, a.nome, t.nome
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

    // Dados do aluno
    const [[aluno]] = await req.db.query(
      "SELECT a.nome AS aluno_nome, t.nome AS turma_nome FROM alunos a LEFT JOIN turmas t ON a.turma_id = t.id WHERE a.id = ?",
      [aluno_id]
    );

    // Justificativas
    const [justificativas] = await req.db.query(
      "SELECT * FROM frequencia_justificativas WHERE aluno_id = ? AND escola_id = ? ORDER BY data_inicio DESC",
      [aluno_id, escola_id]
    );

    // Busca Ativa
    const [buscaAtiva] = await req.db.query(
      "SELECT * FROM frequencia_busca_ativa WHERE aluno_id = ? AND escola_id = ? ORDER BY data_contato DESC",
      [aluno_id, escola_id]
    );

    // Totais
    const totalFaltas = justificativas.length;
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
        a.nome AS aluno_nome,
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

    const registrado_por = req.usuario?.id || null;

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
