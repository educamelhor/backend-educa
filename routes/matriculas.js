// routes/matriculas.js
// ──────────────────────────────────────────────────────────────────────────────
// EDUCA.MELHOR — Router dedicado para matrículas
//
// Lógica de Ano Letivo padrão (data de corte 31/jan):
//   Se mês atual é janeiro → ano letivo = anoCorrente - 1
//   Caso contrário         → ano letivo = anoCorrente
//
// Endpoints:
//   GET  /api/matriculas/anos          — anos letivos disponíveis para a escola
//   GET  /api/matriculas               — matrículas filtráveis (aluno, ano, turma)
//   POST /api/matriculas               — cria ou atualiza matrícula
//   PUT  /api/matriculas/:id           — atualiza status de matrícula existente
// ──────────────────────────────────────────────────────────────────────────────

import express from "express";
import pool from "../db.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: calcula o ano letivo padrão com data de corte em 31/jan
// ─────────────────────────────────────────────────────────────────────────────
function anoLetivoPadrao() {
    const hoje = new Date();
    const mes = hoje.getMonth() + 1; // 1–12
    return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/matriculas/anos
// Retorna lista de anos letivos disponíveis para a escola (para popular filtros UI)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/anos", async (req, res) => {
    try {
        const { escola_id } = req.user;
        const [rows] = await pool.query(
            `SELECT DISTINCT ano_letivo
         FROM matriculas
        WHERE escola_id = ?
        ORDER BY ano_letivo DESC`,
            [escola_id]
        );
        const anos = rows.map((r) => Number(r.ano_letivo));
        // Garante que o ano padrão sempre aparece (mesmo que ainda não haja matrículas)
        const padrao = anoLetivoPadrao();
        if (!anos.includes(padrao)) anos.unshift(padrao);
        return res.json(anos);
    } catch (err) {
        console.error("[matriculas] Erro ao listar anos:", err);
        return res.status(500).json({ message: "Erro ao buscar anos letivos." });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/matriculas?aluno_id=&ano_letivo=&turma_id=
// Histórico de matrículas (filtrável). Usado para exibir histórico de um aluno.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
    try {
        const { escola_id } = req.user;
        const { aluno_id, ano_letivo, turma_id } = req.query;

        const where = ["m.escola_id = ?"];
        const params = [escola_id];

        if (aluno_id) { where.push("m.aluno_id = ?"); params.push(Number(aluno_id)); }
        if (turma_id) { where.push("m.turma_id = ?"); params.push(Number(turma_id)); }
        if (ano_letivo) { where.push("m.ano_letivo = ?"); params.push(Number(ano_letivo)); }

        const [rows] = await pool.query(
            `SELECT
         m.id,
         m.aluno_id,
         m.turma_id,
         m.ano_letivo,
         m.status,
         m.created_at,
         a.codigo       AS aluno_codigo,
         a.estudante    AS aluno_nome,
         t.nome         AS turma_nome,
         t.turno        AS turma_turno,
         t.serie        AS turma_serie
       FROM matriculas m
       JOIN alunos  a ON a.id = m.aluno_id
       JOIN turmas  t ON t.id = m.turma_id
       WHERE ${where.join(" AND ")}
       ORDER BY m.ano_letivo DESC, a.estudante`,
            params
        );
        return res.json(rows);
    } catch (err) {
        console.error("[matriculas] Erro ao listar:", err);
        return res.status(500).json({ message: "Erro ao buscar matrículas." });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/matriculas
// Body: { aluno_id, turma_id, ano_letivo?, status? }
// Cria nova matrícula ou atualiza caso já exista (idempotente via ON DUPLICATE KEY)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
    try {
        const { escola_id } = req.user;
        const {
            aluno_id,
            turma_id,
            ano_letivo = anoLetivoPadrao(),
            status = "ativo",
        } = req.body;

        if (!aluno_id || !turma_id) {
            return res
                .status(400)
                .json({ message: "aluno_id e turma_id são obrigatórios." });
        }

        const [result] = await pool.query(
            `INSERT INTO matriculas (escola_id, aluno_id, turma_id, ano_letivo, status)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status     = VALUES(status),
         updated_at = CURRENT_TIMESTAMP`,
            [escola_id, Number(aluno_id), Number(turma_id), Number(ano_letivo), status]
        );

        // Retorna o id inserido ou atualizado
        const id = result.insertId || null;
        return res.status(201).json({
            message: "Matrícula registrada com sucesso.",
            id,
            aluno_id: Number(aluno_id),
            turma_id: Number(turma_id),
            ano_letivo: Number(ano_letivo),
            status,
        });
    } catch (err) {
        console.error("[matriculas] Erro ao criar:", err);
        return res.status(500).json({ message: "Erro ao registrar matrícula." });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/matriculas/:id
// Body: { status?, turma_id? }
// Atualiza campos de uma matrícula existente (troca de turma, mudança de status)
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
    try {
        const { escola_id } = req.user;
        const { id } = req.params;
        const { status, turma_id } = req.body;

        const campos = [];
        const valores = [];

        if (typeof status !== "undefined") { campos.push("status = ?"); valores.push(status); }
        if (typeof turma_id !== "undefined") { campos.push("turma_id = ?"); valores.push(Number(turma_id)); }

        if (campos.length === 0) {
            return res.status(400).json({ message: "Nenhum campo para atualizar." });
        }

        valores.push(Number(id), escola_id);
        const [result] = await pool.query(
            `UPDATE matriculas
          SET ${campos.join(", ")}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND escola_id = ?`,
            valores
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Matrícula não encontrada." });
        }
        return res.json({ message: "Matrícula atualizada com sucesso." });
    } catch (err) {
        console.error("[matriculas] Erro ao atualizar:", err);
        return res.status(500).json({ message: "Erro ao atualizar matrícula." });
    }
});

export default router;
