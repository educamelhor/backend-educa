// routes/suporte.js
// ============================================================================
// SAC Técnico — Chamados de suporte técnico (ESCOLA → CEO/Equipe Técnica)
// ============================================================================
import express from "express";
import pool from "../db.js";

const router = express.Router();

// ── Auto-migrate: cria tabela se não existir ──
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
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_chamado_escola (escola_id),
        INDEX idx_chamado_status (status),
        INDEX idx_chamado_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    migrated = true;
    console.log("[Suporte] tabela chamados OK");
  } catch (err) {
    console.error("[Suporte] ERRO ao criar tabela:", err.message, err.stack);
    // marca como migrado para não travar em loop
    migrated = true;
  }
}

// ── Middleware: garantir tabela ──
router.use(async (req, res, next) => {
  try {
    await ensureTable();
  } catch (e) {
    console.error("[Suporte] ensureTable middleware error:", e.message);
  }
  next();
});

// ── GET /api/suporte/chamados ──
router.get("/chamados", async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;
    const userId = req.user?.id;
    const perfil = req.user?.perfil;
    if (!escolaId) return res.status(400).json({ message: "escola_id ausente" });

    const { status, categoria, page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

    let where = "WHERE escola_id = ?";
    const params = [escolaId];

    const isEscolaAdmin = ["diretor", "militar"].includes(perfil);
    if (!isEscolaAdmin) {
      where += " AND usuario_id = ?";
      params.push(userId);
    }

    if (status) { where += " AND status = ?"; params.push(status); }
    if (categoria) { where += " AND categoria = ?"; params.push(categoria); }

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM chamados ${where}`, params);

    const [rows] = await pool.query(`
      SELECT * FROM chamados
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset]);

    res.json({ chamados: rows, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error("[Suporte] erro GET /chamados:", err.message, err.stack);
    res.status(500).json({ message: "Erro ao listar chamados" });
  }
});

// ── POST /api/suporte/chamados ──
router.post("/chamados", async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;
    const userId = req.user?.id;
    const userName = req.user?.nome || "Usuário";
    const userPerfil = req.user?.perfil;

    console.log("[Suporte] POST /chamados user:", { escolaId, userId, userName, userPerfil });

    if (!escolaId) return res.status(400).json({ message: "escola_id ausente" });

    const { categoria, prioridade, assunto, descricao } = req.body;
    console.log("[Suporte] POST /chamados body:", { categoria, prioridade, assunto: assunto?.substring(0, 50), descLen: descricao?.length });

    if (!assunto?.trim() || !descricao?.trim()) {
      return res.status(400).json({ message: "Assunto e descrição são obrigatórios" });
    }

    // Buscar nome da escola
    let escolaNome = null;
    try {
      const [esc] = await pool.query(`SELECT nome FROM escolas WHERE id = ?`, [escolaId]);
      escolaNome = esc[0]?.nome || null;
    } catch (e) {
      console.error("[Suporte] erro ao buscar escola:", e.message);
    }

    const [result] = await pool.query(`
      INSERT INTO chamados (escola_id, escola_nome, usuario_id, usuario_nome, usuario_perfil, categoria, prioridade, assunto, descricao, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberto')
    `, [escolaId, escolaNome, userId, userName, userPerfil, categoria || "outro", prioridade || "media", assunto.trim(), descricao.trim()]);

    console.log("[Suporte] chamado criado id:", result.insertId);
    res.status(201).json({ id: result.insertId, message: "Chamado enviado para a equipe técnica" });
  } catch (err) {
    console.error("[Suporte] ERRO POST /chamados:", err.message, err.stack);
    res.status(500).json({ message: "Erro ao abrir chamado: " + err.message });
  }
});

// ── GET /api/suporte/chamados/:id ──
router.get("/chamados/:id", async (req, res) => {
  try {
    const escolaId = req.user?.escola_id;
    const [rows] = await pool.query(`SELECT * FROM chamados WHERE id = ? AND escola_id = ?`, [req.params.id, escolaId]);
    if (!rows.length) return res.status(404).json({ message: "Chamado não encontrado" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[Suporte] erro GET /chamados/:id:", err.message);
    res.status(500).json({ message: "Erro ao buscar chamado" });
  }
});

export default router;
