// routes/manutencao.js
// =========================================================================
// MANUTENÇÃO PROGRAMADA — CEO agenda período de indisponibilidade
// Tabela `sistema_manutencao` (1 registro ativo por vez)
// =========================================================================
import express from "express";
import pool from "../db.js";

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
// GET /api/sistema/diagnostico-telemetria — Conferência de telemetria
// ─────────────────────────────────────────────────────────────────────────────
router.get("/diagnostico-telemetria", async (req, res) => {
  const db = pool;
  try {
    const [eventos] = await db.query(`
      SELECT id, escola_id, aluno_id, usuario_id, perfil, evento, modulo, card_label, tela, plataforma, serie, turma_nome, created_at
      FROM app_telemetria_eventos
      ORDER BY id DESC
      LIMIT 20
    `);
    const [count] = await db.query(`SELECT COUNT(*) as total FROM app_telemetria_eventos`);
    return res.json({ ok: true, total: count[0]?.total || 0, eventos });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/diagnostico-jenifer", async (req, res) => {
  const db = pool;
  try {
    const [escolas] = await db.query("SELECT id, nome, apelido FROM escolas");
    const [usuarios] = await db.query(
      "SELECT id, nome, email, perfil, escola_id, cpf FROM usuarios WHERE nome LIKE '%Jeni%' OR nome LIKE '%Jenn%' OR email LIKE '%jeni%'"
    );
    const userIds = usuarios.map(u => u.id);
    let credenciais = [];
    if (userIds.length > 0) {
      try {
        [credenciais] = await db.query(
          "SELECT id, usuario_id, escola_id, educadf_login, perfil_id, ativo, created_at, updated_at FROM agente_credenciais WHERE usuario_id IN (?)",
          [userIds]
        );
      } catch {
        [credenciais] = await db.query(
          "SELECT id, professor_id as usuario_id, escola_id, educadf_login, perfil_id, ativo, created_at, updated_at FROM agente_credenciais WHERE professor_id IN (?)",
          [userIds]
        ).catch(() => [[]]);
      }
    }
    const [planos] = await db.query(`
      SELECT p.id, p.escola_id, p.usuario_id, p.turmas, p.disciplina, p.bimestre, p.ano, p.status,
             p.agente_exportado_em, p.agente_exportado_resultado, p.agente_executando_desde, p.agente_ultimo_erro,
             p.agente_notas_exportadas_em, p.agente_notas_resultado_json, p.updated_at
      FROM planos_avaliacao p
      WHERE p.disciplina LIKE '%Ci%nc%' OR p.usuario_id IN (?)
      ORDER BY p.updated_at DESC
      LIMIT 30
    `, [userIds.length ? userIds : [0]]).catch(e => [[], e.message]);

    const escolaIds = [...new Set([...usuarios.map(u => u.escola_id), ...escolas.map(e => e.id)])].filter(Boolean);
    let configs = [];
    let disciplinas = [];
    let turmas = [];
    if (escolaIds.length > 0) {
      [configs] = await db.query(
        "SELECT escola_id, chave, valor FROM configuracoes_escola WHERE escola_id IN (?) AND chave LIKE '%agente%'",
        [escolaIds]
      ).catch(() => [[]]);
      [disciplinas] = await db.query(
        "SELECT id, escola_id, nome, nome_oficial, abreviatura FROM disciplinas WHERE escola_id IN (?) AND (nome LIKE '%Ci%nc%' OR nome_oficial LIKE '%Ci%nc%')",
        [escolaIds]
      ).catch(() => [[]]);
      [turmas] = await db.query(
        "SELECT id, escola_id, nome, nome_oficial, turno, regime FROM turmas WHERE escola_id IN (?)",
        [escolaIds]
      ).catch(() => [[]]);
    }

    return res.json({
      ok: true,
      escolas,
      usuarios,
      credenciais,
      planos,
      configs,
      disciplinas,
      turmas
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
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
