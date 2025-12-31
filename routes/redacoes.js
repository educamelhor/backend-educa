import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import pool from "../db.js";
import OpenAI from "openai";

const router = express.Router();

// Middleware para garantir que a escola esteja definida
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ error: "Acesso negado: escola não definida." });
  }
  next();
}

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
router.post("/salvar", verificarEscola, upload.single("imagem"), async (req, res) => {
  const { codigo, nome, turma, texto } = req.body;
  const { escola_id } = req.user;
  const imagem = req.file ? `/uploads/redacoes/${req.file.filename}` : null;

  if (!codigo || !nome || !turma || !texto || !imagem) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes." });
  }
  try {
    await pool.query(
      "INSERT INTO redacoes (codigo, nome, turma, texto, imagem, escola_id) VALUES (?, ?, ?, ?, ?, ?)",
      [codigo, nome, turma, texto, imagem, escola_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao salvar redação.", details: err });
  }
});

// OpenAI API setup
// IMPORTANTE: não instanciar OpenAI no topo do arquivo, pois se OPENAI_API_KEY não existir
// o servidor cai no boot (derruba deploy na DigitalOcean). Criamos sob demanda.
function getOpenAIClientOrNull() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

// ROTA PARA CORRIGIR REDAÇÃO USANDO IA
router.post("/corrigir", verificarEscola, async (req, res) => {
  const { texto, criterio } = req.body;
  if (!texto || !criterio)
    return res.status(400).json({ error: "Texto ou critério ausente." });

  const prompt = `${criterio}\n\nRedação do aluno:\n${texto}`;

  console.log("Chave OpenAI:", process.env.OPENAI_API_KEY?.slice(0,8) + "...");
  console.log("Prompt de correção:", prompt.substring(0, 200) + "...");

  // Se a chave não estiver configurada, não derruba o servidor: retorna 503 (serviço indisponível)
  const openai = getOpenAIClientOrNull();
  if (!openai) {
    return res.status(503).json({
      error: "Serviço de correção automática indisponível: OPENAI_API_KEY ausente."
    });
  }

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
