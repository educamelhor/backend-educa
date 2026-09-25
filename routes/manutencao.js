// routes/manutencao.js
// =========================================================================
// MANUTENÇÃO PROGRAMADA — CEO agenda período de indisponibilidade
// Tabela `sistema_manutencao` (1 registro ativo por vez)
// =========================================================================
import express from "express";
import pool from "../db.js";

const router = express.Router();

router.get("/diagnostico-bruce", async (req, res) => {
  try {
    const escolaId = 1;
    const cleanCpf = "99344939187";

    // 1) Test subquery for max_ano
    const [[maxRow]] = await pool.query(
      `SELECT MAX(t.ano) AS max_ano
       FROM turmas t
       JOIN modulacao m ON m.turma_id = t.id
       JOIN professores p ON p.id = m.professor_id
       WHERE p.escola_id = ?
         AND REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?`,
      [Number(escolaId), cleanCpf]
    );

    // 2) Exact query from /me/disciplinas
    const [disciplinasResult] = await pool.query(
      `SELECT DISTINCT d.id AS id, d.nome AS nome
       FROM professores p
       JOIN modulacao m   ON m.professor_id = p.id
       JOIN turmas t      ON t.id = m.turma_id
       JOIN disciplinas d ON d.id = m.disciplina_id
       WHERE p.escola_id = ?
         AND REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?
         AND t.escola_id = ?
         AND t.ano = (
           SELECT MAX(t2.ano)
           FROM turmas t2
           JOIN modulacao m2 ON m2.turma_id = t2.id
           JOIN professores p2 ON p2.id = m2.professor_id
           WHERE p2.escola_id = ?
             AND REPLACE(REPLACE(p2.cpf, '.', ''), '-', '') = ?
         )
       ORDER BY nome ASC`,
      [escolaId, cleanCpf, escolaId, escolaId, cleanCpf]
    );

    // 3) Exact query from /me/turmas
    const anoLetivo = maxRow?.max_ano || new Date().getFullYear();
    const [turmasResult] = await pool.query(
      `SELECT DISTINCT
        t.id,
        t.nome,
        t.ano,
        t.serie,
        t.turno,
        t.etapa
      FROM turmas t
      WHERE t.escola_id = ?
        AND t.ano = ?
        AND t.id IN (
          SELECT m.turma_id
          FROM modulacao m
          JOIN professores p ON p.id = m.professor_id
          WHERE p.escola_id = ?
            AND REPLACE(REPLACE(p.cpf, '.', ''), '-', '') = ?
        )
      ORDER BY t.ano DESC, t.etapa ASC, t.serie ASC, t.nome ASC`,
      [Number(escolaId), anoLetivo, Number(escolaId), cleanCpf]
    );

    // 4) Turmas details
    const [turmasBruce] = await pool.query(
      "SELECT id, nome, ano, turno, escola_id, etapa, serie FROM turmas WHERE id IN (220, 221, 222, 223, 224, 225)"
    );

    // 5) Existing plans for Ciências in escola 1
    const [planosCiencias] = await pool.query(
      "SELECT id, escola_id, ano, bimestre, disciplina, turmas, status, usuario_id, professor_nome FROM planos_avaliacao WHERE escola_id = 1 AND disciplina LIKE '%Ciências%'"
    );

    // 6) Check user 100160 full row
    const [[userRow]] = await pool.query(
      "SELECT id, nome, cpf, escola_id, perfil, ativo, (senha_hash IS NOT NULL AND senha_hash != '') as tem_senha FROM usuarios WHERE id = 100160"
    );

    return res.json({
      ok: true,
      maxRow,
      anoLetivo,
      disciplinasResult,
      turmasResult,
      turmasBruce,
      planosCiencias,
      userRow
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
});


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
      return res.json({
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
router.get("/", async (req, res) => {
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
router.post("/", async (req, res) => {
  const db = req.db;
  const { inicio, fim, mensagem } = req.body || {};

  if (!inicio || !fim) {
    return res.status(400).json({ ok: false, message: "Informe 'inicio' e 'fim'." });
  }

  // Normaliza timezone: se não tem indicador (Z ou ±HH:MM), assume Brasília (UTC-3)
  function parseBrasilia(dateStr) {
    const s = String(dateStr).trim();
    if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return new Date(s);
    return new Date(s + '-03:00'); // Assume Brasília
  }

  const dtInicio = parseBrasilia(inicio);
  const dtFim = parseBrasilia(fim);

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
router.delete("/", async (req, res) => {
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
