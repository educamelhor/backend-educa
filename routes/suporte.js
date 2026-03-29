// routes/suporte.js
// ============================================================================
// SAC Técnico — Chamados com thread de conversação (ESCOLA → CEO)
// - Thread de mensagens (chat) dentro de cada chamado
// - Usuário pode responder (reabrir) após resposta do CEO
// - Usuário pode fechar o chamado com avaliação de satisfação
// ============================================================================
import express from "express";
import pool from "../db.js";

const router = express.Router();

// ── Auto-migrate ──
let migrated = false;
async function ensureTable() {
  if (migrated) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chamados (
        id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        escola_id      INT UNSIGNED NOT NULL,
        escola_nome    VARCHAR(200) DEFAULT NULL,
        usuario_id     INT UNSIGNED NOT NULL,
        usuario_nome   VARCHAR(200) NOT NULL,
        usuario_perfil VARCHAR(50) DEFAULT NULL,
        categoria      VARCHAR(50) NOT NULL DEFAULT 'outro',
        prioridade     VARCHAR(20) NOT NULL DEFAULT 'media',
        assunto        VARCHAR(300) NOT NULL,
        descricao      TEXT NOT NULL,
        status         VARCHAR(30) NOT NULL DEFAULT 'aberto',
        resposta_ceo   TEXT DEFAULT NULL,
        respondido_em  DATETIME DEFAULT NULL,
        respondido_por VARCHAR(200) DEFAULT NULL,
        avaliacao      TINYINT UNSIGNED DEFAULT NULL,
        feedback_usuario TEXT DEFAULT NULL,
        fechado_em     DATETIME DEFAULT NULL,
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_chamado_escola (escola_id),
        INDEX idx_chamado_status (status),
        INDEX idx_chamado_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Tabela de mensagens (thread do chamado)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chamados_mensagens (
        id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        chamado_id  INT UNSIGNED NOT NULL,
        autor_id    INT UNSIGNED DEFAULT NULL,
        autor_nome  VARCHAR(200) NOT NULL,
        autor_tipo  VARCHAR(20) NOT NULL DEFAULT 'usuario',
        mensagem    TEXT NOT NULL,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_msg_chamado (chamado_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Colunas novas no chamados (caso já exista)
    try { await pool.query(`ALTER TABLE chamados ADD COLUMN avaliacao TINYINT UNSIGNED DEFAULT NULL`); } catch {}
    try { await pool.query(`ALTER TABLE chamados ADD COLUMN feedback_usuario TEXT DEFAULT NULL`); } catch {}
    try { await pool.query(`ALTER TABLE chamados ADD COLUMN fechado_em DATETIME DEFAULT NULL`); } catch {}
    migrated = true;
    console.log("[Suporte] tabelas chamados + chamados_mensagens OK");
  } catch (err) {
    console.error("[Suporte] ERRO migrate:", err.message);
    migrated = true;
  }
}

router.use(async (req, res, next) => {
  try { await ensureTable(); } catch {}
  next();
});

// Helper: resolve userId e userName
function resolveUser(req) {
  return {
    escolaId: req.user?.escola_id,
    userId: req.user?.usuario_id || req.user?.id,
    perfil: req.user?.perfil,
  };
}

// ── GET /api/suporte/chamados ──
router.get("/chamados", async (req, res) => {
  try {
    const { escolaId, userId, perfil } = resolveUser(req);
    if (!escolaId) return res.status(400).json({ message: "escola_id ausente" });

    const { status, categoria, page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

    let where = "WHERE escola_id = ?";
    const params = [escolaId];

    if (!["diretor", "militar"].includes(perfil)) {
      where += " AND usuario_id = ?";
      params.push(userId);
    }
    if (status) { where += " AND status = ?"; params.push(status); }
    if (categoria) { where += " AND categoria = ?"; params.push(categoria); }

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM chamados ${where}`, params);
    const [rows] = await pool.query(`
      SELECT * FROM chamados ${where}
      ORDER BY FIELD(status, 'aberto','reaberto','em_andamento','respondido','fechado') ASC, updated_at DESC
      LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset]);

    res.json({ chamados: rows, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error("[Suporte] GET /chamados:", err.message);
    res.status(500).json({ message: "Erro ao listar chamados" });
  }
});

// ── POST /api/suporte/chamados — Abrir novo ──
router.post("/chamados", async (req, res) => {
  try {
    const { escolaId, userId, perfil } = resolveUser(req);
    if (!escolaId || !userId) return res.status(400).json({ message: "Dados ausentes" });

    const { categoria, prioridade, assunto, descricao } = req.body;
    if (!assunto?.trim() || !descricao?.trim()) {
      return res.status(400).json({ message: "Assunto e descrição são obrigatórios" });
    }

    let userName = "Usuário";
    let escolaNome = null;
    try { const [u] = await pool.query(`SELECT nome FROM usuarios WHERE id = ?`, [userId]); userName = u[0]?.nome || "Usuário"; } catch {}
    try { const [e] = await pool.query(`SELECT nome FROM escolas WHERE id = ?`, [escolaId]); escolaNome = e[0]?.nome || null; } catch {}

    const [result] = await pool.query(`
      INSERT INTO chamados (escola_id, escola_nome, usuario_id, usuario_nome, usuario_perfil, categoria, prioridade, assunto, descricao, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberto')
    `, [escolaId, escolaNome, userId, userName, perfil, categoria || "outro", prioridade || "media", assunto.trim(), descricao.trim()]);

    // Registrar mensagem inicial
    await pool.query(`
      INSERT INTO chamados_mensagens (chamado_id, autor_id, autor_nome, autor_tipo, mensagem)
      VALUES (?, ?, ?, 'usuario', ?)
    `, [result.insertId, userId, userName, descricao.trim()]);

    res.status(201).json({ id: result.insertId, message: "Chamado enviado para a equipe técnica" });
  } catch (err) {
    console.error("[Suporte] POST /chamados:", err.message);
    res.status(500).json({ message: "Erro ao abrir chamado: " + err.message });
  }
});

// ── GET /api/suporte/chamados/:id — Detalhe + mensagens ──
router.get("/chamados/:id", async (req, res) => {
  try {
    const { escolaId } = resolveUser(req);
    const [rows] = await pool.query(`SELECT * FROM chamados WHERE id = ? AND escola_id = ?`, [req.params.id, escolaId]);
    if (!rows.length) return res.status(404).json({ message: "Chamado não encontrado" });

    const [mensagens] = await pool.query(
      `SELECT * FROM chamados_mensagens WHERE chamado_id = ? ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ ...rows[0], mensagens });
  } catch (err) {
    console.error("[Suporte] GET /chamados/:id:", err.message);
    res.status(500).json({ message: "Erro ao buscar chamado" });
  }
});

// ── POST /api/suporte/chamados/:id/mensagem — Usuário envia mensagem ──
router.post("/chamados/:id/mensagem", async (req, res) => {
  try {
    const { escolaId, userId } = resolveUser(req);
    const { mensagem } = req.body;
    if (!mensagem?.trim()) return res.status(400).json({ message: "Mensagem vazia" });

    const [rows] = await pool.query(`SELECT * FROM chamados WHERE id = ? AND escola_id = ?`, [req.params.id, escolaId]);
    if (!rows.length) return res.status(404).json({ message: "Chamado não encontrado" });
    if (rows[0].status === "fechado") return res.status(400).json({ message: "Chamado já fechado" });

    let userName = "Usuário";
    try { const [u] = await pool.query(`SELECT nome FROM usuarios WHERE id = ?`, [userId]); userName = u[0]?.nome || "Usuário"; } catch {}

    await pool.query(`
      INSERT INTO chamados_mensagens (chamado_id, autor_id, autor_nome, autor_tipo, mensagem)
      VALUES (?, ?, ?, 'usuario', ?)
    `, [req.params.id, userId, userName, mensagem.trim()]);

    // Se estava "respondido", reabrir para equipe ver nova mensagem
    if (rows[0].status === "respondido") {
      await pool.query(`UPDATE chamados SET status = 'reaberto' WHERE id = ?`, [req.params.id]);
    }

    res.json({ message: "Mensagem enviada" });
  } catch (err) {
    console.error("[Suporte] POST mensagem:", err.message);
    res.status(500).json({ message: "Erro ao enviar mensagem" });
  }
});

// ── POST /api/suporte/chamados/:id/fechar — Usuário fecha com avaliação ──
router.post("/chamados/:id/fechar", async (req, res) => {
  try {
    const { escolaId, userId } = resolveUser(req);
    const { avaliacao, feedback } = req.body;

    const [rows] = await pool.query(`SELECT * FROM chamados WHERE id = ? AND escola_id = ?`, [req.params.id, escolaId]);
    if (!rows.length) return res.status(404).json({ message: "Chamado não encontrado" });

    await pool.query(`
      UPDATE chamados SET status = 'fechado', avaliacao = ?, feedback_usuario = ?, fechado_em = NOW() WHERE id = ?
    `, [avaliacao || null, feedback?.trim() || null, req.params.id]);

    let userName = "Usuário";
    try { const [u] = await pool.query(`SELECT nome FROM usuarios WHERE id = ?`, [userId]); userName = u[0]?.nome || "Usuário"; } catch {}

    // Mensagem de encerramento na thread
    const stars = avaliacao ? "⭐".repeat(avaliacao) : "";
    await pool.query(`
      INSERT INTO chamados_mensagens (chamado_id, autor_id, autor_nome, autor_tipo, mensagem)
      VALUES (?, ?, ?, 'sistema', ?)
    `, [req.params.id, userId, userName, `✅ Chamado encerrado pelo usuário. ${stars}${feedback ? `\n${feedback}` : ""}`]);

    res.json({ message: "Chamado fechado com sucesso" });
  } catch (err) {
    console.error("[Suporte] POST fechar:", err.message);
    res.status(500).json({ message: "Erro ao fechar chamado" });
  }
});

export default router;
