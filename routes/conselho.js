import express from "express";
import pool from "../db.js";

const router = express.Router();

// ── Helper: busca nome do usuário no banco (JWT não carrega `nome`) ─────────
async function buscarNomeUsuario(db, usuario_id) {
  if (!usuario_id) return "Usuário";
  try {
    const [[row]] = await db.query(
      "SELECT nome FROM usuarios WHERE id = ? LIMIT 1",
      [Number(usuario_id)]
    );
    return row?.nome || "Usuário";
  } catch {
    return "Usuário";
  }
}

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

    const db = req.db || pool;
    const [rows] = await db.query(
      `SELECT id, aluno_codigo, turma_id, texto,
              usuario_id, usuario_nome, usuario_perfil,
              criado_em, editado_em, editado_por_nome
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

    // usuario_id vem do JWT como `usuario_id` ou `usuarioId`
    const usuario_id     = req.user?.usuario_id || req.user?.usuarioId || req.user?.id || null;
    const usuario_perfil = req.user?.perfil || "professor";

    const db = req.db || pool;

    // Busca o nome real do banco (JWT não carrega `nome`)
    const usuario_nome = await buscarNomeUsuario(db, usuario_id);

    const { aluno_codigo, turma_id, texto } = req.body;

    if (!aluno_codigo) return res.status(400).json({ ok: false, error: "aluno_codigo é obrigatório." });
    if (!texto || !String(texto).trim()) return res.status(400).json({ ok: false, error: "texto é obrigatório." });

    const [result] = await db.query(
      `INSERT INTO registro_conselho
         (escola_id, aluno_codigo, turma_id, texto, usuario_id, usuario_nome, usuario_perfil)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, aluno_codigo, turma_id || null, String(texto).trim(),
       usuario_id, usuario_nome, usuario_perfil]
    );

    res.status(201).json({
      ok: true,
      id: result.insertId,
      usuario_id,
      usuario_nome,
      usuario_perfil,
      criado_em: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[CONSELHO] Erro ao criar registro:", err);
    res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

// ============================================================================
// PUT /api/conselho/registros/:id
// Edita um registro existente — somente pelo autor original
// Body: { texto }
// ============================================================================
router.put("/registros/:id", async (req, res) => {
  try {
    const escola_id = req.escola_id ?? req.user?.escola_id;
    if (!escola_id) return res.status(400).json({ ok: false, error: "Escola não identificada." });

    const { id } = req.params;
    const { texto } = req.body;

    if (!texto || !String(texto).trim()) {
      return res.status(400).json({ ok: false, error: "texto é obrigatório." });
    }

    const usuario_id = req.user?.usuario_id || req.user?.usuarioId || req.user?.id || null;
    const db = req.db || pool;

    // Busca nome real do banco
    const usuario_nome = await buscarNomeUsuario(db, usuario_id);

    // ── Verifica existência e autoria ──────────────────────────────────────
    const [[registro]] = await db.query(
      `SELECT id, usuario_id FROM registro_conselho
       WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    if (!registro) {
      return res.status(404).json({ ok: false, error: "Registro não encontrado." });
    }

    if (Number(registro.usuario_id) !== Number(usuario_id)) {
      return res.status(403).json({ ok: false, error: "Sem permissão para editar este registro." });
    }

    const editado_em = new Date();

    await db.query(
      `UPDATE registro_conselho
       SET texto = ?, editado_em = ?, editado_por_nome = ?
       WHERE id = ?`,
      [String(texto).trim(), editado_em, usuario_nome, id]
    );

    res.json({
      ok: true,
      editado_em: editado_em.toISOString(),
      editado_por_nome: usuario_nome,
    });
  } catch (err) {
    console.error("[CONSELHO] Erro ao editar registro:", err);
    res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

export default router;
