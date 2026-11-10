// api/routes/horarios_diagnostico.js
// ============================================================================
// Diagnóstico de Insumos para Geração de Horários (por Turno e Semestre Vigente)
// - Consolida DEMANDA (turmas + turma_cargas) x OFERTA (professores ativos)
// - Filtro obrigatório por req.user.escola_id
// - Resolve automaticamente o semestre vigente da escola quando não informado
// ============================================================================

import express from "express";
import pool from "../db.js";
import { resolverVigenciaLetiva } from "../utils/vigenciaHorariosHelper.js";

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

    const vigencia = await resolverVigenciaLetiva(escola_id, req.query.semestre);
    const semestre = vigencia.semestre_referencia;
    const anoAtual = vigencia.ano_letivo;

    // 1) DEMANDA: soma das cargas das disciplinas definidas em turma_cargas
    //    para as turmas da escola, turno e semestre vigente.
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
        AND LOWER(t.turno) = LOWER(?)
        AND t.ano   = ?
        AND (
          LOWER(COALESCE(t.regime, 'anual')) <> 'semestral'
          OR tc.semestre IS NULL
          OR tc.semestre = 0
          OR tc.semestre = ?
        )
      GROUP BY tc.disciplina_id, d.nome
      ORDER BY d.nome
      `,
      [escola_id, escola_id, escola_id, turno, anoAtual, semestre]
    );

    // 2) OFERTA: professores ATIVOS nesse turno e semestre (por disciplina)
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
        AND (pv.semestre IS NULL OR pv.semestre = 0 OR pv.semestre = ?)
      GROUP BY pv.disciplina_id
      `,
      [escola_id, turno, semestre]
    );

    // Indexar oferta por disciplina_id para merge rápido
    const ofertaMap = new Map();
    for (const r of ofertaRows) {
      ofertaMap.set(Number(r.disciplina_id), {
        professores_ativos: Number(r.professores_ativos) || 0,
        aulas_ofertadas: Number(r.aulas_ofertadas) || 0,
      });
    }

    // 3) Construir o checklist por disciplina
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
        t.regime,
        tc.semestre,
        d.id       AS disciplina_id,
        d.nome     AS disciplina_nome,
        (tc.carga + 0) AS carga
      FROM turma_cargas tc
      JOIN turmas t       ON t.id = tc.turma_id
      JOIN disciplinas d  ON d.id = tc.disciplina_id
      WHERE tc.escola_id = ?
        AND t.escola_id  = ?
        AND d.escola_id  = ?
        AND LOWER(t.turno) = LOWER(?)
        AND t.ano   = ?
        AND (
          LOWER(COALESCE(t.regime, 'anual')) <> 'semestral'
          OR tc.semestre IS NULL
          OR tc.semestre = 0
          OR tc.semestre = ?
        )
      ORDER BY t.nome, d.nome
      `,
      [escola_id, escola_id, escola_id, turno, anoAtual, semestre]
    );

    return res.json({
      turno,
      semestre,
      vigencia,
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
// Cruza carga modulada (aulas que o professor deve dar no semestre vigente)
// com os slots livres cadastrados na grade_disponibilidades pela direção.
// Retorna: professores com conflito (aulas > slots), ok e sem disponibilidade.
// ============================================================================
router.get("/diagnostico/disponibilidade", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const turno = (req.query.turno || "").trim();

    if (!turno) {
      return res.status(400).json({ message: "Parâmetro 'turno' é obrigatório." });
    }

    const vigencia = await resolverVigenciaLetiva(escola_id, req.query.semestre);
    const semestre = vigencia.semestre_referencia;
    const anoAtual = vigencia.ano_letivo;

    // 1) Carga modulada por professor neste turno e semestre vigente
    //    (soma de modulacao.aulas para turmas do turno, respeitando anualidade/semestralidade)
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
         AND (
           LOWER(COALESCE(t.regime, 'anual')) <> 'semestral'
           OR m.semestre IS NULL
           OR m.semestre = 0
           OR m.semestre = ?
           OR (
             NOT EXISTS (
               SELECT 1 FROM modulacao m2
               WHERE m2.escola_id = m.escola_id
                 AND m2.turma_id = m.turma_id
                 AND m2.disciplina_id = m.disciplina_id
                 AND m2.semestre = ?
             )
             AND EXISTS (
               SELECT 1 FROM professor_vinculos pv0
               WHERE pv0.professor_id = p.id
                 AND pv0.disciplina_id = m.disciplina_id
                 AND LOWER(pv0.turno) COLLATE utf8mb4_unicode_ci = LOWER(t.turno) COLLATE utf8mb4_unicode_ci
                 AND pv0.escola_id = p.escola_id
                 AND (pv0.semestre = 0 OR pv0.semestre IS NULL)
             )
             AND NOT EXISTS (
               SELECT 1 FROM professor_vinculos pvs
               WHERE pvs.professor_id = p.id
                 AND pvs.disciplina_id = m.disciplina_id
                 AND LOWER(pvs.turno) COLLATE utf8mb4_unicode_ci = LOWER(t.turno) COLLATE utf8mb4_unicode_ci
                 AND pvs.escola_id = p.escola_id
                 AND pvs.semestre IN (1, 2)
             )
           )
         )
       GROUP BY m.professor_id, p.nome, d.nome
       ORDER BY p.nome`,
      [escola_id, turno, anoAtual, semestre, semestre]
    );

    // 2) Slots livres por professor neste turno
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
      semestre,
      vigencia,
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
// Retorna turmas que têm disciplinas obrigatórias (turma_cargas) no semestre
// vigente mas nenhum professor modulado (modulacao / agrupamento_modulacao)
// para cobrir aquela disciplina.
// ============================================================================
router.get("/diagnostico/turmas-descobertas", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const turno = (req.query.turno || "").trim();

    if (!turno) {
      return res.status(400).json({ message: "Parâmetro 'turno' é obrigatório." });
    }

    const vigencia = await resolverVigenciaLetiva(escola_id, req.query.semestre);
    const semestre = vigencia.semestre_referencia;
    const anoAtual = vigencia.ano_letivo;

    // Turmas × Disciplinas obrigatórias no semestre vigente SEM professor modulado
    const [descobertas] = await pool.query(
      `SELECT
         t.id      AS turma_id,
         t.nome    AS turma_nome,
         t.turno,
         t.regime,
         tc.semestre,
         d.id      AS disciplina_id,
         d.nome    AS disciplina_nome,
         tc.carga
       FROM turma_cargas tc
       JOIN turmas t      ON t.id  = tc.turma_id  AND t.escola_id = tc.escola_id
       JOIN disciplinas d ON d.id  = tc.disciplina_id
       WHERE tc.escola_id  = ?
         AND LOWER(t.turno) = LOWER(?)
         AND t.ano = ?
         AND (
           LOWER(COALESCE(t.regime, 'anual')) <> 'semestral'
           OR tc.semestre IS NULL
           OR tc.semestre = 0
           OR tc.semestre = ?
         )
         AND NOT EXISTS (
           SELECT 1
             FROM modulacao m
             JOIN professores p ON p.id = m.professor_id
            WHERE m.escola_id = tc.escola_id
              AND m.turma_id = tc.turma_id
              AND m.disciplina_id = tc.disciplina_id
              AND (
                LOWER(COALESCE(t.regime, 'anual')) <> 'semestral'
                OR m.semestre IS NULL
                OR m.semestre = 0
                OR m.semestre = ?
                OR EXISTS (
                  SELECT 1 FROM professor_vinculos pv0
                  WHERE pv0.professor_id = p.id
                    AND pv0.disciplina_id = m.disciplina_id
                    AND LOWER(pv0.turno) COLLATE utf8mb4_unicode_ci = LOWER(t.turno) COLLATE utf8mb4_unicode_ci
                    AND pv0.escola_id = p.escola_id
                    AND (pv0.semestre = 0 OR pv0.semestre IS NULL)
                )
              )
         )
         AND NOT EXISTS (
           SELECT 1
             FROM agrupamento_modulacao am
             JOIN agrupamentos g ON g.id = am.agrupamento_id
            WHERE g.escola_id = tc.escola_id
              AND g.ano_letivo = ?
              AND COALESCE(g.status, 'ATIVO') <> 'ENCERRADO'
              AND LOWER(g.turno) = LOWER(t.turno)
              AND (g.semestre IS NULL OR g.semestre = 0 OR g.semestre = ?)
              AND (am.disciplina_id = tc.disciplina_id OR g.origem_disciplina_legada_id = tc.disciplina_id)
         )
       ORDER BY t.nome, d.nome`,
      [escola_id, turno, anoAtual, semestre, semestre, anoAtual, semestre]
    );

    // Totais de turmas com carga no semestre vigente para o score
    const [totaisTurmas] = await pool.query(
      `SELECT COUNT(DISTINCT tc.turma_id) AS total_turmas_com_carga
       FROM turma_cargas tc
       JOIN turmas t ON t.id = tc.turma_id AND t.escola_id = tc.escola_id
       WHERE tc.escola_id = ?
         AND LOWER(t.turno) = LOWER(?)
         AND t.ano = ?
         AND (
           LOWER(COALESCE(t.regime, 'anual')) <> 'semestral'
           OR tc.semestre IS NULL
           OR tc.semestre = 0
           OR tc.semestre = ?
         )`,
      [escola_id, turno, anoAtual, semestre]
    );

    const turmasComGapSet = new Set((descobertas || []).map((r) => Number(r.turma_id)));
    const totalTurmas = Number(totaisTurmas[0]?.total_turmas_com_carga) || 0;
    const turmasComGap = turmasComGapSet.size;
    const turmasCompletas = Math.max(0, totalTurmas - turmasComGap);

    return res.json({
      turno,
      semestre,
      vigencia,
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
