// api/models/questaoModel.js


import pool from "../db.js";

// Buscar todas as questões
export async function listarTodasQuestoes() {
  const [rows] = await pool.query("SELECT * FROM questoes ORDER BY id DESC");
  return rows;
}

// Buscar uma questão pelo ID
export async function buscarQuestaoPorId(id) {
  const [[row]] = await pool.query("SELECT * FROM questoes WHERE id = ?", [id]);
  return row;
}

// Criar nova questão
export async function criarQuestao(dados) {
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
  } = dados;

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

  return result.insertId;
}

// Atualizar questão existente
export async function atualizarQuestao(id, dados) {
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
  } = dados;

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

  return result.affectedRows;
}

// Excluir questão
export async function excluirQuestao(id) {
  const [result] = await pool.query("DELETE FROM questoes WHERE id = ?", [id]);
  return result.affectedRows;
}
