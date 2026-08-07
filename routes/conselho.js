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
              criado_em, editado_em, editado_por_nome,
              excluido, excluido_em, excluido_por_nome
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

// ============================================================================
// DELETE /api/conselho/registros/:id
// Soft delete de um registro (oculta o conteúdo)
// ============================================================================
router.delete("/registros/:id", async (req, res) => {
  try {
    const escola_id = req.escola_id ?? req.user?.escola_id;
    if (!escola_id) return res.status(400).json({ ok: false, error: "Escola não identificada." });

    const { id } = req.params;
    const usuario_id = req.user?.usuario_id || req.user?.usuarioId || req.user?.id || null;
    const db = req.db || pool;

    const usuario_nome = await buscarNomeUsuario(db, usuario_id);

    const [[registro]] = await db.query(
      `SELECT id, usuario_id FROM registro_conselho WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    if (!registro) {
      return res.status(404).json({ ok: false, error: "Registro não encontrado." });
    }

    if (Number(registro.usuario_id) !== Number(usuario_id)) {
      return res.status(403).json({ ok: false, error: "Sem permissão para excluir este registro." });
    }

    const excluido_em = new Date();

    await db.query(
      `UPDATE registro_conselho
       SET excluido = 1, excluido_em = ?, excluido_por_nome = ?
       WHERE id = ?`,
      [excluido_em, usuario_nome, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[CONSELHO] Erro ao excluir registro:", err);
    res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

// ============================================================================
// GET /api/conselho/resumo-turma
// Retorna todos os alunos de uma turma com seus registros de conselho
// Query: turma_id (obrigatório), ano_letivo (opcional)
// ============================================================================
router.get("/resumo-turma", async (req, res) => {
  try {
    const escola_id = req.escola_id ?? req.user?.escola_id;
    if (!escola_id) return res.status(400).json({ ok: false, error: "Escola não identificada." });

    const { turma_id, ano_letivo } = req.query;
    if (!turma_id) return res.status(400).json({ ok: false, error: "turma_id é obrigatório." });

    const db = req.db || pool;
    const ano = ano_letivo ? Number(ano_letivo) : (new Date().getMonth() + 1 <= 1 ? new Date().getFullYear() - 1 : new Date().getFullYear());

    // 1) Busca dados da turma
    const [[turmaInfo]] = await db.query(
      `SELECT t.id, t.nome, t.turno, t.serie FROM turmas t WHERE t.id = ? AND t.escola_id = ? LIMIT 1`,
      [turma_id, escola_id]
    );
    if (!turmaInfo) return res.status(404).json({ ok: false, error: "Turma não encontrada." });

    // 2) Busca alunos ativos na turma
    const [alunos] = await db.query(
      `SELECT a.codigo, a.estudante AS nome, a.foto_url, m.numero_chamada
       FROM alunos a
       INNER JOIN matriculas m ON m.aluno_id = a.id AND m.turma_id = ? AND m.ano_letivo = ? AND m.status = 'ativo'
       WHERE a.escola_id = ?
       ORDER BY m.numero_chamada ASC, a.estudante ASC`,
      [turma_id, ano, escola_id]
    );

    if (alunos.length === 0) {
      return res.json({ ok: true, turma: turmaInfo, alunos: [] });
    }

    // 3) Busca TODOS os registros de conselho da turma em uma única query
    const codigos = alunos.map(a => a.codigo);
    const placeholders = codigos.map(() => '?').join(',');
    const [registros] = await db.query(
      `SELECT id, aluno_codigo, texto, usuario_id, usuario_nome, usuario_perfil, criado_em, editado_em
       FROM registro_conselho
       WHERE escola_id = ? AND turma_id = ? AND aluno_codigo IN (${placeholders}) AND (excluido IS NULL OR excluido = 0)
       ORDER BY aluno_codigo ASC, criado_em ASC`,
      [escola_id, turma_id, ...codigos]
    );

    // 4) Agrupa registros por aluno_codigo
    const registrosPorAluno = {};
    for (const r of registros) {
      if (!registrosPorAluno[r.aluno_codigo]) registrosPorAluno[r.aluno_codigo] = [];
      registrosPorAluno[r.aluno_codigo].push(r);
    }

    // 5) Monta resposta final
    const alunosComRegistros = alunos.map(a => ({
      ...a,
      registros: registrosPorAluno[a.codigo] || []
    }));

    res.json({ ok: true, turma: turmaInfo, alunos: alunosComRegistros });
  } catch (err) {
    console.error("[CONSELHO] Erro em resumo-turma:", err);
    res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

export default router;

