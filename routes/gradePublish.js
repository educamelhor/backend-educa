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

// ============================================================================
// HORÁRIO MANUAL POR PROFESSOR (Aba ✍️ Horário Manual)
//  - GET  /api/grade/manual?turno=matutino
//  - POST /api/grade/manual/professor
// ============================================================================

const DIAS_NOMES_PT = {
  1: "Segunda-feira",
  2: "Terça-feira",
  3: "Quarta-feira",
  4: "Quinta-feira",
  5: "Sexta-feira",
  6: "Sábado",
};

// GET /api/grade/manual?turno=matutino
router.get("/manual", requireEscola, async (req, res) => {
  try {
    const db = req.app.get("db") || req.app.locals.pool || req.pool || pool;
    const turnoNorm = normTurno(req.query.turno || "");
    if (!turnoNorm) {
      return res.status(400).json({ ok: false, error: "Parâmetro turno é obrigatório." });
    }

    // Busca rascunho e publicado do turno
    const [resultados] = await db.query(
      `SELECT id, status, version, updated_at, published_at, created_at
         FROM (
           SELECT id, status, version, published_at AS updated_at, published_at, created_at
             FROM grade_resultado
            WHERE escola_id = ? AND turno = ? AND status IN ('rascunho', 'publicado')
         ) r
        ORDER BY FIELD(status, 'rascunho', 'publicado')`,
      [req.escolaId, turnoNorm]
    );

    if (!resultados || resultados.length === 0) {
      return res.json({ ok: true, resultado_id: null, status: null, slots: [] });
    }

    // Prioriza rascunho se tiver slots; caso contrário usa publicado se tiver slots
    let escolhido = resultados[0];
    const [slotsEscolhido] = await db.query(
      `SELECT
         gs.turma_id,
         gs.dia_semana AS dia,
         gs.periodo_ordem AS ordem,
         gs.disciplina_id,
         gs.professor_id,
         gs.origem,
         gs.locked,
         t.nome AS turma_nome,
         p.nome AS professor_nome,
         d.nome AS disciplina_nome
       FROM grade_slot gs
       LEFT JOIN turmas t ON t.id = gs.turma_id
       LEFT JOIN professores p ON p.id = gs.professor_id
       LEFT JOIN disciplinas d ON d.id = gs.disciplina_id
      WHERE gs.resultado_id = ?`,
      [escolhido.id]
    );

    if (slotsEscolhido.length === 0 && resultados.length > 1) {
      const outro = resultados[1];
      const [slotsOutro] = await db.query(
        `SELECT
           gs.turma_id,
           gs.dia_semana AS dia,
           gs.periodo_ordem AS ordem,
           gs.disciplina_id,
           gs.professor_id,
           gs.origem,
           gs.locked,
           t.nome AS turma_nome,
           p.nome AS professor_nome,
           d.nome AS disciplina_nome
         FROM grade_slot gs
         LEFT JOIN turmas t ON t.id = gs.turma_id
         LEFT JOIN professores p ON p.id = gs.professor_id
         LEFT JOIN disciplinas d ON d.id = gs.disciplina_id
        WHERE gs.resultado_id = ?`,
        [outro.id]
      );
      if (slotsOutro.length > 0) {
        return res.json({
          ok: true,
          resultado_id: outro.id,
          status: outro.status,
          slots: slotsOutro,
        });
      }
    }

    return res.json({
      ok: true,
      resultado_id: escolhido.id,
      status: escolhido.status,
      slots: slotsEscolhido,
    });
  } catch (e) {
    console.error("GET /api/grade/manual:", e);
    return res.status(500).json({ ok: false, error: "Falha ao carregar horário manual do turno." });
  }
});

