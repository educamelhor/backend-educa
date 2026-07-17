// api/routes/escolas.js
import { Router } from "express";
import pool from "../db.js";

const router = Router();

// Middleware para verificar se o usuário tem escola associada
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ error: "Acesso negado: escola não definida." });
  }
  next();
}

// Lista apenas a escola do usuário logado
router.get("/", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const [rows] = await pool.query(
      "SELECT id, nome, apelido FROM escolas WHERE id = ?",
      [escola_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar escolas:", err);
    res.status(500).json({ error: "Não foi possível carregar as escolas." });
  }
});

// Busca uma escola por ID (somente se for a do usuário logado)
router.get("/:id", verificarEscola, async (req, res) => {
  const { id } = req.params;
  const { escola_id } = req.user;
  try {
    if (parseInt(id) !== escola_id) {
      return res.status(403).json({ error: "Você não tem permissão para acessar esta escola." });
    }

    const [rows] = await pool.query(
      "SELECT id, nome, apelido FROM escolas WHERE id = ?",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Escola não encontrada." });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Erro ao buscar escola:", err);
    res.status(500).json({ error: "Não foi possível buscar a escola." });
  }
});

export default router;
