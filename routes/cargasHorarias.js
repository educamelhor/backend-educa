// api/routes/cargasHorarias.js
// ============================================================================
// Cargas Horárias por Turma
// - Todas as rotas exigem usuário autenticado com req.user.escola_id
// - GET: lista as cargas já definidas para uma turma (somente da escola do login)
// - POST /definir: substitui a definição inteira da turma, em transação
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

// ----------------------------------------------------------------------------
// Middleware: garante presença de req.user.escola_id (escola do login)
// ----------------------------------------------------------------------------
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

// ----------------------------------------------------------------------------
// GET /api/cargas-horarias?turma_id=123
// Lista cargas da turma, restrito à escola do login
// ----------------------------------------------------------------------------
router.get("/", verificarEscola, async (req, res) => {
  try {
    const { turma_id } = req.query;
    const { escola_id } = req.user;

    if (!turma_id) {
      return res.status(400).json({ message: "turma_id é obrigatório" });
    }

    const [rows] = await pool.query(
      `SELECT
         tc.id,
         tc.escola_id,
         tc.turma_id,
         tc.disciplina_id,
         tc.carga,
         d.nome AS disciplina_nome
       FROM turma_cargas tc
       JOIN disciplinas d ON d.id = tc.disciplina_id
      WHERE tc.turma_id = ?
        AND tc.escola_id = ?
      ORDER BY d.nome`,
      [turma_id, escola_id]
    );

    const total = rows.reduce((acc, r) => acc + (Number(r.carga) || 0), 0);
    return res.status(200).json({ itens: rows, totalCarga: total });
  } catch (err) {
    console.error("Erro ao listar cargas da turma:", err);
    return res.status(500).json({ message: "Não foi possível carregar as cargas da turma." });
  }
});

// ----------------------------------------------------------------------------
// POST /api/cargas-horarias/definir
// Body:
// {
//   turma_id: number,
//   itens: (string[] | number[]) // lista de disciplina_id selecionadas
// }
// Regras:
// - Ignora escola_id do body (se houver). Usa sempre req.user.escola_id.
// - Apaga definição anterior da turma (da escola do login) e insere a nova.
// - Carga é lida da tabela 'disciplinas' (campo 'carga').
// ----------------------------------------------------------------------------
router.post("/definir", verificarEscola, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { turma_id, itens } = req.body;
    const { escola_id } = req.user;

    if (!turma_id || !Array.isArray(itens)) {
      return res.status(400).json({ message: "turma_id e itens são obrigatórios." });
    }

    await conn.beginTransaction();

    // Exclui definição anterior da turma (apenas da escola do usuário)
    await conn.query(
      "DELETE FROM turma_cargas WHERE turma_id = ? AND escola_id = ?",
      [turma_id, escola_id]
    );

    if (itens.length > 0) {
      // Busca as disciplinas selecionadas *desta escola* e suas cargas
      const placeholders = itens.map(() => "?").join(",");
      const params = [escola_id, ...itens];

      const [disciplinas] = await conn.query(
        `SELECT id, (carga + 0) AS carga
           FROM disciplinas
          WHERE escola_id = ?
            AND id IN (${placeholders})`,
        params
      );

      // Monta valores para insert em massa
      const valores = disciplinas.map((d) => [
        escola_id,
        turma_id,
        d.id,
        Number(d.carga) || 0,
      ]);

      if (valores.length > 0) {
        await conn.query(
          "INSERT INTO turma_cargas (escola_id, turma_id, disciplina_id, carga) VALUES ?",
          [valores]
        );
      }
    }

    // Retorna o que ficou salvo
    const [rows] = await conn.query(
      `SELECT
         tc.id,
         tc.escola_id,
         tc.turma_id,
         tc.disciplina_id,
         tc.carga,
         d.nome AS disciplina_nome
       FROM turma_cargas tc
       JOIN disciplinas d ON d.id = tc.disciplina_id
      WHERE tc.turma_id = ?
        AND tc.escola_id = ?
      ORDER BY d.nome`,
      [turma_id, escola_id]
    );

    await conn.commit();

    const total = rows.reduce((acc, r) => acc + (Number(r.carga) || 0), 0);
    return res.status(200).json({ ok: true, itens: rows, totalCarga: total });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error("Erro ao definir cargas da turma:", err);
    return res.status(500).json({ message: "Não foi possível salvar as cargas da turma." });
  } finally {
    try { conn.release(); } catch {}
  }
});

export default router;
