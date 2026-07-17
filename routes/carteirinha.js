import express from "express";
import jwt from "jsonwebtoken";
import pool from "../db.js";

const router = express.Router();

const APP_PAIS_JWT_SECRET = process.env.APP_PAIS_JWT_SECRET || "DEV_ONLY__app_pais_jwt_secret_2025";

// GET /public/verificar-aluno/:token
router.get("/verificar-aluno/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const payload = jwt.verify(token, APP_PAIS_JWT_SECRET);

    if (payload.tipo !== "CARTEIRINHA" && payload.tipo !== "ALUNO") {
      return res.status(400).json({ ok: false, message: "Token inválido para carteirinha." });
    }

    const { aluno_id } = payload;

    if (!aluno_id) {
      return res.status(400).json({ ok: false, message: "Aluno não identificado no token." });
    }

    // Mesma estrutura da rota /me — usa turma_id direto no aluno, não a tabela matriculas
    const query = `
      SELECT
        a.id,
        a.estudante     AS nome,
        a.foto,
        a.data_nascimento,
        a.codigo        AS matricula,
        a.status        AS aluno_status,
        t.nome          AS turma,
        e.nome          AS escola_nome,
        YEAR(CURDATE()) AS ano_letivo
      FROM alunos a
      LEFT JOIN turmas  t ON t.id = a.turma_id
      LEFT JOIN escolas e ON e.id = a.escola_id
      WHERE a.id = ?
      LIMIT 1
    `;

    const [rows] = await pool.query(query, [aluno_id]);

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Aluno não encontrado." });
    }

    const aluno = rows[0];

    // Valida pelo status do próprio aluno (campo 'status' = 'ativo')
    if (!aluno.aluno_status || aluno.aluno_status.toLowerCase() !== 'ativo') {
      return res.status(403).json({
        ok: false,
        message: "Carteirinha inválida: Aluno inativo ou desmatriculado."
      });
    }

    return res.json({
      ok: true,
      aluno: {
        id: aluno.id,
        nome: aluno.nome,
        foto: aluno.foto,
        escola_nome: aluno.escola_nome,
        turma: aluno.turma,
        status: aluno.aluno_status,
        ano_letivo: aluno.ano_letivo,
        matricula: aluno.matricula,
        data_nascimento: aluno.data_nascimento
      }
    });

  } catch (error) {
    console.error("[CARTEIRINHA] Erro ao verificar token:", error);
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ ok: false, message: "Carteirinha expirada." });
    }
    return res.status(401).json({ ok: false, message: "Token inválido ou adulterado." });
  }
});

export default router;
