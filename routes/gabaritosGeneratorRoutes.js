import express from "express";
import pool from "../db.js";

const router = express.Router();

// Middleware para garantir que a escola esteja definida
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

// Cria ou atualiza correção (inteligente)
router.post("/", verificarEscola, async (req, res) => {
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

    const { escola_id } = req.user;

    if (!codigo || !nome || !ano || !numero || !situacao) {
      return res.status(400).json({ message: "Campos obrigatórios ausentes." });
    }

    // Primeiro tenta atualizar (somente dentro da mesma escola)
    const [updateResult] = await pool.query(
      `UPDATE correcoes_openai 
       SET situacao=?, competencia_1=?, competencia_2=?, competencia_3=?, competencia_4=?, origem=?
       WHERE codigo=? AND tipo=? AND ano=? AND numero=? AND escola_id=?`,
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
        numero,
        escola_id
      ]
    );

    if (updateResult.affectedRows === 0) {
      // Se não atualizou nada, faz INSERT
      await pool.query(
        `INSERT INTO correcoes_openai
         (codigo, tipo, nome, ano, numero, situacao, competencia_1, competencia_2, competencia_3, competencia_4, origem, escola_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          origem,
          escola_id
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
router.get("/", verificarEscola, async (req, res) => {
  const { codigo, tipo, ano, numero } = req.query;
  const { escola_id } = req.user;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM correcoes_openai 
       WHERE codigo=? AND tipo=? AND ano=? AND numero=? AND escola_id=?`,
      [codigo, tipo, ano, numero, escola_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Não encontrada." });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Erro ao buscar correção.", details: err });
  }
});

// Lista todas as correções de um aluno
router.get("/todas", verificarEscola, async (req, res) => {
  const { codigo } = req.query;
  const { escola_id } = req.user;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM correcoes_openai 
       WHERE codigo=? AND escola_id=? 
       ORDER BY ano DESC, numero DESC`,
      [codigo, escola_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Erro ao listar correções.", details: err });
  }
});

export default router;
