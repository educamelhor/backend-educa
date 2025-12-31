// routes/gradePublish.js
// -----------------------------------------------------------------------------
// Persistência de Grade: Rascunho ↔ Publicado
//  - POST /api/grade/rascunho       → cria/recria rascunho do turno
//  - GET  /api/grade/rascunho       → lê rascunho atual do turno
//  - POST /api/grade/publicar       → promove rascunho a publicado
//  - GET  /api/grade/publicado      → lê publicado atual do turno
// -----------------------------------------------------------------------------
//
// + PASSO 2.1: Rotas incrementais (slot)
//  - POST /api/grade/slot/upsert
//  - POST /api/grade/slot/remove
//
// + PASSO 3.2.2: Validação instantânea (pré-upsert)
//  - POST /api/grade/validate-slot  → valida H1/H2/H3/H6/H7
// -----------------------------------------------------------------------------

import express from "express";
import pool from "../db.js";
import {
  upsertRascunhoCompleto,
  getRascunhoByTurno,
  publicarRascunho,
  getPublicadoByTurno,
} from "../services/gradePersistenceService.js";

const router = express.Router();

function requireEscola(req, res, next) {
  const escolaId = req.user?.escola_id || Number(req.headers["x-escola-id"]);
  if (!escolaId) return res.status(403).json({ error: "Acesso negado: escola não definida." });
  req.escolaId = escolaId; next();
}

// POST /api/grade/rascunho
router.post("/rascunho", requireEscola, async (req, res) => {
  try {
    const { turno, turma_ids, turmaIds, slots } = req.body || {};
    const ids = Array.isArray(turmaIds) ? turmaIds : Array.isArray(turma_ids) ? turma_ids : [];
    if (!turno) return res.status(400).json({ error: "turno obrigatório." });
    if (!ids.length) return res.status(400).json({ error: "Informe turma_ids (mínimo 1)" });
    if (!Array.isArray(slots)) return res.status(400).json({ error: "slots deve ser um array." });

    const out = await upsertRascunhoCompleto(pool, {
      escolaId: req.escolaId,
      turno,
      turmas: ids,
      slots,
    });
    return res.json({ ok: true, ...out });
  } catch (e) {
    // Erros de UNIQUE (1062) => conflito turma/prof no mesmo slot
    if (e?.code === "ER_DUP_ENTRY" || e?.errno === 1062) {
      return res.status(409).json({ error: "Conflito de slot: turma ou professor duplicado no mesmo dia/período." });
    }
    console.error("POST /grade/rascunho:", e);
    return res.status(500).json({ error: "Falha ao salvar rascunho." });
  }
});

// GET /api/grade/rascunho?turno=Matutino
router.get("/rascunho", requireEscola, async (req, res) => {
  try {
    const turno = String(req.query.turno || "");
    if (!turno) return res.status(400).json({ error: "turno obrigatório." });
    const data = await getRascunhoByTurno(pool, { escolaId: req.escolaId, turno });
    if (!data) return res.json({ ok: true, resultado: null, slots: [] });
    return res.json({ ok: true, ...data });
  } catch (e) {
    console.error("GET /grade/rascunho:", e);
    return res.status(500).json({ error: "Falha ao carregar rascunho." });
  }
});

// POST /api/grade/publicar
router.post("/publicar", requireEscola, async (req, res) => {
  try {
    const { turno, descricao } = req.body || {};
    if (!turno) return res.status(400).json({ error: "turno obrigatório." });
    const out = await publicarRascunho(pool, { escolaId: req.escolaId, turno, descricao });
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error("POST /grade/publicar:", e);
    return res.status(400).json({ error: e?.message || "Falha ao publicar." });
  }
});

// GET /api/grade/publicado?turno=Matutino
router.get("/publicado", requireEscola, async (req, res) => {
  try {
    const turno = String(req.query.turno || "");
    if (!turno) return res.status(400).json({ error: "turno obrigatório." });
    const data = await getPublicadoByTurno(pool, { escolaId: req.escolaId, turno });
    if (!data) return res.json({ ok: true, resultado: null, slots: [] });
    return res.json({ ok: true, ...data });
  } catch (e) {
    console.error("GET /grade/publicado:", e);
    return res.status(500).json({ error: "Falha ao carregar publicado." });
  }
});

// --------- PASSO 2.1: Rotas incrementais (slot) -----------------------
import {
  upsertDraftSlot,
  removeDraftSlot,
  ensureRascunho, // usado também no validate-slot
} from "../services/gradePersistenceService.js";