// POST /api/grade/manual/professor
router.post("/manual/professor", requireEscola, async (req, res) => {
  const db = req.app.get("db") || req.app.locals.pool || req.pool || pool;
  const conn = await db.getConnection();
  try {
    const {
      turno,
      professor_id,
      slots = [],
      substituir_conflitos = false,
    } = req.body || {};

    const turnoNorm = normTurno(turno);
    const profId = Number(professor_id);

    if (!turnoNorm) {
      return res.status(400).json({ ok: false, error: "Turno é obrigatório." });
    }
    if (!profId) {
      return res.status(400).json({ ok: false, error: "professor_id é obrigatório." });
    }
    if (!Array.isArray(slots)) {
      return res.status(400).json({ ok: false, error: "slots deve ser uma lista." });
    }

    // Normaliza e deduplica slots por (dia, ordem)
    const mapaSlots = new Map();
    for (const s of slots) {
      const dia = Number(s?.dia ?? s?.dia_semana);
      const ordem = Number(s?.ordem ?? s?.periodo_ordem);
      const turma_id = Number(s?.turma_id);
      const disciplina_id = Number(s?.disciplina_id);
      if (!dia || !ordem || !turma_id || !disciplina_id) continue;
      mapaSlots.set(`${dia}-${ordem}`, { dia, ordem, turma_id, disciplina_id });
    }
    const validSlots = Array.from(mapaSlots.values());

    await conn.beginTransaction();

    // 1) Garante rascunho para (escolaId, turnoNorm)
    let [[draft]] = await conn.query(
      `SELECT id FROM grade_resultado WHERE escola_id = ? AND turno = ? AND status = 'rascunho' LIMIT 1`,
      [req.escolaId, turnoNorm]
    );
    const [[pub]] = await conn.query(
      `SELECT id FROM grade_resultado WHERE escola_id = ? AND turno = ? AND status = 'publicado' LIMIT 1`,
      [req.escolaId, turnoNorm]
    );

    let draftId = draft?.id || null;
    if (!draftId) {
      const [ins] = await conn.query(
        `INSERT INTO grade_resultado (escola_id, turno, status, version, descricao)
         VALUES (?, ?, 'rascunho', 1, 'Horário Manual')`,
        [req.escolaId, turnoNorm]
      );
      draftId = ins.insertId;

      // Se já havia um publicado, clona os slots existentes para o rascunho não começar vazio
      if (pub?.id) {
        await conn.query(
          `INSERT IGNORE INTO grade_resultado_turma (resultado_id, turma_id)
           SELECT ?, turma_id FROM grade_resultado_turma WHERE resultado_id = ?`,
          [draftId, pub.id]
        );
        await conn.query(
          `INSERT IGNORE INTO grade_slot
             (resultado_id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked)
           SELECT ?, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked
             FROM grade_slot
            WHERE resultado_id = ?`,
          [draftId, pub.id]
        );
      }
    } else if (pub?.id) {
      // Se o rascunho existir mas estiver completamente vazio e o publicado tiver dados, hidrata o rascunho
      const [[cntDraft]] = await conn.query(
        `SELECT COUNT(*) AS total FROM grade_slot WHERE resultado_id = ?`,
        [draftId]
      );
      if (Number(cntDraft?.total || 0) === 0) {
        await conn.query(
          `INSERT IGNORE INTO grade_resultado_turma (resultado_id, turma_id)
           SELECT ?, turma_id FROM grade_resultado_turma WHERE resultado_id = ?`,
          [draftId, pub.id]
        );
        await conn.query(
          `INSERT IGNORE INTO grade_slot
             (resultado_id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked)
           SELECT ?, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked
             FROM grade_slot
            WHERE resultado_id = ?`,
          [draftId, pub.id]
        );
      }
    }

    // 2) Verifica se alguma turma escolhida já está ocupada por OUTRO professor no mesmo (dia, ordem)
    const conflitos = [];
    for (const s of validSlots) {
      const [ocupados] = await conn.query(
        `SELECT
           gs.turma_id,
           gs.dia_semana AS dia,
           gs.periodo_ordem AS ordem,
           gs.professor_id,
           gs.disciplina_id,
           t.nome AS turma_nome,
           p.nome AS professor_nome,
           d.nome AS disciplina_nome
         FROM grade_slot gs
         LEFT JOIN turmas t ON t.id = gs.turma_id
         LEFT JOIN professores p ON p.id = gs.professor_id
         LEFT JOIN disciplinas d ON d.id = gs.disciplina_id
        WHERE gs.resultado_id = ?
          AND gs.turma_id = ?
          AND gs.dia_semana = ?
          AND gs.periodo_ordem = ?
          AND gs.professor_id <> ?
        LIMIT 1
        FOR UPDATE`,
        [draftId, s.turma_id, s.dia, s.ordem, profId]
      );

      if (ocupados && ocupados.length > 0) {
        conflitos.push(ocupados[0]);
      }
    }

    if (conflitos.length > 0 && !substituir_conflitos) {
      await conn.rollback();
      const c = conflitos[0];
      const diaLabel = DIAS_NOMES_PT[c.dia] || `Dia ${c.dia}`;
      return res.status(409).json({
        ok: false,
        code: "TURMA_CONFLITO",
        error: `Conflito em ${diaLabel} (${c.ordem}º horário): a turma ${c.turma_nome || c.turma_id} já está ocupada por ${c.professor_nome || "outro professor"}${c.disciplina_nome ? ` (${c.disciplina_nome})` : ""}.`,
        conflicts: conflitos,
      });
    }

    // Se substituir_conflitos=true, remove os slots conflitantes de outros professores naquelas turmas/horários
    if (conflitos.length > 0 && substituir_conflitos) {
      for (const c of conflitos) {
        await conn.query(
          `DELETE FROM grade_slot
            WHERE resultado_id = ?
              AND turma_id = ?
              AND dia_semana = ?
              AND periodo_ordem = ?`,
          [draftId, c.turma_id, c.dia, c.ordem]
        );
      }
    }

    // 3) Remove os slots anteriores deste professor no rascunho e insere os novos
    await conn.query(
      `DELETE FROM grade_slot WHERE resultado_id = ? AND professor_id = ?`,
      [draftId, profId]
    );

    for (const s of validSlots) {
      await conn.query(
        `INSERT IGNORE INTO grade_resultado_turma (resultado_id, turma_id) VALUES (?, ?)`,
        [draftId, s.turma_id]
      );
      await conn.query(
        `INSERT INTO grade_slot
           (resultado_id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', 1)`,
        [draftId, s.turma_id, s.dia, s.ordem, s.disciplina_id, profId]
      );
    }

    // 4) Sincroniza também o registro 'publicado' do turno para que toda a escola já enxergue o horário atualizado
    let pubId = pub?.id || null;
    if (!pubId) {
      const [insPub] = await conn.query(
        `INSERT INTO grade_resultado (escola_id, turno, status, version, descricao, published_at)
         VALUES (?, ?, 'publicado', 1, 'Horário Manual', NOW())`,
        [req.escolaId, turnoNorm]
      );
      pubId = insPub.insertId;
    } else {
      await conn.query(
        `UPDATE grade_resultado SET published_at = NOW(), version = IFNULL(version, 0) + 1 WHERE id = ?`,
        [pubId]
      );
    }

    // Espelha rascunho -> publicado de forma atômica
    await conn.query(`DELETE FROM grade_slot WHERE resultado_id = ?`, [pubId]);
    await conn.query(`DELETE FROM grade_resultado_turma WHERE resultado_id = ?`, [pubId]);
    await conn.query(
      `INSERT IGNORE INTO grade_resultado_turma (resultado_id, turma_id)
       SELECT ?, turma_id FROM grade_resultado_turma WHERE resultado_id = ?`,
      [pubId, draftId]
    );
    await conn.query(
      `INSERT INTO grade_slot
         (resultado_id, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked)
       SELECT ?, turma_id, dia_semana, periodo_ordem, disciplina_id, professor_id, origem, locked
         FROM grade_slot
        WHERE resultado_id = ?`,
      [pubId, draftId]
    );

    await conn.commit();

    return res.json({
      ok: true,
      resultado_id: draftId,
      publicado_id: pubId,
      professor_id: profId,
      saved_count: validSlots.length,
    });
  } catch (e) {
    await conn.rollback();
    console.error("POST /api/grade/manual/professor:", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Falha ao salvar o horário do professor.",
    });
  } finally {
    conn.release();
  }
});

export default router;
