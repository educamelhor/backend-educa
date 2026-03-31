// routes/direcao.js
// =========================================================================
// Endpoints de Gestão de Equipe — Diretor Disciplinar (Comandante)
// Gerencia monitores, inspetores e demais membros da equipe escolar.
// Usa a tabela `equipe_escola` (criar se não existir).
// =========================================================================
import express from "express";

const router = express.Router();

// ── Listar membros da equipe ──
// GET /api/direcao/equipe?escola_id=X
router.get("/equipe", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.query.escola_id);
  if (!escolaId) return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });

  try {
    // Garante que a tabela existe
    await db.query(`
      CREATE TABLE IF NOT EXISTS equipe_escola (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        escola_id  INT NOT NULL,
        nome       VARCHAR(200) NOT NULL,
        cpf        VARCHAR(14) NOT NULL,
        email      VARCHAR(120),
        funcao     VARCHAR(50) NOT NULL DEFAULT 'monitor',
        ativo      TINYINT(1) NOT NULL DEFAULT 1,
        criado_em  DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_cpf_escola (cpf, escola_id),
        KEY idx_escola (escola_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [rows] = await db.query(
      "SELECT id, nome, cpf, email, funcao, ativo, criado_em FROM equipe_escola WHERE escola_id = ? ORDER BY ativo DESC, nome ASC",
      [escolaId]
    );
    return res.json({ ok: true, membros: rows });
  } catch (err) {
    console.error("[DIRECAO][LISTAR EQUIPE]", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar equipe." });
  }
});

// ── Adicionar membro ──
// POST /api/direcao/equipe
// body: { nome, cpf, email, funcao, escola_id }
router.post("/equipe", async (req, res) => {
  const db = req.db;
  const { nome, cpf, email, funcao, escola_id } = req.body;

  if (!nome || !cpf || !escola_id) {
    return res.status(400).json({ ok: false, message: "Nome, CPF e escola_id são obrigatórios." });
  }

  const cpfLimpo = String(cpf).replace(/\D/g, "");
  if (cpfLimpo.length !== 11) {
    return res.status(400).json({ ok: false, message: "CPF inválido." });
  }

  try {
    // Verifica duplicata
    const [dup] = await db.query(
      "SELECT id FROM equipe_escola WHERE cpf = ? AND escola_id = ?",
      [cpfLimpo, Number(escola_id)]
    );
    if (dup.length) {
      return res.status(409).json({ ok: false, message: "Este CPF já está cadastrado nesta escola." });
    }

    await db.query(
      "INSERT INTO equipe_escola (escola_id, nome, cpf, email, funcao) VALUES (?, ?, ?, ?, ?)",
      [Number(escola_id), nome.trim(), cpfLimpo, email || null, funcao || "monitor_disciplinar"]
    );

    // ── Pré-cadastro em `usuarios` (permite login via "Quero me cadastrar") ──
    const [existeUsuario] = await db.query(
      "SELECT id FROM usuarios WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND escola_id = ? AND perfil = 'disciplinar'",
      [cpfLimpo, Number(escola_id)]
    );
    if (!existeUsuario.length) {
      await db.query(
        `INSERT INTO usuarios (cpf, nome, email, escola_id, perfil, ativo, senha_hash)
         VALUES (?, ?, ?, ?, 'disciplinar', 1, '')`,
        [cpfLimpo, nome.trim(), email || null, Number(escola_id)]
      );
    }

    return res.status(201).json({ ok: true, message: "Membro adicionado com sucesso." });
  } catch (err) {
    console.error("[DIRECAO][ADICIONAR EQUIPE]", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "CPF já cadastrado nesta escola." });
    }
    return res.status(500).json({ ok: false, message: "Erro ao adicionar membro." });
  }
});

// ── Editar membro ──
// PUT /api/direcao/equipe/:id
// body: { nome, email, funcao }
router.put("/equipe/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const { nome, email, funcao } = req.body;

  if (!id || !nome) {
    return res.status(400).json({ ok: false, message: "ID e nome são obrigatórios." });
  }

  try {
    await db.query(
      "UPDATE equipe_escola SET nome = ?, email = ?, funcao = ? WHERE id = ?",
      [nome.trim(), email || null, funcao || "monitor", id]
    );
    return res.json({ ok: true, message: "Membro atualizado." });
  } catch (err) {
    console.error("[DIRECAO][EDITAR EQUIPE]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar." });
  }
});

// ── Alterar status (bloquear, cancelar, reativar) ──
// PATCH /api/direcao/equipe/:id/status
// body: { status: "bloqueado" | "cancelado" | "ativo" }
router.patch("/equipe/:id/status", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const novoStatus = req.body?.status;

  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });

  try {
    if (novoStatus === "ativo") {
      await db.query("UPDATE equipe_escola SET ativo = 1 WHERE id = ?", [id]);
      return res.json({ ok: true, message: "Membro reativado." });
    }
    if (novoStatus === "bloqueado" || novoStatus === "cancelado") {
      await db.query("UPDATE equipe_escola SET ativo = 0 WHERE id = ?", [id]);
      return res.json({ ok: true, message: `Membro ${novoStatus}.` });
    }
    return res.status(400).json({ ok: false, message: "Status inválido." });
  } catch (err) {
    console.error("[DIRECAO][STATUS EQUIPE]", err);
    return res.status(500).json({ ok: false, message: "Erro ao alterar status." });
  }
});


// ═══════════════════════════════════════════════════════════════
// CADASTRO DE MEMBROS — Diretor pré-cadastra (CPF, nome, função)
// Membro completa via /cadastro (e-mail, senha, data de nascimento)
// ═══════════════════════════════════════════════════════════════

// ── Helper: garante tabela ──
async function ensureCadastroTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cadastro_membros_escola (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      escola_id  INT NOT NULL,
      nome       VARCHAR(200) NOT NULL,
      cpf        VARCHAR(14) NOT NULL,
      funcao     VARCHAR(80) NOT NULL DEFAULT 'coordenador',
      ativo      TINYINT(1) NOT NULL DEFAULT 1,
      criado_em  DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_cpf_escola_cadastro (cpf, escola_id),
      KEY idx_escola_cadastro (escola_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// ── Listar membros cadastrados ──
// GET /api/direcao/cadastro?escola_id=X
router.get("/cadastro", async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.query.escola_id);
  if (!escolaId) return res.status(400).json({ ok: false, message: "escola_id é obrigatório." });

  try {
    await ensureCadastroTable(db);

    const [rows] = await db.query(
      `SELECT 
        c.id, c.nome, c.cpf, c.funcao, c.ativo, c.criado_em,
        u.email,
        CASE WHEN u.senha_hash IS NOT NULL AND u.senha_hash != '' THEN 1 ELSE 0 END AS cadastro_completo
      FROM cadastro_membros_escola c
      LEFT JOIN usuarios u ON REPLACE(REPLACE(u.cpf, '.', ''), '-', '') = REPLACE(REPLACE(c.cpf, '.', ''), '-', '')
        AND u.escola_id = c.escola_id
      WHERE c.escola_id = ?
      ORDER BY c.ativo DESC, c.nome ASC`,
      [escolaId]
    );
    return res.json({ ok: true, membros: rows });
  } catch (err) {
    console.error("[DIRECAO][LISTAR CADASTRO]", err);
    return res.status(500).json({ ok: false, message: "Erro ao listar cadastros." });
  }
});

// ── Adicionar membro (pré-cadastro) ──
// POST /api/direcao/cadastro
// body: { nome, cpf, funcao, escola_id }
router.post("/cadastro", async (req, res) => {
  const db = req.db;
  const { nome, cpf, funcao, escola_id } = req.body;

  if (!nome || !cpf || !escola_id) {
    return res.status(400).json({ ok: false, message: "Nome, CPF e escola_id são obrigatórios." });
  }

  const cpfLimpo = String(cpf).replace(/\D/g, "");
  if (cpfLimpo.length !== 11) {
    return res.status(400).json({ ok: false, message: "CPF inválido." });
  }

  try {
    await ensureCadastroTable(db);

    // Verifica duplicata
    const [dup] = await db.query(
      "SELECT id FROM cadastro_membros_escola WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND escola_id = ?",
      [cpfLimpo, Number(escola_id)]
    );
    if (dup.length) {
      return res.status(409).json({ ok: false, message: "Este CPF já está cadastrado nesta escola." });
    }

    await db.query(
      "INSERT INTO cadastro_membros_escola (escola_id, nome, cpf, funcao) VALUES (?, UPPER(?), ?, ?)",
      [Number(escola_id), nome.trim(), cpfLimpo, funcao || "coordenador"]
    );

    // ── Pré-cadastro em `usuarios` (permite auto-cadastro via /cadastro) ──
    const perfilUsuario = funcao || "coordenador";
    const [existeUsuario] = await db.query(
      "SELECT id FROM usuarios WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND escola_id = ?",
      [cpfLimpo, Number(escola_id)]
    );
    if (!existeUsuario.length) {
      await db.query(
        `INSERT INTO usuarios (cpf, nome, escola_id, perfil, ativo, senha_hash)
         VALUES (?, UPPER(?), ?, ?, 1, '')`,
        [cpfLimpo, nome.trim(), Number(escola_id), perfilUsuario]
      );
    }

    return res.status(201).json({ ok: true, message: "Membro pré-cadastrado com sucesso." });
  } catch (err) {
    console.error("[DIRECAO][ADICIONAR CADASTRO]", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "CPF já cadastrado nesta escola." });
    }
    return res.status(500).json({ ok: false, message: "Erro ao adicionar membro." });
  }
});

// ── Editar membro ──
// PUT /api/direcao/cadastro/:id
// body: { nome, funcao }
router.put("/cadastro/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const { nome, funcao } = req.body;

  if (!id || !nome) {
    return res.status(400).json({ ok: false, message: "ID e nome são obrigatórios." });
  }

  try {
    // Atualiza cadastro_membros_escola
    await db.query(
      "UPDATE cadastro_membros_escola SET nome = UPPER(?), funcao = ? WHERE id = ?",
      [nome.trim(), funcao || "coordenador", id]
    );

    // Também atualiza nome e perfil em usuarios (se existir)
    const [[membro]] = await db.query(
      "SELECT cpf, escola_id FROM cadastro_membros_escola WHERE id = ?",
      [id]
    );
    if (membro) {
      const cpfLimpo = String(membro.cpf).replace(/\D/g, "");
      await db.query(
        `UPDATE usuarios SET nome = UPPER(?), perfil = ?
         WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND escola_id = ?`,
        [nome.trim(), funcao || "coordenador", cpfLimpo, membro.escola_id]
      );
    }

    return res.json({ ok: true, message: "Membro atualizado." });
  } catch (err) {
    console.error("[DIRECAO][EDITAR CADASTRO]", err);
    return res.status(500).json({ ok: false, message: "Erro ao atualizar." });
  }
});

// ── Alterar status (ativar / inativar) ──
// PATCH /api/direcao/cadastro/:id/status
// body: { status: "ativo" | "inativo" }
router.patch("/cadastro/:id/status", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const novoStatus = req.body?.status;

  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });

  try {
    const ativo = novoStatus === "ativo" ? 1 : 0;
    await db.query("UPDATE cadastro_membros_escola SET ativo = ? WHERE id = ?", [ativo, id]);

    // Também atualiza ativo em usuarios
    const [[membro]] = await db.query(
      "SELECT cpf, escola_id FROM cadastro_membros_escola WHERE id = ?",
      [id]
    );
    if (membro) {
      const cpfLimpo = String(membro.cpf).replace(/\D/g, "");
      await db.query(
        "UPDATE usuarios SET ativo = ? WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND escola_id = ?",
        [ativo, cpfLimpo, membro.escola_id]
      );
    }

    return res.json({ ok: true, message: novoStatus === "ativo" ? "Membro reativado." : "Membro inativado." });
  } catch (err) {
    console.error("[DIRECAO][STATUS CADASTRO]", err);
    return res.status(500).json({ ok: false, message: "Erro ao alterar status." });
  }
});

// ── Excluir membro ──
// DELETE /api/direcao/cadastro/:id
router.delete("/cadastro/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);

  if (!id) return res.status(400).json({ ok: false, message: "ID inválido." });

  try {
    // Busca dados antes de excluir (para limpar usuarios também)
    const [[membro]] = await db.query(
      "SELECT cpf, escola_id FROM cadastro_membros_escola WHERE id = ?",
      [id]
    );

    await db.query("DELETE FROM cadastro_membros_escola WHERE id = ?", [id]);

    // Opcional: remove da tabela usuarios se não tiver senha (não completou cadastro)
    if (membro) {
      const cpfLimpo = String(membro.cpf).replace(/\D/g, "");
      await db.query(
        `DELETE FROM usuarios 
         WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? 
           AND escola_id = ? 
           AND (senha_hash IS NULL OR senha_hash = '')`,
        [cpfLimpo, membro.escola_id]
      );
    }

    return res.json({ ok: true, message: "Membro removido." });
  } catch (err) {
    console.error("[DIRECAO][EXCLUIR CADASTRO]", err);
    return res.status(500).json({ ok: false, message: "Erro ao excluir." });
  }
});

export default router;
