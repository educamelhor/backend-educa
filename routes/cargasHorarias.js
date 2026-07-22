// api/routes/cargasHorarias.js
// ============================================================================
// Cargas Horárias por Turma — com suporte a semestres
// - GET: lista cargas da turma por semestre (default: semestre 1)
// - POST /definir: substitui definição inteira da turma por semestre
// - POST /definir-lote: define para múltiplas turmas por semestre
// - POST /copiar-semestre: copia cargas do 1º para o 2º semestre
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
// Utilitário: busca o regime da turma (anual | semestral)
// Retorna 'anual' como default seguro se a coluna ainda não existir no banco.
// ----------------------------------------------------------------------------
async function getRegimeTurma(turmaId, escolaId) {
  try {
    const [[row]] = await pool.query(
      `SELECT COALESCE(regime, 'anual') AS regime FROM turmas WHERE id = ? AND escola_id = ? LIMIT 1`,
      [turmaId, escolaId]
    );
    return row?.regime ?? 'anual';
  } catch {
    return 'anual';
  }
}

// ----------------------------------------------------------------------------
// GET /api/cargas-horarias?turma_id=123[&semestre=2]
// Lista cargas da turma, restrito à escola do login.
// Para turmas anuais: sempre retorna semestre 1 (ignora parâmetro).
// Para turmas semestrais: filtra pelo semestre informado (default 1).
// ----------------------------------------------------------------------------
router.get("/", verificarEscola, async (req, res) => {
  try {
    const { turma_id } = req.query;
    const { escola_id } = req.user;
    const semestreParam = parseInt(req.query.semestre) === 2 ? 2 : 1;

    if (!turma_id) {
      return res.status(400).json({ message: "turma_id é obrigatório" });
    }

    const regime = await getRegimeTurma(turma_id, escola_id);
    const semestre = regime === 'semestral' ? semestreParam : 1;

    const [rows] = await pool.query(
      `SELECT
         tc.id,
         tc.escola_id,
         tc.turma_id,
         tc.disciplina_id,
         tc.semestre,
         tc.carga,
         UPPER(d.nome) AS disciplina_nome
       FROM turma_cargas tc
       JOIN disciplinas d ON d.id = tc.disciplina_id
      WHERE tc.turma_id = ?
        AND tc.escola_id = ?
        AND tc.semestre = ?
      ORDER BY d.nome`,
      [turma_id, escola_id, semestre]
    );

    const total = rows.reduce((acc, r) => acc + (Number(r.carga) || 0), 0);
    return res.status(200).json({ itens: rows, totalCarga: total, semestre, regime });
  } catch (err) {
    console.error("Erro ao listar cargas da turma:", err);
    return res.status(500).json({ message: "Não foi possível carregar as cargas da turma." });
  }
});

// ----------------------------------------------------------------------------
// POST /api/cargas-horarias/definir
// Body: { turma_id, semestre (1|2, default 1), itens: number[] }
// Substitui a definição do semestre informado. Para turmas anuais, sempre semestre 1.
// ----------------------------------------------------------------------------
router.post("/definir", verificarEscola, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { turma_id, itens } = req.body;
    const { escola_id } = req.user;
    const semestreParam = parseInt(req.body.semestre) === 2 ? 2 : 1;

    if (!turma_id || !Array.isArray(itens)) {
      return res.status(400).json({ message: "turma_id e itens são obrigatórios." });
    }

    const regime = await getRegimeTurma(turma_id, escola_id);
    const semestre = regime === 'semestral' ? semestreParam : 1;

    await conn.beginTransaction();

    // Exclui apenas o semestre selecionado (preserva o outro semestre intacto)
    await conn.query(
      "DELETE FROM turma_cargas WHERE turma_id = ? AND escola_id = ? AND semestre = ?",
      [turma_id, escola_id, semestre]
    );

    if (itens.length > 0) {
      const placeholders = itens.map(() => "?").join(",");
      const params = [escola_id, ...itens];

      const [disciplinas] = await conn.query(
        `SELECT id, (carga + 0) AS carga
           FROM disciplinas
          WHERE escola_id = ?
            AND id IN (${placeholders})`,
        params
      );

      const valores = disciplinas.map((d) => [
        escola_id,
        turma_id,
        d.id,
        semestre,
        Number(d.carga) || 0,
      ]);

      if (valores.length > 0) {
        await conn.query(
          "INSERT INTO turma_cargas (escola_id, turma_id, disciplina_id, semestre, carga) VALUES ?",
          [valores]
        );
      }
    }

    const [rows] = await conn.query(
      `SELECT
         tc.id,
         tc.escola_id,
         tc.turma_id,
         tc.disciplina_id,
         tc.semestre,
         tc.carga,
         UPPER(d.nome) AS disciplina_nome
       FROM turma_cargas tc
       JOIN disciplinas d ON d.id = tc.disciplina_id
      WHERE tc.turma_id = ?
        AND tc.escola_id = ?
        AND tc.semestre = ?
      ORDER BY d.nome`,
      [turma_id, escola_id, semestre]
    );

    await conn.commit();

    const total = rows.reduce((acc, r) => acc + (Number(r.carga) || 0), 0);
    return res.status(200).json({ ok: true, itens: rows, totalCarga: total, semestre, regime });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error("Erro ao definir cargas da turma:", err);
    return res.status(500).json({ message: "Não foi possível salvar as cargas da turma." });
  } finally {
    try { conn.release(); } catch {}
  }
});

