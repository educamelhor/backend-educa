// routes/manutencao.js
// =========================================================================
// MANUTENÇÃO PROGRAMADA — CEO agenda período de indisponibilidade
// Tabela `sistema_manutencao` (1 registro ativo por vez)
// =========================================================================
import express from "express";

const router = express.Router();

// ── Helper: garante que a tabela existe ──
async function ensureTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sistema_manutencao (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      ativo         TINYINT(1)  NOT NULL DEFAULT 0,
      inicio        DATETIME    NOT NULL,
      fim           DATETIME    NOT NULL,
      mensagem      VARCHAR(500) DEFAULT 'O sistema está em manutenção programada.',
      criado_por    INT          DEFAULT NULL,
      criado_em     DATETIME     DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/status — PÚBLICO (sem auth) — frontend checa antes do login
// ─────────────────────────────────────────────────────────────────────────────
router.get("/status", async (req, res) => {
  const db = req.db;
  try {
    await ensureTable(db);
    const [[row]] = await db.query(
      `SELECT ativo, inicio, fim, mensagem
       FROM sistema_manutencao
       WHERE ativo = 1 AND inicio <= NOW() AND fim > NOW()
       LIMIT 1`
    );
    if (row) {
      return res.status(503).json({
        maintenance: true,
        inicio: row.inicio,
        fim: row.fim,
        mensagem: row.mensagem,
      });
    }
    return res.json({ maintenance: false });
  } catch (err) {
    console.error("[MANUTENCAO/status] erro:", err.message);
    return res.json({ maintenance: false }); // fallback seguro
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/plataforma/manutencao — CEO consulta status
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manutencao", async (req, res) => {
  const db = req.db;
  try {
    await ensureTable(db);
    const [[row]] = await db.query(
      `SELECT id, ativo, inicio, fim, mensagem, criado_em
       FROM sistema_manutencao
       WHERE ativo = 1
       ORDER BY criado_em DESC LIMIT 1`
    );
    if (!row) {
      return res.json({ ok: true, manutencao: null });
    }
    // Verifica se está ativo AGORA ou é agendamento futuro
    const agora = new Date();
    const inicio = new Date(row.inicio);
    const fim = new Date(row.fim);
    const emAndamento = inicio <= agora && fim > agora;
    const expirado = fim <= agora;

    // Se expirou, desativa automaticamente
    if (expirado) {
      await db.query(`UPDATE sistema_manutencao SET ativo = 0 WHERE id = ?`, [row.id]);
      return res.json({ ok: true, manutencao: null });
    }

    return res.json({
      ok: true,
      manutencao: {
        id: row.id,
        ativo: true,
        em_andamento: emAndamento,
        agendado: !emAndamento,
        inicio: row.inicio,
        fim: row.fim,
        mensagem: row.mensagem,
        criado_em: row.criado_em,
      },
    });
  } catch (err) {
    console.error("[MANUTENCAO/get] erro:", err.message);
    return res.status(500).json({ ok: false, message: "Erro no servidor." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/plataforma/manutencao — CEO ativa/agenda manutenção
// ─────────────────────────────────────────────────────────────────────────────
router.post("/manutencao", async (req, res) => {
  const db = req.db;
  const { inicio, fim, mensagem } = req.body || {};

  if (!inicio || !fim) {
    return res.status(400).json({ ok: false, message: "Informe 'inicio' e 'fim'." });
  }

  const dtInicio = new Date(inicio);
  const dtFim = new Date(fim);

  if (isNaN(dtInicio.getTime()) || isNaN(dtFim.getTime())) {
    return res.status(400).json({ ok: false, message: "Datas inválidas." });
  }
  if (dtFim <= dtInicio) {
    return res.status(400).json({ ok: false, message: "'fim' deve ser posterior a 'inicio'." });
  }

  try {
    await ensureTable(db);

    // Desativa qualquer manutenção anterior
    await db.query(`UPDATE sistema_manutencao SET ativo = 0 WHERE ativo = 1`);

    // Insere nova
    const msg = mensagem || "O sistema está em manutenção programada.";
    const criado_por = req.user?.usuarioId || null;

    await db.query(
      `INSERT INTO sistema_manutencao (ativo, inicio, fim, mensagem, criado_por)
       VALUES (1, ?, ?, ?, ?)`,
      [dtInicio, dtFim, msg, criado_por]
    );

    const emAndamento = dtInicio <= new Date();
    console.log(`[MANUTENCAO] ${emAndamento ? "ATIVADA" : "AGENDADA"} por usuario ${criado_por}: ${inicio} → ${fim}`);

    return res.json({
      ok: true,
      message: emAndamento
        ? "Manutenção ativada com sucesso."
        : `Manutenção agendada para ${inicio}.`,
      em_andamento: emAndamento,
    });
  } catch (err) {
    console.error("[MANUTENCAO/post] erro:", err.message);
    return res.status(500).json({ ok: false, message: "Erro no servidor." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/plataforma/manutencao — CEO cancela manutenção
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/manutencao", async (req, res) => {
  const db = req.db;
  try {
    await ensureTable(db);
    const [result] = await db.query(`UPDATE sistema_manutencao SET ativo = 0 WHERE ativo = 1`);
    console.log(`[MANUTENCAO] CANCELADA por usuario ${req.user?.usuarioId} (${result.affectedRows} registros)`);
    return res.json({ ok: true, message: "Manutenção cancelada." });
  } catch (err) {
    console.error("[MANUTENCAO/delete] erro:", err.message);
    return res.status(500).json({ ok: false, message: "Erro no servidor." });
  }
});

export default router;
