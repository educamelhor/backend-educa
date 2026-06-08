import express from "express";
import pool from "../db.js";

const router = express.Router();

// ============================================================================
// GET /api/conselho/registros
// Lista registros de conselho de classe de um aluno
// Query: aluno_codigo (obrigatório), turma_id (opcional)
// ============================================================================
router.get("/registros", async (req, res) => {
  try {
    const escola_id = req.escola_id ?? req.user?.escola_id;
    if (!escola_id) return res.status(400).json({ ok: false, error: "Escola não identificada." });

    const { aluno_codigo, turma_id } = req.query;
    if (!aluno_codigo) return res.status(400).json({ ok: false, error: "aluno_codigo é obrigatório." });

    let where = "WHERE escola_id = ? AND aluno_codigo = ?";
    const params = [escola_id, aluno_codigo];

    if (turma_id) {
      where += " AND turma_id = ?";
      params.push(turma_id);
    }

    const [rows] = await (req.db || pool).query(
      `SELECT id, aluno_codigo, turma_id, texto,
              usuario_id, usuario_nome, usuario_perfil,
              criado_em
       FROM registro_conselho
       ${where}
       ORDER BY criado_em DESC
       LIMIT 200`,
      params
    );

    res.json({ ok: true, registros: rows });
  } catch (err) {
    console.error("[CONSELHO] Erro ao listar registros:", err);
    res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

// ============================================================================
// POST /api/conselho/registros
// Cria um novo registro de conselho de classe
// Body: { aluno_codigo, turma_id, texto }
// ============================================================================
router.post("/registros", async (req, res) => {
  try {
    const escola_id = req.escola_id ?? req.user?.escola_id;
    if (!escola_id) return res.status(400).json({ ok: false, error: "Escola não identificada." });

    const usuario_id   = req.user?.id || null;
    const usuario_nome = req.user?.nome || req.user?.name || "Usuário";
    const usuario_perfil = req.user?.perfil || req.user?.role || "professor";

    const { aluno_codigo, turma_id, texto } = req.body;

    if (!aluno_codigo) return res.status(400).json({ ok: false, error: "aluno_codigo é obrigatório." });
    if (!texto || !String(texto).trim()) return res.status(400).json({ ok: false, error: "texto é obrigatório." });

    const [result] = await (req.db || pool).query(
      `INSERT INTO registro_conselho
         (escola_id, aluno_codigo, turma_id, texto, usuario_id, usuario_nome, usuario_perfil)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, aluno_codigo, turma_id || null, String(texto).trim(),
       usuario_id, usuario_nome, usuario_perfil]
    );

    res.status(201).json({
      ok: true,
      id: result.insertId,
      usuario_nome,
      usuario_perfil,
      criado_em: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[CONSELHO] Erro ao criar registro:", err);
    res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

export default router;
