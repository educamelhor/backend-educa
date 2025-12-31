// api/models/questaoModel.js
import pool from "../db.js";

// Buscar todas as questões da escola
export async function listarTodasQuestoes(escola_id) {
  const [rows] = await pool.query(
    "SELECT * FROM questoes WHERE escola_id = ? ORDER BY id DESC",
    [escola_id]
  );
  return rows;
}

// Buscar uma questão pelo ID (da escola)
export async function buscarQuestaoPorId(id, escola_id) {
  const [[row]] = await pool.query(
    "SELECT * FROM questoes WHERE id = ? AND escola_id = ?",
    [id, escola_id]
  );
  return row;
}

// Criar nova questão vinculada à escola
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
    tags,
    escola_id
  } = dados;

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

  return result.insertId;
}

// Atualizar questão existente da escola
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
    tags,
    escola_id
  } = dados;

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

  return result.affectedRows;
}

// Excluir questão da escola
export async function excluirQuestao(id, escola_id) {
  const [result] = await pool.query(
    "DELETE FROM questoes WHERE id = ? AND escola_id = ?",
    [id, escola_id]
  );
  return result.affectedRows;
}
