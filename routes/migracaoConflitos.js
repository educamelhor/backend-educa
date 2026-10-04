import { Router } from "express";
import pool from "../db.js";

const router = Router();

function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida." });
  }
  next();
}

/**
 * GET /api/migracao-conflitos
 * Lista todos os conflitos de notas da escola
 */
router.get("/", verificarEscola, async (req, res) => {
  try {
    const escola_id = req.user.escola_id;
    const status = req.query.status || 'ABERTO';

    const [rows] = await pool.query(
      `SELECT 
         c.id, c.escola_id, c.aluno_id, a.nome as aluno_nome,
         t.nome as turma_nome, c.ano, c.bimestre, c.disciplina_nome,
         c.nota_id_1, c.nota_id_2, c.status, c.nota_escolhida_id, c.resolvido_em,
         n1.nota as nota_1_valor, n1.faltas as nota_1_faltas, n1.data_lancamento as nota_1_data, d1.etapa as nota_1_etapa,
         n2.nota as nota_2_valor, n2.faltas as nota_2_faltas, n2.data_lancamento as nota_2_data, d2.etapa as nota_2_etapa
       FROM migracao_conflitos_notas c
       JOIN alunos a ON a.id = c.aluno_id
       LEFT JOIN matriculas m ON m.aluno_id = c.aluno_id AND m.escola_id = c.escola_id AND m.ano_letivo = c.ano AND m.status = 'ativo'
       LEFT JOIN turmas t ON t.id = m.turma_id
       LEFT JOIN notas n1 ON n1.id = c.nota_id_1
       LEFT JOIN disciplinas d1 ON d1.id = n1.disciplina_id
       LEFT JOIN notas n2 ON n2.id = c.nota_id_2
       LEFT JOIN disciplinas d2 ON d2.id = n2.disciplina_id
       WHERE c.escola_id = ? AND (? = 'TODOS' OR c.status = ?)
       ORDER BY c.status ASC, t.nome ASC, a.nome ASC, c.bimestre ASC`,
      [escola_id, status, status]
    );

    res.json(rows);
  } catch (error) {
    console.error("Erro ao buscar conflitos de migração:", error);
    res.status(500).json({ message: "Erro interno no servidor." });
  }
});

/**
 * POST /api/migracao-conflitos/:id/resolver
 * Resolver conflito humano de nota
 */
router.post("/:id/resolver", verificarEscola, async (req, res) => {
  try {
    const { id } = req.params;
    const { nota_escolhida_id } = req.body;
    const escola_id = req.user.escola_id;
    const usuario_id = req.user.id || req.user.usuario_id || null;

    if (!nota_escolhida_id) {
      return res.status(400).json({ message: "O ID da nota escolhida é obrigatório." });
    }

    const [[conflito]] = await pool.query(
      `SELECT * FROM migracao_conflitos_notas WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );

    if (!conflito) {
      return res.status(404).json({ message: "Conflito não encontrado." });
    }

    const notaManterId = Number(nota_escolhida_id);
    const notaDescartarId = (notaManterId === conflito.nota_id_1) ? conflito.nota_id_2 : conflito.nota_id_1;

    // Buscar dados da nota a ser descartada para mover para o arquivo
    const [[notaDescartar]] = await pool.query(`SELECT * FROM notas WHERE id = ?`, [notaDescartarId]);

    if (notaDescartar) {
      // 1. Arquivar nota descartada em notas_arquivo_migracao
      await pool.query(
        `INSERT INTO notas_arquivo_migracao 
         (escola_id, aluno_id, disciplina_id, ano, bimestre, nota, faltas, data_lancamento, motivo, resolvido_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Descartada por decisão humana no painel de conflitos', ?)`,
        [notaDescartar.escola_id, notaDescartar.aluno_id, notaDescartar.disciplina_id, notaDescartar.ano, notaDescartar.bimestre, notaDescartar.nota, notaDescartar.faltas, notaDescartar.data_lancamento, usuario_id]
      );

      // 2. Apagar a nota descartada da tabela notas
      await pool.query(`DELETE FROM notas WHERE id = ?`, [notaDescartarId]);
    }

    // 3. Atualizar o registro de conflito para RESOLVIDO
    await pool.query(
      `UPDATE migracao_conflitos_notas 
       SET status = 'RESOLVIDO', nota_escolhida_id = ?, resolvido_em = NOW(), resolvido_por = ?
       WHERE id = ?`,
      [notaManterId, usuario_id, id]
    );

    res.json({ message: "Conflito de nota resolvido com sucesso." });
  } catch (error) {
    console.error("Erro ao resolver conflito de nota:", error);
    res.status(500).json({ message: "Erro interno ao resolver conflito." });
  }
});

export default router;
