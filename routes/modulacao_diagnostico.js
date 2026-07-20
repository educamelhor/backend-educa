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

    // Ano letivo atual (janeiro ainda pertence ao ano anterior)
    const hoje = new Date();
    const anoAtual = hoje.getMonth() === 0 ? hoje.getFullYear() - 1 : hoje.getFullYear();

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
        AND t.ano   = ?
      GROUP BY tc.disciplina_id, d.nome
      ORDER BY d.nome
      `,
      [escola_id, escola_id, escola_id, turno, anoAtual]
    );

    // 2) OFERTA: professores ATIVOS nesse turno (por disciplina)
    //    soma de aulas + contagem de professores.
    //    NOVO MODELO: baseia-se em professor_vinculos.
    const [ofertaRows] = await pool.query(
      `
      SELECT
        pv.disciplina_id,
        COUNT(DISTINCT pv.professor_id) AS professores_ativos,
        SUM(pv.aulas + 0) AS aulas_ofertadas
      FROM professor_vinculos pv
      JOIN professores p ON p.id = pv.professor_id
      WHERE pv.escola_id = ?
        AND p.status != 'inativo'
        AND LOWER(pv.turno) = LOWER(?)
      GROUP BY pv.disciplina_id
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
        AND t.ano   = ?
      ORDER BY t.nome, d.nome
      `,
      [escola_id, escola_id, escola_id, turno, anoAtual]
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

// ============================================================================
// GET /api/modulacao/diagnostico/disponibilidade?turno=Matutino
// Cruza carga modulada (aulas que o professor deve dar) com os slots livres
// cadastrados na grade_disponibilidades pela direção.
// Retorna: professores com conflito (aulas > slots), ok e sem disponibilidade.
// ============================================================================
router.get("/diagnostico/disponibilidade", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const turno = (req.query.turno || "").trim();

    if (!turno) {
      return res.status(400).json({ message: "Parâmetro 'turno' é obrigatório." });
    }

    // Ano letivo atual
    const hoje = new Date();
    const anoAtual = hoje.getMonth() === 0 ? hoje.getFullYear() - 1 : hoje.getFullYear();

    // 1) Carga modulada por professor neste turno
    //    (soma de modulacao.aulas para turmas do turno)
    const [modulados] = await pool.query(
      `SELECT
         m.professor_id,
         p.nome              AS professor_nome,
         d.nome              AS disciplina_nome,
         COUNT(DISTINCT m.turma_id) AS turmas_count,
         SUM(m.aulas)               AS aulas_moduladas
       FROM modulacao m
       JOIN turmas t       ON t.id = m.turma_id AND t.escola_id = m.escola_id
       JOIN professores p  ON p.id = m.professor_id
       JOIN disciplinas d  ON d.id = m.disciplina_id
       WHERE m.escola_id = ?
         AND LOWER(t.turno) = LOWER(?)
         AND t.ano = ?
       GROUP BY m.professor_id, p.nome, d.nome
       ORDER BY p.nome`,
      [escola_id, turno, anoAtual]
    );

    // 2) Slots livres por professor neste turno
    //    Usa JSON_TABLE para expandir o JSON de periodos e contar status='livre'
    const [dispRows] = await pool.query(
      `SELECT
         gd.professor_id,
         COUNT(*) AS slots_livres
       FROM grade_disponibilidades gd,
         JSON_TABLE(
           gd.periodos,
           '$[*]' COLUMNS (status VARCHAR(20) PATH '$.status')
         ) AS jt
       WHERE gd.escola_id = ?
         AND gd.turno = LOWER(?)
         AND jt.status = 'livre'
       GROUP BY gd.professor_id`,
      [escola_id, turno]
    );

    // 3) Professores que têm disponibilidade cadastrada (qualquer status)
    const [comDisp] = await pool.query(
      `SELECT DISTINCT professor_id
       FROM grade_disponibilidades
       WHERE escola_id = ? AND turno = LOWER(?)`,
      [escola_id, turno]
    );
    const idsComDisp = new Set(comDisp.map((r) => Number(r.professor_id)));

    // Indexar slots por professor_id
    const slotsMap = new Map();
    for (const r of dispRows) {
      slotsMap.set(Number(r.professor_id), Number(r.slots_livres) || 0);
    }

    const conflitos = [];
    const ok = [];
    const semDisponibilidade = [];

    for (const prof of modulados) {
      const pid = Number(prof.professor_id);
      const aulasMod = Number(prof.aulas_moduladas) || 0;

      if (!idsComDisp.has(pid)) {
        semDisponibilidade.push({
          professor_id: pid,
          professor_nome: prof.professor_nome,
          disciplina_nome: prof.disciplina_nome,
          turmas_count: Number(prof.turmas_count),
          aulas_moduladas: aulasMod,
          slots_livres: null,
          deficit_slots: null,
          severidade: "SEM_DISPONIBILIDADE",
        });
        continue;
      }

      const slotsLivres = slotsMap.get(pid) ?? 0;
      const deficitSlots = slotsLivres - aulasMod; // negativo = conflito

      const entry = {
        professor_id: pid,
        professor_nome: prof.professor_nome,
        disciplina_nome: prof.disciplina_nome,
        turmas_count: Number(prof.turmas_count),
        aulas_moduladas: aulasMod,
        slots_livres: slotsLivres,
        deficit_slots: deficitSlots,
        severidade: deficitSlots < 0
          ? (Math.abs(deficitSlots) >= 5 ? "CRITICO" : "ATENCAO")
          : "OK",
      };

      if (deficitSlots < 0) {
        conflitos.push(entry);
      } else {
        ok.push(entry);
      }
    }

    // Ordena conflitos mais graves primeiro
    conflitos.sort((a, b) => a.deficit_slots - b.deficit_slots);

    return res.json({
      turno,
      total_modulados: modulados.length,
      conflitos,
      ok,
      sem_disponibilidade: semDisponibilidade,
    });
  } catch (err) {
    console.error("Erro no diagnóstico de disponibilidade:", err);
    return res.status(500).json({ message: "Erro ao gerar diagnóstico de disponibilidade." });
  }
});

// ============================================================================
// GET /api/modulacao/diagnostico/turmas-descobertas?turno=Matutino
// Retorna turmas que têm disciplinas obrigatórias (turma_cargas) mas nenhum
// professor modulado (modulacao) para cobrir aquela disciplina.
// ============================================================================
router.get("/diagnostico/turmas-descobertas", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const turno = (req.query.turno || "").trim();

    if (!turno) {
      return res.status(400).json({ message: "Parâmetro 'turno' é obrigatório." });
    }

    // Ano letivo atual
    const hoje = new Date();
    const anoAtual = hoje.getMonth() === 0 ? hoje.getFullYear() - 1 : hoje.getFullYear();

    // Turmas × Disciplinas obrigatórias SEM professor modulado
    const [descobertas] = await pool.query(
      `SELECT
         t.id      AS turma_id,
         t.nome    AS turma_nome,
         t.turno,
         d.id      AS disciplina_id,
         d.nome    AS disciplina_nome,
         tc.carga
       FROM turma_cargas tc
       JOIN turmas t      ON t.id  = tc.turma_id  AND t.escola_id = tc.escola_id
       JOIN disciplinas d ON d.id  = tc.disciplina_id
       LEFT JOIN modulacao m
         ON  m.turma_id      = tc.turma_id
         AND m.disciplina_id = tc.disciplina_id
         AND m.escola_id     = tc.escola_id
       WHERE tc.escola_id  = ?
         AND LOWER(t.turno) = LOWER(?)
         AND t.ano = ?
         AND m.id IS NULL
       ORDER BY t.nome, d.nome`,
      [escola_id, turno, anoAtual]
    );

    // Totais para o score
    const [totaisTurmas] = await pool.query(
      `SELECT COUNT(DISTINCT tc.turma_id) AS total_turmas_com_carga
       FROM turma_cargas tc
       JOIN turmas t ON t.id = tc.turma_id AND t.escola_id = tc.escola_id
       WHERE tc.escola_id = ? AND LOWER(t.turno) = LOWER(?) AND t.ano = ?`,
      [escola_id, turno, anoAtual]
    );

    const [turmasDescobertasCount] = await pool.query(
      `SELECT COUNT(DISTINCT tc.turma_id) AS turmas_com_gap
       FROM turma_cargas tc
       JOIN turmas t ON t.id = tc.turma_id AND t.escola_id = tc.escola_id
       LEFT JOIN modulacao m
         ON  m.turma_id      = tc.turma_id
         AND m.disciplina_id = tc.disciplina_id
         AND m.escola_id     = tc.escola_id
       WHERE tc.escola_id  = ?
         AND LOWER(t.turno) = LOWER(?)
         AND t.ano = ?
         AND m.id IS NULL`,
      [escola_id, turno, anoAtual]
    );

    const totalTurmas = Number(totaisTurmas[0]?.total_turmas_com_carga) || 0;
    const turmasComGap = Number(turmasDescobertasCount[0]?.turmas_com_gap) || 0;
    const turmasCompletas = totalTurmas - turmasComGap;

    return res.json({
      turno,
      total_turmas: totalTurmas,
      turmas_completas: turmasCompletas,
      turmas_com_gap: turmasComGap,
      lacunas: descobertas,
    });
  } catch (err) {
    console.error("Erro no diagnóstico de turmas descobertas:", err);
    return res.status(500).json({ message: "Erro ao gerar diagnóstico de turmas descobertas." });
  }
});

export default router;