// POST /api/grade/slot/upsert
router.post("/slot/upsert", requireEscola, async (req, res) => {
  try {
    const {
      turno, turma_id, dia, ordem, disciplina_id, professor_id,
      origem, locked
    } = req.body || {};

    if (!turno) return res.status(400).json({ error: "turno é obrigatório" });
    if (!turma_id || !dia || !ordem || !disciplina_id || !professor_id) {
      return res.status(400).json({ error: "turma_id, dia, ordem, disciplina_id e professor_id são obrigatórios" });
    }

    const out = await upsertDraftSlot(req.app.get("db") || req.app.locals.pool || req.pool || pool, {
      escolaId: req.escolaId,
      turno,
      turma_id, dia, ordem, disciplina_id, professor_id,
      origem, locked
    });

    return res.json({ ok: true, ...out });
  } catch (e) {
    if (e?.code === "ER_DUP_ENTRY" || e?.errno === 1062) {
      // Pode ser choque de TURMA (mesmo slot) ou de PROFESSOR (em outra turma)
      return res.status(409).json({
        error: "Conflito: choque de turma/professor no mesmo dia/período.",
        code: "SLOT_CONFLICT"
      });
    }
    console.error("POST /grade/slot/upsert:", e);
    return res.status(500).json({ error: "Falha ao salvar slot." });
  }
});

// POST /api/grade/slot/remove
router.post("/slot/remove", requireEscola, async (req, res) => {
  try {
    const { turno, turma_id, dia, ordem } = req.body || {};
    if (!turno) return res.status(400).json({ error: "turno é obrigatório" });
    if (!turma_id || !dia || !ordem) {
      return res.status(400).json({ error: "turma_id, dia e ordem são obrigatórios" });
    }
    const out = await removeDraftSlot(req.app.get("db") || req.app.locals.pool || req.pool || pool, {
      escolaId: req.escolaId, turno, turma_id, dia, ordem
    });
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error("POST /grade/slot/remove:", e);
    return res.status(500).json({ error: "Falha ao remover slot." });
  }
});


// ============================================================================
// PASSO 3.2.2 — Validação instantânea (pré-upsert)
// ----------------------------------------------------------------------------
// POST /api/grade/validate-slot
// Valida H1/H2/H3/H6/H7 ANTES de chamar /slot/upsert.
//
// Body esperado:
// {
//   turno, turma_id, dia, ordem, disciplina_id, professor_id,
//   origem?: { turma_id, dia, ordem }   // opcional (quando é "move" interno)
// }
//
// Retorno:
// { ok:true } ou { ok:false, code, message }
// ============================================================================
function parseJsonColumn(raw) {
  try {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) return raw;
    if (typeof raw === "string") return JSON.parse(raw || "[]");
    if (raw && Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8") || "[]");
  } catch {
    /* ignore */
  }
  return [];
}

function normTurno(t) {
  return String(t || "").trim().toLowerCase();
}

function fail(res, code, message, http = 200) {
  return res.status(http).json({ ok: false, code, message });
}

