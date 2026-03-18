import express from "express";
import pool from "../db.js";

const router = express.Router();

/** Converte ISO timestamp (ex: '2026-02-23T03:00:00.000Z') para DATE 'YYYY-MM-DD' */
function toDateOnly(val) {
  if (!val) return null;
  const s = String(val).trim();
  // Já está no formato YYYY-MM-DD?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO ou datetime — extrai apenas a parte date
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

/**
 * 1) GET /api/avaliacoes
 * Busca todos os planos de avaliação de uma escola, opcionalmente filtrando por ano, disciplina, bimestre.
 */
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { ano, disciplina, bimestre } = req.query;

    let sql = `SELECT * FROM planos_avaliacao WHERE escola_id = ?`;
    const params = [escola_id];

    if (ano) {
      sql += ` AND ano = ?`;
      params.push(ano);
    }
    if (disciplina) {
      sql += ` AND disciplina = ?`;
      params.push(disciplina);
    }
    if (bimestre) {
      sql += ` AND bimestre = ?`;
      params.push(bimestre);
    }

    const [planos] = await pool.query(sql, params);
    return res.json(planos);
  } catch (error) {
    console.error("Erro ao listar planos:", error);
    return res.status(500).json({ error: "Erro interno do servidor." });
  }
});

/**
 * 2) GET /api/avaliacoes/solicitacoes/pendentes
 * Lista todos os PAPs com status ENVIADO (pendentes de aprovação pela Direção)
 * IMPORTANTE: esta rota DEVE vir antes de /:id para não ser capturada como parâmetro
 */
router.get("/solicitacoes/pendentes", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = req.query.ano || new Date().getFullYear();

    const [planos] = await pool.query(
      `SELECT
         pa.id,
         pa.disciplina,
         pa.bimestre,
         pa.turmas,
         pa.ano,
         pa.status,
         pa.nome_codigo,
         pa.usuario_id,
         pa.created_at,
         pa.updated_at,
         u.nome AS professor_nome,
         (SELECT p.foto FROM professores p
          WHERE p.cpf = u.cpf AND p.escola_id = pa.escola_id
          LIMIT 1) AS professor_foto
       FROM planos_avaliacao pa
       LEFT JOIN usuarios u ON u.id = pa.usuario_id
       WHERE pa.escola_id = ?
         AND pa.ano = ?
         AND pa.status = 'ENVIADO'
       ORDER BY pa.updated_at DESC`,
      [escola_id, ano]
    );

    return res.json({ ok: true, solicitacoes: planos });
  } catch (error) {
    console.error("Erro ao listar solicitações pendentes:", error);
    return res.status(500).json({ ok: false, error: "Erro interno do servidor." });
  }
});

/**
 * 3) GET /api/avaliacoes/:id
 * Busca um plano específico e seus itens
 */
