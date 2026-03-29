// routes/suporte.js
// ============================================================================
// API de Chamados (SAC) — abertura, listagem, atualização e resposta
// Multi-escola (cada chamado pertence a uma escola)
// ============================================================================
const express = require("express");
const router = express.Router();
const db = require("../db");

// ── Auto-migrate: cria tabela se não existir ──
let migrated = false;
async function ensureTable() {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS chamados (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        escola_id     INT UNSIGNED NOT NULL,
        usuario_id    INT UNSIGNED NOT NULL,
        usuario_nome  VARCHAR(200) NOT NULL,
        usuario_perfil VARCHAR(50) DEFAULT NULL,
        categoria     ENUM('orientacao','problema','sugestao','duvida','outro') NOT NULL DEFAULT 'outro',
        prioridade    ENUM('baixa','media','alta','urgente') NOT NULL DEFAULT 'media',
        assunto       VARCHAR(300) NOT NULL,
        descricao     TEXT NOT NULL,
        status        ENUM('aberto','em_andamento','respondido','fechado') NOT NULL DEFAULT 'aberto',
        resposta_admin TEXT DEFAULT NULL,
        respondido_em  DATETIME DEFAULT NULL,
        respondido_por VARCHAR(200) DEFAULT NULL,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_chamado_escola (escola_id, status),
        INDEX idx_chamado_usuario (usuario_id),
        INDEX idx_chamado_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    migrated = true;
    console.log("[Suporte] tabela chamados OK");
  } catch (err) {
    console.error("[Suporte] erro ao criar tabela:", err.message);
  }
}

// ── Middleware: garantir tabela ──
router.use(async (req, res, next) => {
  await ensureTable();
  next();
});

// ──────────────────────────────────────────────
// GET /api/suporte/chamados
// Lista chamados da escola do usuário autenticado
// ──────────────────────────────────────────────
router.get("/chamados", async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;
    const userId = req.user?.id;
    const perfil = req.user?.perfil;
    if (!escolaId) return res.status(400).json({ message: "escola_id ausente" });

    const { status, categoria, page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

    let where = "WHERE c.escola_id = ?";
    const params = [escolaId];

    // Usuários comuns veem apenas seus próprios chamados; diretores/militares veem todos
    const isAdmin = ["diretor", "militar", "coordenador"].includes(perfil);
    if (!isAdmin) {
      where += " AND c.usuario_id = ?";
      params.push(userId);
    }

    if (status) { where += " AND c.status = ?"; params.push(status); }
    if (categoria) { where += " AND c.categoria = ?"; params.push(categoria); }

    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM chamados c ${where}`, params);

    const [rows] = await db.query(`
      SELECT c.* FROM chamados c
      ${where}
      ORDER BY
        FIELD(c.prioridade, 'urgente','alta','media','baixa'),
        c.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset]);

    res.json({ chamados: rows, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error("[Suporte] erro GET /chamados:", err.message);
    res.status(500).json({ message: "Erro ao listar chamados" });
  }
});

// ──────────────────────────────────────────────
// POST /api/suporte/chamados
// Abrir novo chamado
// ──────────────────────────────────────────────
router.post("/chamados", async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;
    const userId = req.user?.id;
    const userName = req.user?.nome || "Usuário";
    const userPerfil = req.user?.perfil;
    if (!escolaId) return res.status(400).json({ message: "escola_id ausente" });

    const { categoria, prioridade, assunto, descricao } = req.body;
    if (!assunto?.trim() || !descricao?.trim()) {
      return res.status(400).json({ message: "Assunto e descrição são obrigatórios" });
    }

    const [result] = await db.query(`
      INSERT INTO chamados (escola_id, usuario_id, usuario_nome, usuario_perfil, categoria, prioridade, assunto, descricao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [escolaId, userId, userName, userPerfil, categoria || "outro", prioridade || "media", assunto.trim(), descricao.trim()]);

    res.status(201).json({ id: result.insertId, message: "Chamado aberto com sucesso" });
  } catch (err) {
    console.error("[Suporte] erro POST /chamados:", err.message);
    res.status(500).json({ message: "Erro ao abrir chamado" });
  }
});

// ──────────────────────────────────────────────
// PATCH /api/suporte/chamados/:id/status
// Atualizar status (admin)
// ──────────────────────────────────────────────
router.patch("/chamados/:id/status", async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;
    const perfil = req.user?.perfil;
    const isAdmin = ["diretor", "militar", "coordenador"].includes(perfil);
    if (!isAdmin) return res.status(403).json({ message: "Sem permissão" });

    const { status, resposta } = req.body;
    if (!status) return res.status(400).json({ message: "Status obrigatório" });

    const updates = ["status = ?"];
    const params = [status];

    if (resposta) {
      updates.push("resposta_admin = ?", "respondido_em = NOW()", "respondido_por = ?");
      params.push(resposta, req.user?.nome || "Admin");
    }

    params.push(req.params.id, escolaId);
    await db.query(`UPDATE chamados SET ${updates.join(", ")} WHERE id = ? AND escola_id = ?`, params);

    res.json({ message: "Chamado atualizado" });
  } catch (err) {
    console.error("[Suporte] erro PATCH /chamados/:id/status:", err.message);
    res.status(500).json({ message: "Erro ao atualizar chamado" });
  }
});

// ──────────────────────────────────────────────
// GET /api/suporte/chamados/:id
// Detalhe de um chamado
// ──────────────────────────────────────────────
router.get("/chamados/:id", async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;
    const [rows] = await db.query(`SELECT * FROM chamados WHERE id = ? AND escola_id = ?`, [req.params.id, escolaId]);
    if (!rows.length) return res.status(404).json({ message: "Chamado não encontrado" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[Suporte] erro GET /chamados/:id:", err.message);
    res.status(500).json({ message: "Erro ao buscar chamado" });
  }
});

module.exports = router;