// ----------------------------------------------------------------------------
// POST /api/cargas-horarias/definir-lote
// Body: { turma_ids, semestre (1|2, default 1), itens: number[] }
// Define o mesmo conjunto de disciplinas para várias turmas no mesmo semestre.
// Para turmas anuais dentro do lote: sempre usa semestre 1.
// ----------------------------------------------------------------------------
router.post("/definir-lote", verificarEscola, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { turma_ids, itens } = req.body;
    const { escola_id } = req.user;
    const semestreParam = parseInt(req.body.semestre) === 2 ? 2 : 1;

    if (!Array.isArray(turma_ids) || turma_ids.length === 0 || !Array.isArray(itens)) {
      return res.status(400).json({ message: "turma_ids e itens são obrigatórios." });
    }

    await conn.beginTransaction();

    // Busca regime de todas as turmas do lote
    const phTurmas = turma_ids.map(() => "?").join(",");
    const [regimes] = await conn.query(
      `SELECT id, COALESCE(regime, 'anual') AS regime FROM turmas WHERE id IN (${phTurmas}) AND escola_id = ?`,
      [...turma_ids, escola_id]
    );
    const regimeMap = Object.fromEntries(regimes.map(r => [r.id, r.regime]));

    // Agrupa turmas por semestre efetivo
    const turmasPorSemestre = { 1: [], 2: [] };
    for (const tid of turma_ids) {
      const regime = regimeMap[tid] ?? 'anual';
      const sem = regime === 'semestral' ? semestreParam : 1;
      turmasPorSemestre[sem].push(Number(tid));
    }

    // Busca disciplinas e suas cargas
    if (itens.length > 0) {
      const phDiscs = itens.map(() => "?").join(",");
      const [disciplinas] = await conn.query(
        `SELECT id, (carga + 0) AS carga FROM disciplinas WHERE escola_id = ? AND id IN (${phDiscs})`,
        [escola_id, ...itens]
      );

      for (const [sem, turmasDoSem] of Object.entries(turmasPorSemestre)) {
        if (turmasDoSem.length === 0) continue;
        const semNum = Number(sem);

        // Remove cargas anteriores apenas do semestre selecionado
        const phT = turmasDoSem.map(() => "?").join(",");
        await conn.query(
          `DELETE FROM turma_cargas WHERE turma_id IN (${phT}) AND escola_id = ? AND semestre = ?`,
          [...turmasDoSem, escola_id, semNum]
        );

        const valores = [];
        for (const turma_id of turmasDoSem) {
          for (const d of disciplinas) {
            valores.push([escola_id, turma_id, d.id, semNum, Number(d.carga) || 0]);
          }
        }

        if (valores.length > 0) {
          await conn.query(
            "INSERT INTO turma_cargas (escola_id, turma_id, disciplina_id, semestre, carga) VALUES ?",
            [valores]
          );
        }
      }
    }

    await conn.commit();
    return res.status(200).json({
      ok: true,
      turmas_atualizadas: turma_ids.length,
      message: `Cargas definidas para ${turma_ids.length} turma(s) com sucesso.`,
    });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error("Erro ao definir cargas em lote:", err);
    return res.status(500).json({ message: "Não foi possível salvar as cargas em lote." });
  } finally {
    try { conn.release(); } catch {}
  }
});

