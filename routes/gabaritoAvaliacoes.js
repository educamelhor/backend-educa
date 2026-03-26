// ============================================================================
// GABARITO — CRUD de Avaliações (Persistência no BD)
// ============================================================================
// Cada avaliação gerada na Etapa 1 é salva aqui. Na Etapa 2, o coordenador
// seleciona a avaliação para correção. Suporta mapeamento multidisciplinar.
//
// disciplinas_config: [
//   { disciplina_id: 21, nome: "Matemática", de: 1, ate: 15 },
//   { disciplina_id: 25, nome: "Ciências",   de: 16, ate: 25 }
// ]
// ============================================================================

import { Router } from "express";
import pool from "../db.js";

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function anoLetivoAtual() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// ─── GET /api/gabarito-avaliacoes ────────────────────────────────────────────
// Lista todas as avaliações da escola (opcionalmente filtradas por status)
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { status, bimestre, limit } = req.query;

    let sql = `
      SELECT 
        id, titulo, tipo, bimestre, num_questoes, num_alternativas,
        nota_total, modelo, gabarito_oficial, disciplinas_config,
        turmas_ids, turno, status, criado_por,
        created_at, updated_at
      FROM gabarito_avaliacoes
      WHERE escola_id = ?
    `;
    const params = [escola_id];

    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    if (bimestre) {
      sql += " AND bimestre = ?";
      params.push(bimestre);
    }

    sql += " ORDER BY created_at DESC";

    if (limit) {
      sql += " LIMIT ?";
      params.push(Number(limit));
    }

    const [rows] = await pool.query(sql, params);

    // Parse JSON fields
    const parsed = rows.map((r) => ({
      ...r,
      gabarito_oficial: safeJson(r.gabarito_oficial),
      disciplinas_config: safeJson(r.disciplinas_config),
      turmas_ids: safeJson(r.turmas_ids),
    }));

    res.json(parsed);
  } catch (err) {
    console.error("Erro ao listar avaliações:", err);
    res.status(500).json({ error: "Erro ao carregar avaliações." });
  }
});

// ─── GET /api/gabarito-avaliacoes/:id ────────────────────────────────────────
// Retorna uma avaliação específica
router.get("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT * FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    const r = rows[0];
    res.json({
      ...r,
      gabarito_oficial: safeJson(r.gabarito_oficial),
      disciplinas_config: safeJson(r.disciplinas_config),
      turmas_ids: safeJson(r.turmas_ids),
    });
  } catch (err) {
    console.error("Erro ao buscar avaliação:", err);
    res.status(500).json({ error: "Erro ao buscar avaliação." });
  }
});

// ─── GET /api/gabarito-avaliacoes/verificar-duplicidade ──────────────────────
// Verifica se já existe avaliação similar (mesmo tipo+titulo+bimestre)
router.get("/verificar-duplicidade", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { tipo, titulo, bimestre } = req.query;

    if (!titulo) return res.json({ existe: false });

    let sql = `
      SELECT id, titulo, tipo, bimestre, status, created_at
      FROM gabarito_avaliacoes
      WHERE escola_id = ? AND LOWER(TRIM(titulo)) = LOWER(TRIM(?))
    `;
    const params = [escola_id, titulo];

    if (tipo) {
      sql += " AND tipo = ?";
      params.push(tipo);
    }
    if (bimestre) {
      sql += " AND bimestre = ?";
      params.push(bimestre);
    }

    sql += " ORDER BY created_at DESC LIMIT 1";
    const [rows] = await pool.query(sql, params);

    if (rows.length > 0) {
      return res.json({ existe: true, avaliacao: rows[0] });
    }
    res.json({ existe: false });
  } catch (err) {
    console.error("Erro ao verificar duplicidade:", err);
    res.status(500).json({ error: "Erro ao verificar duplicidade." });
  }
});

