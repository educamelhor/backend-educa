// routes/pedagogico_relatorios.js
// ============================================================================
// Relatórios Pedagógicos
// - GET /api/pedagogico/relatorios/plano-avaliacao
//   Lista professores em regência (via modulação) + status do plano de avaliação
// - PUT /api/pedagogico/relatorios/plano-avaliacao/:professor_id
//   Cria ou atualiza o status (upsert)
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Middleware: garante escola no token
// ---------------------------------------------------------------------------
function verificarEscolaLocal(req, res, next) {
  if (!req.user?.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

// ---------------------------------------------------------------------------
// Util: ano letivo atual (janeiro pertence ao ano anterior)
// ---------------------------------------------------------------------------
function anoLetivoAtual() {
  const hoje = new Date();
  return hoje.getMonth() === 0 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// ---------------------------------------------------------------------------
// GET /api/pedagogico/relatorios/plano-avaliacao
// Retorna todos os professores em regência da escola com seus status de plano
// ---------------------------------------------------------------------------
router.get("/plano-avaliacao", verificarEscolaLocal, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = Number(req.query.ano) || anoLetivoAtual();

    // Busca professores em regência (com turma via modulação no ano letivo)
    // + LEFT JOIN com plano_avaliacao (pode não ter registro ainda)
    const [rows] = await pool.query(
      `SELECT
         p.id            AS professor_id,
         p.nome,
         p.foto,
         COALESCE(pa.status, 'nao_iniciado') AS status,
         pa.observacoes,
         pa.atualizado_em,
         -- Disciplinas únicas do professor (agregadas)
         GROUP_CONCAT(DISTINCT UPPER(d.nome) ORDER BY d.nome SEPARATOR ', ') AS disciplinas,
         -- Turmas únicas do professor (agregadas)
         GROUP_CONCAT(DISTINCT t.nome      ORDER BY t.nome  SEPARATOR ', ') AS turmas
       FROM professores p
       -- Vinculação via modulação (fonte de verdade para regência)
       JOIN modulacao m   ON m.professor_id = p.id
       JOIN turmas    t   ON t.id = m.turma_id
                        AND t.escola_id = ?
                        AND t.ano = ?
       LEFT JOIN disciplinas d ON d.id = m.disciplina_id
       -- Plano de avaliação (pode não existir — LEFT JOIN)
       LEFT JOIN plano_avaliacao pa
              ON pa.professor_id = p.id
             AND pa.escola_id    = ?
             AND pa.ano_letivo   = ?
       WHERE p.escola_id = ?
         AND p.status = 'ativo'
       GROUP BY p.id, p.nome, p.foto, pa.status, pa.observacoes, pa.atualizado_em
       ORDER BY p.nome ASC`,
      [escola_id, ano, escola_id, ano, escola_id]
    );

    // KPIs agregados
    const kpi = {
      total:          rows.length,
      nao_iniciado:   rows.filter((r) => r.status === "nao_iniciado").length,
      rascunho:       rows.filter((r) => r.status === "rascunho").length,
      enviado:        rows.filter((r) => r.status === "enviado").length,
      aprovado:       rows.filter((r) => r.status === "aprovado").length,
      revisao:        rows.filter((r) => r.status === "revisao").length,
    };

    return res.json({ ok: true, ano, kpi, professores: rows });
  } catch (err) {
    console.error("[pedagogico/relatorios] plano-avaliacao GET:", err);
    return res.status(500).json({ message: "Erro ao carregar relatório." });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/pedagogico/relatorios/plano-avaliacao/:professor_id
// Cria ou atualiza o status do plano de avaliação de um professor (upsert)
// Body: { status, observacoes?, ano? }
// ---------------------------------------------------------------------------
router.put("/plano-avaliacao/:professor_id", verificarEscolaLocal, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const professor_id = Number(req.params.professor_id);
    const { status, observacoes } = req.body;
    const ano = Number(req.body.ano) || anoLetivoAtual();

    const statusValidos = ["nao_iniciado", "rascunho", "enviado", "aprovado", "revisao"];
    if (!statusValidos.includes(status)) {
      return res.status(400).json({ message: `Status inválido. Use: ${statusValidos.join(", ")}` });
    }

    await pool.query(
      `INSERT INTO plano_avaliacao (escola_id, professor_id, ano_letivo, status, observacoes)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status        = VALUES(status),
         observacoes   = VALUES(observacoes),
         atualizado_em = NOW()`,
      [escola_id, professor_id, ano, status, observacoes || null]
    );

    const [[updated]] = await pool.query(
      `SELECT * FROM plano_avaliacao
        WHERE escola_id = ? AND professor_id = ? AND ano_letivo = ?`,
      [escola_id, professor_id, ano]
    );

    return res.json({ ok: true, item: updated });
  } catch (err) {
    console.error("[pedagogico/relatorios] plano-avaliacao PUT:", err);
    return res.status(500).json({ message: "Erro ao salvar status do plano." });
  }
});

export default router;
