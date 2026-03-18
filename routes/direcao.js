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

export default router;
