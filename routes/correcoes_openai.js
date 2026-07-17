import express from "express";
import pool from "../db.js"; // ajuste se o caminho do seu pool for diferente

const router = express.Router();

// Cria ou atualiza correção (inteligente)
router.post("/", async (req, res) => {
  try {
    const {
      codigo,
      tipo = "Redação",
      nome,
      ano,
      numero,
      situacao,
      competencia_1,
      competencia_2,
      competencia_3,
      competencia_4,
      origem = "manual"
    } = req.body;

    if (!codigo || !nome || !ano || !numero || !situacao) {
      return res.status(400).json({ message: "Campos obrigatórios ausentes." });
    }

    // Primeiro tenta atualizar (UPDATE)
    const [updateResult] = await pool.query(
      `UPDATE correcoes_openai SET
        situacao=?, competencia_1=?, competencia_2=?, competencia_3=?, competencia_4=?, origem=?
        WHERE codigo=? AND tipo=? AND ano=? AND numero=?`,
      [
        situacao,
        competencia_1,
        competencia_2,
        competencia_3,
        competencia_4,
        origem,
        codigo,
        tipo,
        ano,
        numero
      ]
    );

    if (updateResult.affectedRows === 0) {
      // Se não atualizou nada, faz INSERT
      await pool.query(
        `INSERT INTO correcoes_openai
        (codigo, tipo, nome, ano, numero, situacao, competencia_1, competencia_2, competencia_3, competencia_4, origem)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          codigo,
          tipo,
          nome,
          ano,
          numero,
          situacao,
          competencia_1,
          competencia_2,
          competencia_3,
          competencia_4,
          origem
        ]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("ERRO AO SALVAR CORREÇÃO:", err);
    res.status(500).json({ message: "Erro ao salvar correção.", details: err });
  }
});

// Busca uma correção específica
router.get("/", async (req, res) => {
  const { codigo, tipo, ano, numero } = req.query;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM correcoes_openai WHERE codigo=? AND tipo=? AND ano=? AND numero=?`,
      [codigo, tipo, ano, numero]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Não encontrada." });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Erro ao buscar correção.", details: err });
  }
});

// (Opcional) Lista todas as correções de um aluno
router.get("/todas", async (req, res) => {
  const { codigo } = req.query;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM correcoes_openai WHERE codigo=? ORDER BY ano DESC, numero DESC`,
      [codigo]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Erro ao listar correções.", details: err });
  }
});

export default router;