// ─── POST /api/gabarito-avaliacoes ───────────────────────────────────────────
// Cria uma nova avaliação (Etapa 1)
router.post("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const userId = req.user.id || req.user.userId;

    const {
      titulo,
      tipo,
      bimestre,
      num_questoes,
      num_alternativas,
      nota_total,
      modelo,
      gabarito_oficial,
      disciplinas_config,
      turmas_ids,
      turno,
    } = req.body;

    // Validações
    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ error: "Título é obrigatório." });
    }
    const nQ = Number(num_questoes);
    if (!nQ || nQ < 1 || nQ > 100) {
      return res.status(400).json({ error: "Número de questões inválido (1-100)." });
    }
    const nA = Number(num_alternativas);
    if (!nA || nA < 2 || nA > 6) {
      return res.status(400).json({ error: "Alternativas inválidas (2-6)." });
    }

    // Validar disciplinas_config (se fornecido)
    if (disciplinas_config && Array.isArray(disciplinas_config)) {
      for (const dc of disciplinas_config) {
        if (!dc.disciplina_id || !dc.de || !dc.ate) {
          return res.status(400).json({ error: "Configuração de disciplinas inválida." });
        }
        if (dc.de > dc.ate || dc.de < 1 || dc.ate > nQ) {
          return res.status(400).json({
            error: `Faixa de questões inválida para ${dc.nome || "disciplina"}: ${dc.de}–${dc.ate}.`,
          });
        }
      }
    }

    // Determinar status inicial
    const status = gabarito_oficial && Array.isArray(gabarito_oficial) && gabarito_oficial.length === nQ
      ? "publicada"
      : "rascunho";

    const [result] = await pool.query(
      `INSERT INTO gabarito_avaliacoes 
       (escola_id, titulo, tipo, bimestre, num_questoes, num_alternativas, nota_total, 
        modelo, gabarito_oficial, disciplinas_config, turmas_ids, turno, status, criado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        escola_id,
        titulo.trim(),
        tipo || null,
        bimestre || null,
        nQ,
        nA,
        Number(nota_total) || 10,
        modelo || "padrao",
        gabarito_oficial ? JSON.stringify(gabarito_oficial) : null,
        disciplinas_config ? JSON.stringify(disciplinas_config) : null,
        turmas_ids ? JSON.stringify(turmas_ids) : null,
        turno || null,
        status,
        userId,
      ]
    );

    // Retornar o registro criado
    const [created] = await pool.query(
      "SELECT * FROM gabarito_avaliacoes WHERE id = ?",
      [result.insertId]
    );
    const r = created[0];

    res.status(201).json({
      ...r,
      gabarito_oficial: safeJson(r.gabarito_oficial),
      disciplinas_config: safeJson(r.disciplinas_config),
      turmas_ids: safeJson(r.turmas_ids),
    });
  } catch (err) {
    console.error("Erro ao criar avaliação:", err);
    res.status(500).json({ error: "Erro ao criar avaliação." });
  }
});

// ─── PUT /api/gabarito-avaliacoes/:id ────────────────────────────────────────
// Atualiza avaliação (ex: marcar gabarito oficial, alterar status)
router.put("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    // Verificar se existe
    const [existing] = await pool.query(
      "SELECT id, status FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    const {
      titulo,
      bimestre,
      num_questoes,
      num_alternativas,
      nota_total,
      modelo,
      gabarito_oficial,
      disciplinas_config,
      turmas_ids,
      turno,
      status,
    } = req.body;

    // Build dynamic SET clause
    const sets = [];
    const params = [];

    if (titulo !== undefined) { sets.push("titulo = ?"); params.push(titulo.trim()); }
    if (req.body.tipo !== undefined) { sets.push("tipo = ?"); params.push(req.body.tipo); }
    if (bimestre !== undefined) { sets.push("bimestre = ?"); params.push(bimestre); }
    if (num_questoes !== undefined) { sets.push("num_questoes = ?"); params.push(Number(num_questoes)); }
    if (num_alternativas !== undefined) { sets.push("num_alternativas = ?"); params.push(Number(num_alternativas)); }
    if (nota_total !== undefined) { sets.push("nota_total = ?"); params.push(Number(nota_total)); }
    if (modelo !== undefined) { sets.push("modelo = ?"); params.push(modelo); }
    if (gabarito_oficial !== undefined) {
      sets.push("gabarito_oficial = ?");
      params.push(gabarito_oficial ? JSON.stringify(gabarito_oficial) : null);
    }
    if (disciplinas_config !== undefined) {
      sets.push("disciplinas_config = ?");
      params.push(disciplinas_config ? JSON.stringify(disciplinas_config) : null);
    }
    if (turmas_ids !== undefined) {
      sets.push("turmas_ids = ?");
      params.push(turmas_ids ? JSON.stringify(turmas_ids) : null);
    }
    if (turno !== undefined) { sets.push("turno = ?"); params.push(turno); }
    if (status !== undefined) { sets.push("status = ?"); params.push(status); }

    // Auto-update status when gabarito_oficial is set
    if (gabarito_oficial && !status) {
      const nQ = num_questoes || existing[0].num_questoes;
      if (Array.isArray(gabarito_oficial) && gabarito_oficial.length > 0) {
        sets.push("status = ?");
        params.push("publicada");
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "Nenhum campo para atualizar." });
    }

    params.push(id, escola_id);
    await pool.query(
      `UPDATE gabarito_avaliacoes SET ${sets.join(", ")} WHERE id = ? AND escola_id = ?`,
      params
    );

    // Return updated record
    const [updated] = await pool.query(
      "SELECT * FROM gabarito_avaliacoes WHERE id = ?",
      [id]
    );
    const r = updated[0];

    res.json({
      ...r,
      gabarito_oficial: safeJson(r.gabarito_oficial),
      disciplinas_config: safeJson(r.disciplinas_config),
      turmas_ids: safeJson(r.turmas_ids),
    });
  } catch (err) {
    console.error("Erro ao atualizar avaliação:", err);
    res.status(500).json({ error: "Erro ao atualizar avaliação." });
  }
});

// ─── DELETE /api/gabarito-avaliacoes/:id ──────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { id } = req.params;

    const [result] = await pool.query(
      "DELETE FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ? AND status IN ('rascunho', 'publicada')",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({
        error: "Não é possível excluir. A avaliação não existe ou já foi publicada/finalizada.",
      });
    }

    res.json({ ok: true, message: "Avaliação excluída com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir avaliação:", err);
    res.status(500).json({ error: "Erro ao excluir avaliação." });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeJson(val) {
  if (!val) return null;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

export default router;
