// api/routes/escolas.js

import { Router } from "express";
import pool from "../db.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, nome
      FROM escolas
      ORDER BY nome
    `);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar escolas:", err);
    res.status(500).json({ error: "Não foi possível carregar as escolas." });
  }
});

export default router;
