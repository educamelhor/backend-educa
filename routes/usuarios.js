// api/routes/usuarios.js
import express from "express";
import pool from "../db.js";
import bcrypt from "bcryptjs";

const router = express.Router();

// Middleware para garantir que a escola esteja definida no usuário logado
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

/**
 * GET /api/usuarios
 * Lista todos os usuários da escola logada com paginação
 * Query params:
 *   page  = número da página (padrão: 1)
 *   limit = quantidade de registros por página (padrão: 10)
 */
router.get("/", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    // Total de usuários na escola
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM usuarios WHERE escola_id = ?",
      [escola_id]
    );

    // Lista paginada
    const [usuarios] = await pool.query(
      `SELECT id, cpf, nome, email, celular, perfil, escola_id, ativo
       FROM usuarios
       WHERE escola_id = ?
       ORDER BY nome ASC
       LIMIT ? OFFSET ?`,
      [escola_id, limit, offset]
    );

    res.json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: usuarios
    });
  } catch (err) {
    console.error("Erro ao listar usuários:", err);
    res.status(500).json({ message: "Erro ao listar usuários." });
  }
});

/**
 * GET /api/usuarios/por-cpf/:cpf
 */
router.get("/por-cpf/:cpf", verificarEscola, async (req, res) => {
  const cpf = req.params.cpf.replace(/\D/g, "");
  const { escola_id } = req.user;
  try {
    const [[usuario]] = await pool.query(
      "SELECT id, cpf, nome, email, celular, perfil, escola_id FROM usuarios WHERE cpf = ? AND escola_id = ?",
      [cpf, escola_id]
    );
    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });
    res.json(usuario);
  } catch (err) {
    res.status(500).json({ message: "Erro ao buscar usuário por CPF." });
  }
});

/**
 * GET /api/usuarios/por-email/:email
 */
router.get("/por-email/:email", verificarEscola, async (req, res) => {
  const email = req.params.email;
  const { escola_id } = req.user;
  try {
    const [[usuario]] = await pool.query(
      "SELECT id, cpf, nome, email, celular, perfil, escola_id FROM usuarios WHERE email = ? AND escola_id = ?",
      [email, escola_id]
    );
    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });
    res.json(usuario);
  } catch (err) {
    res.status(500).json({ message: "Erro ao buscar usuário por e-mail." });
  }
});

/**
 * POST /api/usuarios
 * Cria novo usuário vinculado à escola logada
 */
router.post("/", verificarEscola, async (req, res) => {
  const { cpf, nome, email, celular, perfil, senha } = req.body;
  const { escola_id, perfil: perfilCriador } = req.user;

  if (!cpf || !nome || !email || !celular || !perfil || !senha) {
    return res.status(400).json({ message: "Preencha todos os campos obrigatórios." });
  }

  // Validação: apenas admin pode criar outro admin
  if (perfil.toLowerCase() === "admin" && perfilCriador.toLowerCase() !== "admin") {
    return res.status(403).json({ message: "Somente administradores podem criar outros administradores." });
  }

  try {
    const senha_hash = await bcrypt.hash(senha, 10);

    const [existe] = await pool.query(
      "SELECT id FROM usuarios WHERE (cpf = ? OR email = ?) AND escola_id = ?",
      [cpf, email, escola_id]
    );
    if (existe.length > 0) {
      return res.status(400).json({ message: "Usuário já cadastrado (CPF ou e-mail existente) na sua escola." });
    }

    await pool.query(
      "INSERT INTO usuarios (cpf, nome, email, celular, perfil, escola_id, senha_hash, ativo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
      [cpf, nome, email, celular, perfil, escola_id, senha_hash]
    );
    res.json({ success: true, message: "Usuário cadastrado com sucesso!" });
  } catch (err) {
    console.error("Erro ao criar usuário:", err);
    res.status(500).json({ message: "Erro ao criar usuário.", error: err.message });
  }
});

export default router;
