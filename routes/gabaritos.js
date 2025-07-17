// backend/gabaritos.js

import express from "express";
import mysql from "mysql2/promise";
import dotenv from "dotenv";      // Adiciona o dotenv para ler o .env

dotenv.config();

const router = express.Router();

// Agora lê do .env (NUNCA hardcoded!)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// POST /api/gabaritos/corrigir
router.post("/corrigir", async (req, res) => {
  const { respostasAluno, gabaritoOficial, codigoAluno, nome, turma, nomeGabarito } = req.body;
  if (!Array.isArray(respostasAluno) || !Array.isArray(gabaritoOficial)) {
    return res.status(400).json({ error: "Envie arrays de respostasAluno e gabaritoOficial" });
  }

  let nota = 0;
  const correcao = respostasAluno.map((resposta, i) => {
    const correto = gabaritoOficial[i] || "-";
    const acertou = resposta === correto;
    if (acertou) nota++;
    return { numero: i + 1, resposta, correto, acertou };
  });

  // SALVAR NO BANCO, agora incluindo o campo nome_gabarito
  try {
    await pool.query(
      "INSERT INTO gabaritos_corrigidos (codigo_aluno, nome_aluno, turma, respostas_aluno, gabarito_oficial, nome_gabarito, acertos, detalhes_correcao) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        codigoAluno,
        nome,
        turma,
        respostasAluno.join(","),
        gabaritoOficial.join(","),
        nomeGabarito,
        nota,
        JSON.stringify(correcao)
      ]
    );
    res.json({ nota, correcao, codigoAluno, nome, turma, nomeGabarito, saved: true });
  } catch (err) {
    console.error("Erro ao salvar no MySQL:", err); // <-- Mostra erro completo no terminal
    res.status(500).json({ error: "Erro ao salvar no banco." });
  }
});

// GET /api/gabaritos/nome-unicos
router.get("/nome-unicos", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT DISTINCT nome_gabarito FROM gabaritos_corrigidos WHERE nome_gabarito IS NOT NULL"
    );
    const nomes = rows.map(r => r.nome_gabarito).filter(Boolean);
    res.json(nomes);
  } catch (err) {
    console.error("Erro ao buscar nomes de gabaritos:", err); // <-- Mostra erro completo no terminal
    res.status(500).json({ error: "Erro ao buscar nomes de gabaritos." });
  }
});

export default router;
