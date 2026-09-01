import express from "express";
import pool from "../db.js";

const router = express.Router();

// [POST] /api/aph - Registra um novo atendimento pré-hospitalar
router.post("/", async (req, res) => {
  const {
    aluno_id,
    escola_id,
    local,
    solicitante,
    motivos,
    relato,
    condicao_geral,
    sinais,
    atendimentos,
    descricao_atendimento,
    materiais,
    outro_material,
    desfecho,
    comunicacao_resp,
    hora_comunicacao,
    hora_comparecimento,
    sinais_pa,
    sinais_fc,
    sinais_temperatura,
    desfecho_detalhes,
  } = req.body;

  const usuario_id = req.user?.usuario_id || req.user?.id || req.user?.usuarioId;
  let socorrista_nome = "Sistema";

  try {
    if (usuario_id) {
      const [uRows] = await pool.query("SELECT nome FROM usuarios WHERE id = ?", [usuario_id]);
      if (uRows && uRows.length > 0) {
        socorrista_nome = uRows[0].nome;
      }
    }

    const [result] = await pool.query(
      `INSERT INTO aph_atendimentos 
        (aluno_id, escola_id, local, solicitante, motivos, relato, condicao_geral, sinais, atendimentos, descricao_atendimento, materiais, outro_material, desfecho, comunicacao_resp, hora_comunicacao, hora_comparecimento, socorrista_nome, sinais_pa, sinais_fc, sinais_temperatura, desfecho_detalhes) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        aluno_id,
        escola_id || 1, // fallback
        local || "",
        solicitante || "",
        JSON.stringify(motivos || []),
        relato || "",
        condicao_geral || "",
        JSON.stringify(sinais || []),
        JSON.stringify(atendimentos || []),
        descricao_atendimento || "",
        JSON.stringify(materiais || []),
        outro_material || "",
        desfecho || "",
        comunicacao_resp || "",
        hora_comunicacao || null,
        hora_comparecimento || null,
        socorrista_nome,
        sinais_pa || null,
        sinais_fc || null,
        sinais_temperatura || null,
        desfecho_detalhes || null
      ]
    );

    const insertedId = result.insertId;
    const ano = new Date().getFullYear();
    const numeroStr = String(insertedId).padStart(4, '0');
    const numero_atendimento = `APH-${ano}-${numeroStr}`;

    await pool.query(
      `UPDATE aph_atendimentos SET numero_atendimento = ? WHERE id = ?`,
      [numero_atendimento, insertedId]
    );

    res.status(201).json({ 
      success: true, 
      id: insertedId, 
      numero_atendimento,
      message: "Atendimento APH registrado com sucesso." 
    });
  } catch (error) {
    console.error("[APH] Erro ao salvar atendimento:", error);
    res.status(500).json({ error: "Erro interno ao registrar atendimento." });
  }
});

// [GET] /api/aph/historico/:aluno_id - Busca o histórico de um aluno (filtrado por escola)
router.get("/historico/:aluno_id", async (req, res) => {
  const { aluno_id } = req.params;
  const escola_id = req.user?.escola_id;

  try {
    const [rows] = await pool.query(
      `SELECT * FROM aph_atendimentos WHERE aluno_id = ? AND escola_id = ? ORDER BY data_ocorrencia DESC`,
      [aluno_id, escola_id]
    );
    res.status(200).json(rows);
  } catch (error) {
    console.error("[APH] Erro ao buscar histórico:", error);
    res.status(500).json({ error: "Erro interno ao buscar histórico." });
  }
});

// [GET] /api/aph/escola - Lista todos os atendimentos da escola com filtros opcionais
router.get("/escola", async (req, res) => {
  const escola_id = req.user?.escola_id;
  const { data_inicio, data_fim, limit = 50, offset = 0, turma_id, motivo, aluno_nome } = req.query;

  try {
    let sql = `
      SELECT 
        a.*,
        al.estudante AS aluno_nome,
        al.codigo AS aluno_matricula,
        al.foto AS aluno_foto,
        t.nome AS turma_nome,
        t.id AS turma_id
      FROM aph_atendimentos a
      LEFT JOIN alunos al ON al.id = a.aluno_id
      LEFT JOIN matriculas m ON m.aluno_id = a.aluno_id AND m.escola_id = a.escola_id AND m.ano_letivo = YEAR(a.data_ocorrencia)
      LEFT JOIN turmas t ON t.id = m.turma_id
      WHERE a.escola_id = ?
    `;
    const params = [escola_id];

    if (data_inicio) { sql += ` AND DATE(a.data_ocorrencia) >= ?`; params.push(data_inicio); }
    if (data_fim)    { sql += ` AND DATE(a.data_ocorrencia) <= ?`; params.push(data_fim); }
    if (turma_id)    { sql += ` AND m.turma_id = ?`; params.push(Number(turma_id)); }
    if (motivo)      { sql += ` AND JSON_CONTAINS(a.motivos, JSON_QUOTE(?))`; params.push(motivo); }
    if (aluno_nome)  { sql += ` AND al.estudante LIKE ?`; params.push(`%${aluno_nome}%`); }

    sql += ` ORDER BY a.data_ocorrencia DESC LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    const [rows] = await pool.query(sql, params);
    res.status(200).json({ success: true, atendimentos: rows, total: rows.length });
  } catch (error) {
    console.error("[APH] Erro ao buscar atendimentos da escola:", error);
    res.status(500).json({ error: "Erro interno ao buscar atendimentos." });
  }
});

// [GET] /api/aph/materiais - Agrega materiais (atendimentos) mais usados na escola
router.get("/materiais", async (req, res) => {
  const escola_id = req.query.escola_id || 1;

  try {
    const [rows] = await pool.query(
      `SELECT atendimentos FROM aph_atendimentos WHERE escola_id = ?`,
      [escola_id]
    );

    // Contabiliza cada item que está dentro do JSON 'atendimentos'
    const contagem = {};
    rows.forEach(row => {
      let items = [];
      try {
        items = typeof row.atendimentos === 'string' ? JSON.parse(row.atendimentos) : row.atendimentos;
      } catch (e) {
        items = [];
      }
      
      if (Array.isArray(items)) {
        items.forEach(item => {
          contagem[item] = (contagem[item] || 0) + 1;
        });
      }
    });

    res.status(200).json({ success: true, materiais: contagem });
  } catch (error) {
    console.error("[APH] Erro ao agregar materiais:", error);
    res.status(500).json({ error: "Erro interno ao buscar materiais." });
  }
});

export default router;
