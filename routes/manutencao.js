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
    const [planosJenifer] = await db.query(`
      SELECT p.id, p.escola_id, p.usuario_id, p.turmas, p.disciplina, p.bimestre, p.ano, p.status,
             p.agente_exportado_em, p.agente_exportado_resultado, p.agente_executando_desde, p.agente_ultimo_erro,
             p.agente_notas_exportadas_em, p.agente_notas_resultado_json, p.updated_at
      FROM planos_avaliacao p
      WHERE p.usuario_id = 100234
      ORDER BY p.updated_at DESC
    `).catch(e => [[], e.message]);

    const [planosComErroEscola1] = await db.query(`
      SELECT p.id, p.usuario_id, u.nome as professor_nome, p.turmas, p.disciplina, p.bimestre, p.status,
             p.agente_ultimo_erro, p.agente_executando_desde, p.agente_exportado_em, p.updated_at
      FROM planos_avaliacao p
      LEFT JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.escola_id = 1 AND p.agente_ultimo_erro IS NOT NULL
      ORDER BY p.updated_at DESC
      LIMIT 15
    `).catch(e => [[], e.message]);

    const [turmasCef04] = await db.query(
      "SELECT id, nome, nome_oficial, turno, regime FROM turmas WHERE escola_id = 1 ORDER BY nome ASC"
    ).catch(e => [[], e.message]);

    const [disciplinasCef04] = await db.query(
      "SELECT id, nome, nome_oficial, abreviatura FROM disciplinas WHERE escola_id = 1 ORDER BY nome ASC"
    ).catch(e => [[], e.message]);

    const [modulacaoCef04Ciencias] = await db.query(`
      SELECT m.id, m.turma_id, t.nome as turma_nome, m.disciplina_id, d.nome as disc_nome, 
             p.id as prof_id, p.nome as prof_nome, p.cpf as prof_cpf
      FROM modulacao m
      JOIN turmas t ON t.id = m.turma_id
      JOIN disciplinas d ON d.id = m.disciplina_id
      JOIN professores p ON p.id = m.professor_id
      WHERE t.escola_id = 1 AND (d.nome LIKE '%Ci%nc%' OR p.nome LIKE '%Jeni%' OR p.cpf LIKE '%98459414191%')
    `).catch(e => [[], e.message]);

    const [planos6AnoA] = await db.query(`
      SELECT p.id, p.usuario_id, u.nome as criador_nome, p.turmas, p.disciplina, p.bimestre, p.ano, p.status,
             p.agente_ultimo_erro, p.agente_exportado_em, p.updated_at
      FROM planos_avaliacao p
      LEFT JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.escola_id = 1 AND p.turmas LIKE '%6%A%'
    `).catch(e => [[], e.message]);

    const [profJenifer] = await db.query(
      "SELECT * FROM professores WHERE escola_id = 1 AND (nome LIKE '%Jeni%' OR cpf LIKE '%98459414191%')"
    ).catch(e => [[], e.message]);

    return res.json({
      ok: true,
      usuarioJenifer: usuarios.find(u => u.id === 100234),
      credenciaisJenifer: credenciais,
      profJenifer,
      modulacaoCef04Ciencias,
      planos6AnoA,
      planosComErroEscola1
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
