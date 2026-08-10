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
    desfecho,
    comunicacao_resp,
  } = req.body;

  const socorrista_nome = req.user?.nome || "Sistema"; // Pega do token

  try {
    const [result] = await pool.query(
      `INSERT INTO aph_atendimentos 
        (aluno_id, escola_id, local, solicitante, motivos, relato, condicao_geral, sinais, atendimentos, descricao_atendimento, desfecho, comunicacao_resp, socorrista_nome) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        desfecho || "",
        comunicacao_resp || "",
        socorrista_nome
      ]
    );

    res.status(201).json({ success: true, id: result.insertId, message: "Atendimento APH registrado com sucesso." });
  } catch (error) {
    console.error("[APH] Erro ao salvar atendimento:", error);
    res.status(500).json({ error: "Erro interno ao registrar atendimento." });
  }
});

// [GET] /api/aph/historico/:aluno_id - Busca o histórico de um aluno
router.get("/historico/:aluno_id", async (req, res) => {
  const { aluno_id } = req.params;

  try {
    const [rows] = await pool.query(
      `SELECT * FROM aph_atendimentos WHERE aluno_id = ? ORDER BY data_ocorrencia DESC`,
      [aluno_id]
    );
    res.status(200).json(rows);
  } catch (error) {
    console.error("[APH] Erro ao buscar histórico:", error);
    res.status(500).json({ error: "Erro interno ao buscar histórico." });
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
