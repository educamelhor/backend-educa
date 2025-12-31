// api/routes/codigos.js

// ────────────────────────────────────────────────────────────────
// Imports
// ────────────────────────────────────────────────────────────────
import express from "express";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

// ────────────────────────────────────────────────────────────────
// Conexão com o MySQL (usando variáveis do .env)
// ────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// ────────────────────────────────────────────────────────────────
// Funções auxiliares de mapeamento
// ────────────────────────────────────────────────────────────────
function mapEtapa(etapa) {
  switch (etapa.toLowerCase()) {
    case "educação infantil":
    case "infantil":
      return "01";
    case "fundamental":
      return "02";
    case "médio":
    case "medio":
      return "03";
    case "técnico":
    case "tecnico":
      return "04";
    default:
      return "00";
  }
}

function mapTurno(turno) {
  switch (turno.toLowerCase()) {
    case "matutino":
      return "01";
    case "vespertino":
      return "02";
    case "noturno":
      return "03";
    case "integral":
      return "04";
    default:
      return "00";
  }
}

// ────────────────────────────────────────────────────────────────
// POST /api/codigos → Criação em lote de códigos
// ────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { tipo, disciplina_id, etapa, turno, quantidade } = req.body;

    if (!tipo || !disciplina_id || !etapa || !turno || !quantidade) {
      return res.status(400).json({ error: "Campos obrigatórios ausentes." });
    }

    // Busca o nome da disciplina a partir do ID
    const [disciplinaRows] = await pool.query(
      "SELECT nome FROM disciplinas WHERE id = ?",
      [disciplina_id]
    );

    if (disciplinaRows.length === 0) {
      return res.status(404).json({ error: "Disciplina não encontrada." });
    }

    const disciplinaNome = disciplinaRows[0].nome;
    const etapaCod = mapEtapa(etapa);
    const turnoCod = mapTurno(turno);

    // Prefixo das 4 primeiras letras da disciplina
    const prefixoDisc = disciplinaNome
      .substring(0, 4)
      .toUpperCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, ""); // remove acentos

    // ────────────────────────────────────────────────
    // Descobre o último sequencial já existente para esta combinação
    // ────────────────────────────────────────────────
    const [rows] = await pool.query(
      `SELECT MAX(CAST(sequencial AS UNSIGNED)) AS ultimoSequencial
       FROM codigos
       WHERE disciplina_id = ? AND etapa = ? AND turno = ? AND tipo = ?`,
      [disciplina_id, etapa, turno, tipo]
    );

    let ultimoSequencial = rows[0]?.ultimoSequencial || 0;

    // ────────────────────────────────────────────────
    // Geração dos novos códigos em sequência
    // ────────────────────────────────────────────────
    const codigosGerados = [];
    const valoresInsert = [];

    for (let i = 1; i <= quantidade; i++) {
      const sequencialNum = ultimoSequencial + i;
      const sequencial = String(sequencialNum).padStart(2, "0");

      const codigoFinal = `${prefixoDisc}${etapaCod}${turnoCod}${sequencial}`;

      codigosGerados.push(codigoFinal);

      valoresInsert.push([
        codigoFinal, // codigo
        prefixoDisc, // prefixo
        sequencial,  // sequencial
        tipo,        // tipo
        disciplina_id, // disciplina_id
        etapa,       // etapa
        turno,       // turno
        quantidade,  // quantidade
        "ativo",     // status
        1,           // escola_id (fixo por enquanto)
        new Date(),  // created_at
        new Date(),  // updated_at
      ]);
    }

    // Inserção múltipla
    await pool.query(
      `INSERT INTO codigos 
        (codigo, prefixo, sequencial, tipo, disciplina_id, etapa, turno, quantidade, status, escola_id, created_at, updated_at) 
       VALUES ?`,
      [valoresInsert]
    );

    res.json({ success: true, codigos: codigosGerados });
  } catch (err) {
    console.error("Erro ao salvar códigos:", err);
    res.status(500).json({ error: "Erro ao salvar códigos." });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/codigos → Listar todos os códigos cadastrados (com disciplina)
// ────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
         c.id,
         c.codigo,
         c.tipo,
         c.etapa,
         c.turno,
         c.sequencial,
         c.status,
         c.created_at,
         c.updated_at,
         d.nome AS disciplina
       FROM codigos c
       LEFT JOIN disciplinas d ON c.disciplina_id = d.id
       ORDER BY c.id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar códigos:", err);
    res.status(500).json({ error: "Erro ao buscar códigos." });
  }
});

// ────────────────────────────────────────────────────────────────
// DELETE /api/codigos/:id → Excluir um código
// ────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query("DELETE FROM codigos WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Código não encontrado." });
    }

    res.json({ success: true, message: "Código excluído com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir código:", err);
    res.status(500).json({ error: "Erro ao excluir código." });
  }
});

// ────────────────────────────────────────────────────────────────
// Exporta o router
// ────────────────────────────────────────────────────────────────
export default router;
