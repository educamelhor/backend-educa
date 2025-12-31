import { Router } from "express";
import pool from "../db.js";

const router = Router();

// Middleware para garantir que a escola está definida no usuário logado
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ error: "Acesso negado: escola não definida." });
  }
  next();
}

// GET /api/turnos - Lista todos os turnos únicos cadastrados nas turmas da escola do usuário
router.get("/", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const [rows] = await pool.query(
      "SELECT DISTINCT turno FROM turmas WHERE escola_id = ? ORDER BY turno",
      [escola_id]
    );
    const turnos = rows.map(r => r.turno);
    res.json(turnos);
  } catch (e) {
    console.error("Erro ao buscar turnos:", e);
    res.status(500).json({ error: "Erro ao buscar turnos" });
  }
});

export default router;
