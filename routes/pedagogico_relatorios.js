// routes/pedagogico_relatorios.js  (v2 — usa planos_avaliacao existente + breakdown por bimestre)
// ============================================================================
// GET /api/pedagogico/relatorios/plano-avaliacao
//   Retorna todos os professores em regência + seus planos reais (planos_avaliacao)
//   agrupados por bimestre.  Não usa a tabela plano_avaliacao vazia criada
//   anteriormente — usa a tabela real onde os professores já enviaram planos.
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

function anoLetivoAtual() {
  const hoje = new Date();
  return hoje.getMonth() === 0 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// Ordem de "gravidade" para status (quanto maior, pior)
const STATUS_RANK = {
  PENDENTE:             0,
  APROVADO:             1,
  LIBERADO:             2,
  RASCUNHO:             3,
  LIBERACAO_SOLICITADA: 4,
  DEVOLVIDO:            5,
  ENVIADO:              6, // pendente de aprovação = mais urgente
};

function statusGeral(planos) {
  if (!planos || planos.length === 0) return "PENDENTE";
  // Retorna o status de maior urgência ("pior")
  return planos.reduce((acc, p) => {
    return (STATUS_RANK[p.status] ?? 0) > (STATUS_RANK[acc] ?? 0) ? p.status : acc;
  }, planos[0].status);
}

// ---------------------------------------------------------------------------
// GET /api/pedagogico/relatorios/plano-avaliacao
// ---------------------------------------------------------------------------
router.get("/plano-avaliacao", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = Number(req.query.ano) || anoLetivoAtual();

    // ── Professores em regência + planos reais ────────────────────────────
    // JOIN via CPF normalizado: professores.cpf ↔ usuarios.cpf → planos_avaliacao.usuario_id
    const [rows] = await pool.query(
      `SELECT
         p.id   AS professor_id,
         p.nome,
         p.foto,
         pa.id               AS plano_id,
         pa.bimestre,
         pa.disciplina,
         pa.turmas,
         pa.status,
         pa.motivo_devolucao,
         pa.updated_at       AS atualizado_em
       FROM professores p
       -- Localiza o usuario correspondente pelo CPF (normalizado)
       JOIN usuarios u
         ON REPLACE(REPLACE(u.cpf, '.', ''), '-', '') =
            REPLACE(REPLACE(p.cpf, '.', ''), '-', '')
       -- Planos do professor para esta escola e ano (LEFT JOIN = inclui sem planos)
       LEFT JOIN planos_avaliacao pa
         ON  pa.usuario_id = u.id
         AND pa.escola_id  = ?
         AND pa.ano        = ?
       WHERE p.escola_id = ?
         AND p.status    = 'ativo'
         -- Apenas professores em regência (modulação com turma no ano letivo)
         AND EXISTS (
           SELECT 1
           FROM modulacao m2
           JOIN turmas t2 ON t2.id = m2.turma_id
           WHERE m2.professor_id = p.id
             AND t2.escola_id = ?
             AND t2.ano       = ?
         )
       ORDER BY p.nome ASC, pa.bimestre ASC, pa.disciplina ASC, pa.turmas ASC`,
      [escola_id, ano, escola_id, escola_id, ano]
    );

    // ── Agrupar por professor ─────────────────────────────────────────────
    const professorMap = new Map();
    for (const row of rows) {
      if (!professorMap.has(row.professor_id)) {
        professorMap.set(row.professor_id, {
          professor_id: row.professor_id,
          nome:         row.nome,
          foto:         row.foto,
          planos:       [],
        });
      }
      if (row.plano_id) {
        professorMap.get(row.professor_id).planos.push({
          plano_id:         row.plano_id,
          bimestre:         row.bimestre,
          disciplina:       (row.disciplina || "").toUpperCase(),
          turmas:           row.turmas,
          status:           row.status,
          motivo_devolucao: row.motivo_devolucao,
          atualizado_em:    row.atualizado_em,
        });
      }
    }

    const professores = [...professorMap.values()];

    // ── KPI por bimestre ──────────────────────────────────────────────────
    const BIMESTRES = ["1º Bimestre", "2º Bimestre", "3º Bimestre", "4º Bimestre"];
    const kpi_bimestres = {};

    for (const bim of BIMESTRES) {
      const planosBim = professores.flatMap(p => p.planos.filter(pl => pl.bimestre === bim));
      const profComPlano = new Set(
        professores.filter(p => p.planos.some(pl => pl.bimestre === bim)).map(p => p.professor_id)
      );
      kpi_bimestres[bim] = {
        total_planos:           planosBim.length,
        professores_com_plano:  profComPlano.size,
        professores_sem_plano:  professores.length - profComPlano.size,
        aprovado:               planosBim.filter(pl => pl.status === "APROVADO").length,
        enviado:                planosBim.filter(pl => pl.status === "ENVIADO").length,
        rascunho:               planosBim.filter(pl => pl.status === "RASCUNHO").length,
        devolvido:              planosBim.filter(pl => pl.status === "DEVOLVIDO").length,
        liberacao:              planosBim.filter(pl => pl.status === "LIBERACAO_SOLICITADA").length,
        liberado:               planosBim.filter(pl => pl.status === "LIBERADO").length,
      };
    }

    const kpi = {
      total_professores: professores.length,
      bimestres: kpi_bimestres,
    };

    return res.json({ ok: true, ano, professores, kpi });
  } catch (err) {
    console.error("[pedagogico/relatorios] plano-avaliacao GET:", err);
    return res.status(500).json({ message: "Erro ao carregar relatório." });
  }
});

export default router;