router.get("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const [[plano]] = await pool.query(
      `SELECT * FROM planos_avaliacao WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    if (!plano) {
      return res.status(404).json({ error: "Plano não encontrado." });
    }

    const [itens] = await pool.query(
      `SELECT * FROM itens_avaliacao WHERE plano_id = ?`,
      [id]
    );

    plano.itens = itens;
    return res.json(plano);
  } catch (error) {
    console.error("Erro ao buscar plano:", error);
    return res.status(500).json({ error: "Erro interno do servidor." });
  }
});

/**
 * 3) POST /api/avaliacoes
 * Cria ou atualiza (Upsert) um Plano e seus respectivos Itens
 */
router.post("/", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { escola_id, usuario_id } = req.user;
    const {
      disciplina,
      bimestre,
      turmas,
      ano = anoLetivoPadrao(),
      nome_codigo,
      status = "RASCUNHO",
      itens = []
    } = req.body;

    // Vai desmembrar as turmas em planos individuais
    const turmasArray = Array.isArray(turmas) ? turmas : turmas.split("-");
    const planoIds = [];

    for (const turmaUnica of turmasArray) {
      let planoId;

      // Busca se já existe o plano especificamente para essa turma
      const [[existente]] = await conn.query(
        `SELECT id FROM planos_avaliacao 
         WHERE escola_id = ? AND ano = ? AND bimestre = ? AND disciplina = ? AND turmas = ?`,
        [escola_id, ano, bimestre, disciplina, turmaUnica]
      );

      // Cada turma recebe um nome de código individual
      const nomeCodigoIndividual = nome_codigo.replace(/-[UP]-/, `-U-`).replace("-BIM-P-", "-BIM-U-") + "-" + turmaUnica;

      if (existente) {
        planoId = existente.id;
        await conn.query(
          `UPDATE planos_avaliacao SET status = ?, nome_codigo = ?, usuario_id = ?, updated_at = NOW() WHERE id = ?`,
          [status, nomeCodigoIndividual, usuario_id, planoId]
        );
      } else {
        const [result] = await conn.query(
          `INSERT INTO planos_avaliacao 
            (escola_id, disciplina, bimestre, turmas, ano, status, nome_codigo, usuario_id) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [escola_id, disciplina, bimestre, turmaUnica, ano, status, nomeCodigoIndividual, usuario_id]
        );
        planoId = result.insertId;
      }

      planoIds.push(planoId);

      // Deleta os itens daquele plano específico e recria
      await conn.query(`DELETE FROM itens_avaliacao WHERE plano_id = ?`, [planoId]);

      if (itens && itens.length > 0) {
        const insertData = itens.map(i => [
          planoId,
          i.atividade,
          toDateOnly(i.data_inicio),
          toDateOnly(i.data_final),
          i.nota_total || 0,
          i.oportunidades || 1,
          i.nota_invertida || 0,
          i.descricao || null,
          i.fixo_direcao ? 1 : 0
        ]);

        await conn.query(
          `INSERT INTO itens_avaliacao 
           (plano_id, atividade, data_inicio, data_final, nota_total, oportunidades, nota_invertida, descricao, fixo_direcao)
           VALUES ?`,
          [insertData]
        );
      }
    }

    await conn.commit();
    return res.json({ success: true, plano_ids: planoIds });
  } catch (error) {
    await conn.rollback();
    console.error("Erro ao salvar plano:", error);
    return res.status(500).json({ error: "Erro ao salvar plano de avaliação." });
  } finally {
    conn.release();
  }
});



/**
 * 5) PATCH /api/avaliacoes/:id/status
 * A Direção/Coordenação altera o status de um PAP (APROVAR, DEVOLVER, etc.)
 * body: { status: "APROVADO" | "DEVOLVIDO" | "RASCUNHO", motivo?: string }
 */
router.patch("/:id/status", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;
    const { status, motivo } = req.body;

    const statusPermitidos = ["APROVADO", "DEVOLVIDO", "RASCUNHO"];
    if (!status || !statusPermitidos.includes(status)) {
      return res.status(400).json({ error: `Status inválido. Permitidos: ${statusPermitidos.join(", ")}` });
    }

    // Motivo é obrigatório quando devolve
    if (status === "DEVOLVIDO" && (!motivo || !motivo.trim())) {
      return res.status(400).json({ error: "O motivo da devolução é obrigatório." });
    }

    // Verifica se o plano pertence à escola
    const [[plano]] = await pool.query(
      `SELECT id, status AS status_atual FROM planos_avaliacao WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    if (!plano) {
      return res.status(404).json({ error: "Plano não encontrado." });
    }

    // Se aprovado → limpa motivo_devolucao; se devolvido → salva motivo
    const motivoValue = status === "DEVOLVIDO" ? motivo.trim() : null;

    await pool.query(
      `UPDATE planos_avaliacao SET status = ?, motivo_devolucao = ?, updated_at = NOW() WHERE id = ?`,
      [status, motivoValue, id]
    );

    return res.json({ ok: true, message: `Status alterado para ${status}.` });
  } catch (error) {
    console.error("Erro ao alterar status do plano:", error);
    return res.status(500).json({ ok: false, error: "Erro interno do servidor." });
  }
});

export default router;
