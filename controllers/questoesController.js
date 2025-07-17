// ──────────────────────────────────────────────────────────────
// api/controllers/questoesController.js
// ──────────────────────────────────────────────────────────────
import pool from "../db.js";
import fs from "fs";
import path from "path";
// Import do modelo de Questão
import * as Questao from "../models/questaoModel.js";
// (Opcional) Se quiser parsear PDFs via helper
import { parsePdfFile } from "../utils/pdfParser.js";


// ──────────────────────────────────────────────────────────────
// 1) GET /questoes → Lista todas as questões (com filtro opcional)
// ──────────────────────────────────────────────────────────────
export async function listarQuestoes(req, res) {
  try {
    const [questoes] = await pool.query("SELECT * FROM questoes ORDER BY id DESC");
    res.json(questoes);
  } catch (err) {
    console.error("Erro ao listar questões:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
}

// ──────────────────────────────────────────────────────────────
// 2) GET /questoes/:id → Detalhes de uma questão específica
// ──────────────────────────────────────────────────────────────
export async function obterQuestao(req, res) {
  const { id } = req.params;
  try {
    const [[questao]] = await pool.query("SELECT * FROM questoes WHERE id = ?", [id]);
    if (!questao) return res.status(404).json({ message: "Questão não encontrada." });
    res.json(questao);
  } catch (err) {
    console.error("Erro ao obter questão:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
}

// ──────────────────────────────────────────────────────────────
// 3) POST /questoes → Cria nova questão (texto, imagem, etc.)
// ──────────────────────────────────────────────────────────────
export async function criarQuestao(req, res) {
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
        (conteudo_bruto, latex_formatado, tipo, nivel, ano, disciplina, imagem_base64, alternativas_json, correta, tags, criada_em, atualizada_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
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
        tags || ""
      ]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error("Erro ao criar questão:", err);
    res.status(500).json({ message: "Erro ao salvar questão." });
  }
}

// ──────────────────────────────────────────────────────────────
// 4) PUT /questoes/:id → Atualiza questão
// ──────────────────────────────────────────────────────────────
export async function atualizarQuestao(req, res) {
  const { id } = req.params;
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
       WHERE id = ?`,
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
        id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Questão não encontrada." });
    }

    res.status(200).json({ message: "Questão atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar questão:", err);
    res.status(500).json({ message: "Erro ao atualizar questão." });
  }
}

// ──────────────────────────────────────────────────────────────
// 5) DELETE /questoes/:id → Remove uma questão do banco
// ──────────────────────────────────────────────────────────────
export async function excluirQuestao(req, res) {
  const { id } = req.params;
  try {
    const [result] = await pool.query("DELETE FROM questoes WHERE id = ?", [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Questão não encontrada." });
    }
    res.status(204).end();
  } catch (err) {
    console.error("Erro ao excluir questão:", err);
    res.status(500).json({ message: "Erro ao excluir questão." });
  }
}


// ──────────────────────────────────────────────────────────────
// 6) Criar questões a partir de texto puro – texto extraído (OCR ou PDF)
// ──────────────────────────────────────────────────────────────
export async function criarQuestoesPorTexto(req, res) {
  try {
    const { texto } = req.body;
    if (!texto) {
      return res.status(400).json({ error: "Campo 'texto' é obrigatório" });
    }

    // 1) Quebra em blocos de questão (aqui, duplo newline)
    const blocos = texto
      .split("\n\n")
      .map(b => b.trim())
      .filter(b => b);

    // 2) Para cada bloco, parseia enunciado e alternativasco
    const criadas = [];
    for (const bloco of blocos) {



    // 2.1) Quebra em linhas
       const linhas = bloco.split("\n").map(l => l.trim()).filter(l => l);
 
       // 2.2) Linha 0 é o enunciado bruto
       let enunciado = linhas[0];
 
       // 2.3) Extrair metadados opcionais no formato [Disciplina – Ano]
       let disciplina = null, ano = null;
       const metaMatch = enunciado.match(/^\[(.+?)\]/);
       if (metaMatch) {
         const [disc, year] = metaMatch[1].split(/[-–]/).map(s => s.trim());
         disciplina = disc;
         ano         = year || null;
         // remover esse trecho do enunciado
         enunciado = enunciado.replace(/^\[.+?\]\s*/, "");
       }
 




       // 2.4) Demais linhas que começam com "(X)" são alternativas
       const alternativasArray = linhas
         .slice(1)
         .filter(l => /^\([A-Z]\)/.test(l))
         .map(l => ({
           letra: l.match(/^\(([A-Z])\)/)[1],
           texto: l.replace(/^\([A-Z]\)\s*/, "")
         }));
 



    
       const alternativas_json = JSON.stringify(alternativasArray);
 




       // 2.5) Montar o LaTeX formatado
     const latexLinhas = [];
     latexLinhas.push("\\begin{question}");
     // enunciado em negrito
     latexLinhas.push(`\\textbf{${enunciado}}`);
     latexLinhas.push(""); // quebra de linha no LaTeX
     // cada alternativa em sua própria linha
     alternativasArray.forEach(({ letra, texto }) => {
       latexLinhas.push(`(${letra}) ${texto}  `);
     });
     latexLinhas.push("\\end{question}");
     const latex_formatado = latexLinhas.join("\n");
 
     // 2.6) Inserir no banco incluindo o latex gerado
     const dados = {
       conteudo_bruto: bloco,
       latex_formatado,
       disciplina,
       ano,
       alternativas_json
     };


     // DEBUG: veja o que está chegando aqui
     console.log("▶️ Dados antes de criarQuestao:", dados);
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