router.post("/validate-slot", requireEscola, async (req, res) => {
  try {
    const db = req.app.get("db") || req.app.locals.pool || req.pool || pool;

    const {
      turno, turma_id, dia, ordem, disciplina_id, professor_id,
      origem
    } = req.body || {};

    // Campos mínimos
    if (!turno) return fail(res, "BAD_REQUEST", "turno é obrigatório.", 400);
    if (!turma_id || !dia || !ordem || !disciplina_id || !professor_id) {
      return fail(
        res,
        "BAD_REQUEST",
        "turma_id, dia, ordem, disciplina_id e professor_id são obrigatórios.",
        400
      );
    }

    const turnoNorm = normTurno(turno);
    const turmaId = Number(turma_id);
    const diaNum = Number(dia);
    const ordemNum = Number(ordem);
    const discId = Number(disciplina_id);
    const profId = Number(professor_id);

    const origemTurma = origem?.turma_id ? Number(origem.turma_id) : null;
    const origemDia = origem?.dia ? Number(origem.dia) : null;
    const origemOrdem = origem?.ordem ? Number(origem.ordem) : null;

    // Garante rascunho do turno (fonte da verdade)
    const resultadoId = await ensureRascunho(db, { escolaId: req.escolaId, turno: turnoNorm });

    // -----------------------------------------------------------------------
    // H7 — Lock inviolável (origem)
    // Se estiver movendo algo e o slot de origem estiver locked, bloqueia.
    // -----------------------------------------------------------------------
    if (origemTurma && origemDia && origemOrdem) {
      const [[origSlot]] = await db.query(
        `
        SELECT locked
          FROM grade_slot
         WHERE resultado_id = ?
           AND turma_id = ?
           AND dia_semana = ?
           AND periodo_ordem = ?
         LIMIT 1
        `,
        [resultadoId, origemTurma, origemDia, origemOrdem]
      );
      if (origSlot?.locked) {
        return fail(
          res,
          "SLOT_LOCKED",
          "Esta aula está fixada. Desbloqueie para alterar."
        );
      }
    }

    // -----------------------------------------------------------------------
    // H7 — Lock inviolável (destino)
    // Se o destino já tem aula locked, não pode sobrescrever.
    // -----------------------------------------------------------------------
    const [[destSlot]] = await db.query(
      `
      SELECT turma_id, disciplina_id, professor_id, locked
        FROM grade_slot
       WHERE resultado_id = ?
         AND turma_id = ?
         AND dia_semana = ?
         AND periodo_ordem = ?
       LIMIT 1
      `,
      [resultadoId, turmaId, diaNum, ordemNum]
    );

    if (destSlot?.locked) {
      // Se é exatamente a mesma aula no mesmo lugar, OK (ex.: salvar novamente)
      const same =
        Number(destSlot.disciplina_id) === discId &&
        Number(destSlot.professor_id) === profId;
      if (!same) {
        return fail(
          res,
          "SLOT_LOCKED",
          "Este slot está fixado. Desbloqueie para alterar."
        );
      }
    }

    // -----------------------------------------------------------------------
    // H1 — Conflito de turma (ocupação do slot)
    // Se o slot de destino já está ocupado por outra aula (não é o mesmo lugar de origem), bloqueia.
    // -----------------------------------------------------------------------
    if (destSlot && !(origemTurma === turmaId && origemDia === diaNum && origemOrdem === ordemNum)) {
      // Já existe algo naquele slot; para FASE_1 bloqueamos (swap/move será tratado no frontend com fluxo próprio)
      return fail(
        res,
        "TURMA_CONFLITO",
        "A turma já possui uma aula neste horário."
      );
    }

    // -----------------------------------------------------------------------
    // H2 — Conflito de professor no mesmo período (em outra turma)
    // Ignora o próprio slot de origem (quando move).
    // -----------------------------------------------------------------------
    const [profRows] = await db.query(
      `
      SELECT turma_id, dia_semana, periodo_ordem
        FROM grade_slot
       WHERE resultado_id = ?
         AND professor_id = ?
         AND dia_semana = ?
         AND periodo_ordem = ?
      `,
      [resultadoId, profId, diaNum, ordemNum]
    );

    const hasProfConflict = (profRows || []).some((r) => {
      const t = Number(r.turma_id);
      const d = Number(r.dia_semana);
      const o = Number(r.periodo_ordem);
      // Se for exatamente o slot de origem, ignorar
      if (origemTurma && origemDia && origemOrdem) {
        return !(t === origemTurma && d === origemDia && o === origemOrdem);
      }
      return true; // qualquer ocorrência é conflito
    });

    if (hasProfConflict) {
      return fail(
        res,
        "PROFESSOR_CONFLITO",
        "O professor já está alocado em outra turma neste período."
      );
    }

    // -----------------------------------------------------------------------
    // H3 — Indisponibilidade do professor (bloqueia apenas 'indisponivel')
    // grade_disponibilidades.periodos é JSON: [{ordem, status}]
    // -----------------------------------------------------------------------
    const [[disp]] = await db.query(
      `
      SELECT status, periodos
        FROM grade_disponibilidades
       WHERE escola_id = ?
         AND professor_id = ?
         AND turno = ?
         AND dia_semana = ?
       LIMIT 1
      `,
      [req.escolaId, profId, turnoNorm, diaNum]
    );

    if (disp) {
      const periodos = parseJsonColumn(disp.periodos);
      const item = (periodos || []).find((p) => Number(p?.ordem) === ordemNum);
      const st = String(item?.status || disp.status || "livre").toLowerCase();
      if (st === "indisponivel") {
        return fail(
          res,
          "INDISPONIVEL",
          "Este horário está marcado como indisponível para o professor."
        );
      }
    }

    // -----------------------------------------------------------------------
    // H6 — Professor permitido (modulação)
    // Exige existir (escola, professor, turma, disciplina) em modulacao.
    // -----------------------------------------------------------------------
    const [[mod]] = await db.query(
      `
      SELECT 1
        FROM modulacao
       WHERE escola_id = ?
         AND professor_id = ?
         AND turma_id = ?
         AND disciplina_id = ?
       LIMIT 1
      `,
      [req.escolaId, profId, turmaId, discId]
    );

    if (!mod) {
      return fail(
        res,
        "PROFESSOR_NAO_PERMITIDO",
        "Este professor não está atribuído a esta disciplina nesta turma."
      );
    }

    // OK
    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /grade/validate-slot:", e);
    return res.status(500).json({ ok: false, code: "SERVER_ERROR", message: "Falha ao validar slot." });
  }
});

export default router;
