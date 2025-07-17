import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import pool from "../db.js";
import OpenAI from "openai";

const router = express.Router();

// Configura o Multer para salvar na pasta uploads/redacoes
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = "./uploads/redacoes";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    // Usa o código do aluno como nome do arquivo, mantém a extensão
    const ext = path.extname(file.originalname) || ".jpg";
    const codigo = req.body.codigo || "sem-codigo";
    cb(null, `${codigo}${ext}`);
  }
});
const upload = multer({ storage });

// Rota para salvar redação e imagem
router.post("/salvar", upload.single("imagem"), async (req, res) => {
  const { codigo, nome, turma, texto } = req.body;
  const imagem = req.file ? `/uploads/redacoes/${req.file.filename}` : null;

  if (!codigo || !nome || !turma || !texto || !imagem) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes." });
  }
  try {
    await pool.query(
      "INSERT INTO redacoes (codigo, nome, turma, texto, imagem) VALUES (?, ?, ?, ?, ?)",
      [codigo, nome, turma, texto, imagem]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao salvar redação.", details: err });
  }
});

// OpenAI API setup

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ROTA PARA CORRIGIR REDAÇÃO USANDO IA
router.post("/corrigir", async (req, res) => {
  const { texto, criterio } = req.body;
  if (!texto || !criterio)
    return res.status(400).json({ error: "Texto ou critério ausente." });

  const prompt = `${criterio}\n\nRedação do aluno:\n${texto}`;




  console.log("Chave OpenAI:", process.env.OPENAI_API_KEY?.slice(0,8) + "...");
  console.log("Prompt de correção:", prompt.substring(0, 200) + "...");







  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 900
    });
    res.json({ correcao: completion.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro na correção automática.", details: err.message });
  }
});

export default router;