// ----------------------------------------------------------------------------
// POST /api/cargas-horarias/copiar-semestre
// Body: { turma_ids: number[], de: 1, para: 2 }
// Copia cargas do semestre 'de' para o semestre 'para'.
// Só funciona para turmas com regime = 'semestral'.
// ----------------------------------------------------------------------------
router.post("/copiar-semestre", verificarEscola, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { turma_ids, de, para } = req.body;
    const { escola_id } = req.user;

    if (!Array.isArray(turma_ids) || turma_ids.length === 0) {
      return res.status(400).json({ message: "turma_ids é obrigatório." });
    }
    if (![1, 2].includes(Number(de)) || ![1, 2].includes(Number(para)) || de === para) {
      return res.status(400).json({ message: "de e para devem ser 1 ou 2 e diferentes entre si." });
    }

    // Filtra apenas turmas semestrais
    const phTurmas = turma_ids.map(() => "?").join(",");
    const [turmasSemestrais] = await conn.query(
      `SELECT id FROM turmas WHERE id IN (${phTurmas}) AND escola_id = ? AND regime = 'semestral'`,
      [...turma_ids, escola_id]
    );

    if (turmasSemestrais.length === 0) {
      return res.status(400).json({ message: "Nenhuma turma semestral encontrada." });
    }

    const idsSemestrais = turmasSemestrais.map(t => t.id);
    const phS = idsSemestrais.map(() => "?").join(",");

    await conn.beginTransaction();

    // Remove cargas do semestre destino
    await conn.query(
      `DELETE FROM turma_cargas WHERE turma_id IN (${phS}) AND escola_id = ? AND semestre = ?`,
      [...idsSemestrais, escola_id, Number(para)]
    );

    // Copia do semestre origem para o destino
    await conn.query(
      `INSERT INTO turma_cargas (escola_id, turma_id, disciplina_id, semestre, carga)
       SELECT escola_id, turma_id, disciplina_id, ?, carga
       FROM turma_cargas
       WHERE turma_id IN (${phS}) AND escola_id = ? AND semestre = ?`,
      [Number(para), ...idsSemestrais, escola_id, Number(de)]
    );

    await conn.commit();
    return res.status(200).json({
      ok: true,
      turmas_atualizadas: idsSemestrais.length,
      message: `Cargas copiadas do ${de}º para o ${para}º semestre em ${idsSemestrais.length} turma(s).`,
    });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error("Erro ao copiar semestre:", err);
    return res.status(500).json({ message: "Não foi possível copiar as cargas." });
  } finally {
    try { conn.release(); } catch {}
  }
});


// ============================================================================
// ROTAS MODULAÇÃO INTELIGENTE: config-segmento
// Configuração de carga por disciplina × etapa × turno por escola.
// ============================================================================

// GET /api/cargas-horarias/config-segmento
router.get("/config-segmento", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { disciplina_id } = req.query;

    let sql = `
      SELECT
        dcs.id,
        dcs.disciplina_id,
        d.nome AS disciplina_nome,
        dcs.etapa,
        dcs.turno,
        dcs.carga,
        dcs.atualizado_em
      FROM disciplina_carga_segmento dcs
      JOIN disciplinas d ON d.id = dcs.disciplina_id
      WHERE dcs.escola_id = ?
    `;
    const params = [escola_id];

    if (disciplina_id) {
      sql += " AND dcs.disciplina_id = ?";
      params.push(Number(disciplina_id));
    }

    sql += " ORDER BY d.nome, dcs.etapa, dcs.turno";

    const [rows] = await pool.query(sql, params);
    return res.json({ ok: true, itens: rows });
  } catch (err) {
    console.error("[config-segmento] Erro ao listar:", err);
    return res.status(500).json({ message: "Erro ao listar configurações de segmento." });
  }
});

// POST /api/cargas-horarias/config-segmento
router.post("/config-segmento", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { disciplina_id, etapa, turno, carga } = req.body;

    if (!disciplina_id || !etapa || !turno || carga == null) {
      return res.status(400).json({ message: "disciplina_id, etapa, turno e carga são obrigatórios." });
    }

    const cargaNum = Number(carga);
    if (!Number.isInteger(cargaNum) || cargaNum < 1) {
      return res.status(400).json({ message: "carga deve ser um inteiro >= 1." });
    }

    await pool.query(
      `INSERT INTO disciplina_carga_segmento (escola_id, disciplina_id, etapa, turno, carga)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE carga = VALUES(carga), atualizado_em = NOW()`,
      [escola_id, Number(disciplina_id), String(etapa).trim(), String(turno).trim(), cargaNum]
    );

    const [[row]] = await pool.query(
      `SELECT dcs.id, dcs.disciplina_id, d.nome AS disciplina_nome, dcs.etapa, dcs.turno, dcs.carga
       FROM disciplina_carga_segmento dcs
       JOIN disciplinas d ON d.id = dcs.disciplina_id
       WHERE dcs.escola_id = ? AND dcs.disciplina_id = ? AND dcs.etapa = ? AND dcs.turno = ?`,
      [escola_id, Number(disciplina_id), String(etapa).trim(), String(turno).trim()]
    );

    return res.status(200).json({ ok: true, item: row });
  } catch (err) {
    console.error("[config-segmento] Erro ao salvar:", err);
    return res.status(500).json({ message: "Erro ao salvar configuração de segmento." });
  }
});

// DELETE /api/cargas-horarias/config-segmento/:id
router.delete("/config-segmento/:id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const id = Number(req.params.id);

    const [result] = await pool.query(
      "DELETE FROM disciplina_carga_segmento WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Configuração não encontrada." });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[config-segmento] Erro ao remover:", err);
    return res.status(500).json({ message: "Erro ao remover configuração de segmento." });
  }
});

export default router;
