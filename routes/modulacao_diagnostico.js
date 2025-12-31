// api/routes/horarios_diagnostico.js
// ============================================================================
// Diagnóstico de Insumos para Geração de Horários (por Turno)
// - Consolida DEMANDA (turmas + turma_cargas) x OFERTA (professores ativos)
// - Filtro obrigatório por req.user.escola_id
// - GET /api/horarios/diagnostico?turno=Matutino
//   • Retorna, por disciplina do turno: carga_necessaria, aulas_ofertadas, professores_ativos, gap
//   • Inclui detalhamento por turma (para auditoria)
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

// ----------------------------------------------------------------------------
// Middleware: exige escola no usuário logado
// ----------------------------------------------------------------------------
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

// ----------------------------------------------------------------------------
// GET /api/horarios/diagnostico?turno=Matutino
// ----------------------------------------------------------------------------
router.get("/diagnostico", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const turno = (req.query.turno || "").trim();

    if (!turno) {
      return res.status(400).json({ message: "Parâmetro 'turno' é obrigatório." });
    }

    // 1) DEMANDA: soma das cargas das disciplinas definidas em turma_cargas
    //    para as turmas da escola e do turno informado.
    const [demandaRows] = await pool.query(
      `
      SELECT
        tc.disciplina_id,
        d.nome AS disciplina_nome,
        SUM(tc.carga + 0) AS carga_necessaria
      FROM turma_cargas tc
      JOIN turmas t       ON t.id = tc.turma_id
      JOIN disciplinas d  ON d.id = tc.disciplina_id
      WHERE tc.escola_id = ?
        AND t.escola_id  = ?
        AND d.escola_id  = ?
        AND t.turno = ?
      GROUP BY tc.disciplina_id, d.nome
      ORDER BY d.nome
      `,
      [escola_id, escola_id, escola_id, turno]
    );

    // 2) OFERTA: professores ATIVOS nesse turno (por disciplina)
    //    soma de aulas + contagem de professores.
    const [ofertaRows] = await pool.query(
      `
      SELECT
        p.disciplina_id,
        COUNT(*) AS professores_ativos,
        SUM(p.aulas + 0) AS aulas_ofertadas
      FROM professores p
      WHERE p.escola_id = ?
        AND p.status = 'ativo'
        AND p.turno = ?
        AND p.disciplina_id IS NOT NULL
      GROUP BY p.disciplina_id
      `,
      [escola_id, turno]
    );

    // Indexar oferta por disciplina_id para merge rápido
    const ofertaMap = new Map();
    for (const r of ofertaRows) {
      ofertaMap.set(Number(r.disciplina_id), {
        professores_ativos: Number(r.professores_ativos) || 0,
        aulas_ofertadas: Number(r.aulas_ofertadas) || 0,
      });
    }

    // 3) Construir o checklist por disciplina (inclui as que tenham só demanda;
    //    se desejar, também podemos trazer disciplinas com oferta mas sem demanda).
    const checklist = demandaRows.map((d) => {
      const oferta = ofertaMap.get(Number(d.disciplina_id)) || {
        professores_ativos: 0,
        aulas_ofertadas: 0,
      };
      const carga_necessaria = Number(d.carga_necessaria) || 0;
      const aulas_ofertadas = Number(oferta.aulas_ofertadas) || 0;

      const gap = aulas_ofertadas - carga_necessaria; // >0 sobra, <0 déficit
      const situacao =
        gap === 0 ? "OK"
        : gap > 0 ? `SOBRA ${gap}`
        : `DÉFICIT ${Math.abs(gap)}`;

      return {
        disciplina_id: Number(d.disciplina_id),
        disciplina_nome: d.disciplina_nome,
        carga_necessaria,
        professores_ativos: Number(oferta.professores_ativos) || 0,
        aulas_ofertadas,
        gap,
        situacao,
      };
    });

    // 4) Detalhamento por turma (auditoria): quanto cada turma do turno exige por disciplina
    const [detalheTurmas] = await pool.query(
      `
      SELECT
        t.id       AS turma_id,
        t.nome     AS turma_nome,
        t.turno,
        d.id       AS disciplina_id,
        d.nome     AS disciplina_nome,
        (tc.carga + 0) AS carga
      FROM turma_cargas tc
      JOIN turmas t       ON t.id = tc.turma_id
      JOIN disciplinas d  ON d.id = tc.disciplina_id
      WHERE tc.escola_id = ?
        AND t.escola_id  = ?
        AND d.escola_id  = ?
        AND t.turno = ?
      ORDER BY t.nome, d.nome
      `,
      [escola_id, escola_id, escola_id, turno]
    );

    return res.json({
      turno,
      resumo_por_disciplina: checklist,
      detalhe_por_turma: detalheTurmas,
    });
  } catch (err) {
    console.error("Erro no diagnóstico de horários:", err);
    res.status(500).json({ message: "Erro ao gerar diagnóstico." });
  }
});

export default router;
