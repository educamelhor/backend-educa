// api/controllers/questoesController.js
import pool from "../db.js";
import fs from "fs";
import path from "path";
import * as Questao from "../models/questaoModel.js";
import { parsePdfFile } from "../utils/pdfParser.js";

// 1) GET /questoes — Lista todas as questões da escola do usuário
export async function listarQuestoes(req, res) {
  const { escola_id } = req.user;
  try {
    const [questoes] = await pool.query(
      "SELECT * FROM questoes WHERE escola_id = ? ORDER BY id DESC",
      [escola_id]
    );
    res.json(questoes);
  } catch (err) {
    console.error("Erro ao listar questões:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
}

// 2) GET /questoes/:id — Detalhes de uma questão específica da escola
export async function obterQuestao(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  try {
    const [[questao]] = await pool.query(
      "SELECT * FROM questoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (!questao) return res.status(404).json({ message: "Questão não encontrada." });
    res.json(questao);
  } catch (err) {
    console.error("Erro ao obter questão:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
}

// 3) POST /questoes — Cria nova questão para a escola do usuário
export async function criarQuestao(req, res) {
  const { escola_id } = req.user;
  const {
    conteudo_bruto,
    latex_formatado,
    tipo,
    nivel,
    ano,
    disciplina,
    imagem_base64,
    alternativas_json,
    correta,
    tags
  } = req.body;

  try {
    const [result] = await pool.query(
      `INSERT INTO questoes 
        (conteudo_bruto, latex_formatado, tipo, nivel, ano, disciplina, imagem_base64, alternativas_json, correta, tags, escola_id, criada_em, atualizada_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        conteudo_bruto,
        latex_formatado,
        tipo,
        nivel,
        ano,
        disciplina,
        imagem_base64 || null,
        alternativas_json || null,
        correta || null,
        tags || "",
        escola_id
      ]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error("Erro ao criar questão:", err);
    res.status(500).json({ message: "Erro ao salvar questão." });
  }
}

// 4) PUT /questoes/:id — Atualiza questão (somente se for da escola do usuário)
export async function atualizarQuestao(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const {
    conteudo_bruto,
    latex_formatado,
    tipo,
    nivel,
    ano,
    disciplina,
    imagem_base64,
    alternativas_json,
    correta,
    tags
  } = req.body;

  try {
    const [result] = await pool.query(
      `UPDATE questoes SET
         conteudo_bruto = ?, latex_formatado = ?, tipo = ?, nivel = ?, ano = ?, disciplina = ?,
         imagem_base64 = ?, alternativas_json = ?, correta = ?, tags = ?, atualizada_em = NOW()
       WHERE id = ? AND escola_id = ?`,
      [
        conteudo_bruto,
        latex_formatado,
        tipo,
        nivel,
        ano,
        disciplina,
        imagem_base64 || null,
        alternativas_json || null,
        correta || null,
        tags || "",
        id,
        escola_id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Questão não encontrada ou não pertence à sua escola." });
    }

    res.status(200).json({ message: "Questão atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar questão:", err);
    res.status(500).json({ message: "Erro ao atualizar questão." });
  }
}

// 5) DELETE /questoes/:id — Remove questão (somente se for da escola do usuário)
export async function excluirQuestao(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  try {
    const [result] = await pool.query(
      "DELETE FROM questoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Questão não encontrada ou não pertence à sua escola." });
    }
    res.status(204).end();
  } catch (err) {
    console.error("Erro ao excluir questão:", err);
    res.status(500).json({ message: "Erro ao excluir questão." });
  }
}

// 6) Criar questões a partir de texto (OCR/PDF) — sempre vinculando à escola do usuário
export async function criarQuestoesPorTexto(req, res) {
  const { escola_id } = req.user;
  try {
    const { texto } = req.body;
    if (!texto) {
      return res.status(400).json({ error: "Campo 'texto' é obrigatório" });
    }

    const blocos = texto
      .split("\n\n")
      .map(b => b.trim())
      .filter(b => b);

    const criadas = [];
    for (const bloco of blocos) {
      const linhas = bloco.split("\n").map(l => l.trim()).filter(l => l);
      let enunciado = linhas[0];
      let disciplina = null, ano = null;

      const metaMatch = enunciado.match(/^\[(.+?)\]/);
      if (metaMatch) {
        const [disc, year] = metaMatch[1].split(/[-–]/).map(s => s.trim());
        disciplina = disc;
        ano = year || null;
        enunciado = enunciado.replace(/^\[.+?\]\s*/, "");
      }

      const alternativasArray = linhas
        .slice(1)
        .filter(l => /^\([A-Z]\)/.test(l))
        .map(l => ({
          letra: l.match(/^\(([A-Z])\)/)[1],
          texto: l.replace(/^\([A-Z]\)\s*/, "")
        }));

      const alternativas_json = JSON.stringify(alternativasArray);

      const latexLinhas = [];
      latexLinhas.push("\\begin{question}");
      latexLinhas.push(`\\textbf{${enunciado}}`);
      latexLinhas.push("");
      alternativasArray.forEach(({ letra, texto }) => {
        latexLinhas.push(`(${letra}) ${texto}  `);
      });
      latexLinhas.push("\\end{question}");
      const latex_formatado = latexLinhas.join("\n");

      const dados = {
        conteudo_bruto: bloco,
        latex_formatado,
        disciplina,
        ano,
        alternativas_json,
        escola_id
      };

      const id = await Questao.criarQuestao(dados);
      criadas.push({
        id,
        enunciado,
        disciplina,
        ano,
        alternativas: alternativasArray,
        latex_formatado
      });
    }

    return res.status(201).json({ total: criadas.length, questoes: criadas });
  } catch (err) {
    console.error("Erro em criarQuestoesPorTexto:", err);
    return res.status(500).json({ error: "Falha ao criar questões a partir do texto" });
  }
}
