// routes/secretaria-faltas.js
// ============================================================================
// Submódulo FALTAS — Secretaria
// Gestão e consolidação de faltas por turno, turma e bimestre.
// ============================================================================

import express from 'express';
import pool from '../db.js';

const router = express.Router();

function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

/**
 * GET /api/secretaria/faltas/turma/:turmaId
 * Retorna os estudantes da turma com o total de faltas por bimestre e detalhamento por disciplina.
 */
router.get('/turma/:turmaId', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const turmaId = Number(req.params.turmaId);
    const anoEfetivo = req.query.ano || req.query.ano_letivo ? Number(req.query.ano || req.query.ano_letivo) : anoLetivoPadrao();

    if (!turmaId || Number.isNaN(turmaId)) {
      return res.status(400).json({ ok: false, message: 'ID da turma inválido.' });
    }

    // 1. Dados da turma
    const [[turma]] = await pool.query(
      `SELECT id, nome, serie, turno, etapa, ano, COALESCE(regime, 'anual') AS regime
       FROM turmas
       WHERE id = ? AND escola_id = ?
       LIMIT 1`,
      [turmaId, escola_id]
    );

    if (!turma) {
      return res.status(404).json({ ok: false, message: 'Turma não encontrada nesta escola.' });
    }

    // 2. Busca estudantes vinculados à turma (matriculas ativas ou alunos.turma_id)
    const sqlAlunos = `
      SELECT DISTINCT
        a.id AS aluno_id,
        a.codigo,
        a.estudante AS nome,
        a.foto,
        a.status
      FROM alunos a
      LEFT JOIN matriculas m 
        ON m.aluno_id = a.id 
       AND m.escola_id = a.escola_id 
       AND m.ano_letivo = ?
       AND m.status IN ('ativo', 'matriculado')
      WHERE (m.turma_id = ? OR (m.turma_id IS NULL AND a.turma_id = ?))
        AND a.escola_id = ?
        AND (a.status = 'ativo' OR a.status IS NULL)
      ORDER BY a.estudante ASC
    `;

    const [alunos] = await pool.query(sqlAlunos, [anoEfetivo, turmaId, turmaId, escola_id]);

    if (!alunos.length) {
      return res.json({
        ok: true,
        turma,
        ano_letivo: anoEfetivo,
        total_alunos: 0,
        estudantes: [],
      });
    }

    const alunoIds = alunos.map((al) => al.aluno_id);

    // 3. Busca faltas na tabela notas agrupadas por aluno, disciplina e bimestre
    const [notasRows] = await pool.query(
      `SELECT
         n.aluno_id,
         n.disciplina_id,
         d.nome AS disciplina_nome,
         n.bimestre,
         COALESCE(n.faltas, 0) AS faltas
       FROM notas n
       LEFT JOIN disciplinas d ON d.id = n.disciplina_id
       WHERE n.aluno_id IN (?)
         AND n.escola_id = ?
         AND n.ano = ?
         AND n.faltas IS NOT NULL
       ORDER BY d.nome ASC`,
      [alunoIds, escola_id, anoEfetivo]
    );

    // 4. Busca atestados / justificativas de faltas (frequencia_justificativas)
    let justificativasMap = {};
    try {
      const [justRows] = await pool.query(
        `SELECT
           aluno_id,
           COALESCE(SUM(dias), 0) AS total_justificadas,
           COUNT(id) AS qtd_atestados
         FROM frequencia_justificativas
         WHERE aluno_id IN (?)
           AND escola_id = ?
           AND YEAR(data_inicio) = ?
         GROUP BY aluno_id`,
        [alunoIds, escola_id, anoEfetivo]
      );
      for (const j of justRows) {
        justificativasMap[j.aluno_id] = {
          dias: Number(j.total_justificadas || 0),
          qtd: Number(j.qtd_atestados || 0),
        };
      }
    } catch (_) {
      // Ignora caso a tabela ainda não exista em algum ambiente legado
    }

    // 5. Agrega faltas por aluno
    // Estrutura por aluno:
    // { b1: 0, b2: 0, b3: 0, b4: 0, total: 0, disciplinas: { [discId]: { nome, b1, b2, b3, b4, total } } }
    const faltasPorAluno = {};
    for (const id of alunoIds) {
      faltasPorAluno[id] = {
        b1: 0,
        b2: 0,
        b3: 0,
        b4: 0,
        total: 0,
        disciplinas: {},
      };
    }

    for (const r of notasRows) {
      const aId = r.aluno_id;
      const bNum = Number(r.bimestre);
      const faltasNum = Number(r.faltas || 0);
      const dNome = r.disciplina_nome || 'Sem disciplina';
      const dId = r.disciplina_id || dNome;

      if (!faltasPorAluno[aId]) continue;

      // Soma por bimestre global
      if (bNum === 1) faltasPorAluno[aId].b1 += faltasNum;
      else if (bNum === 2) faltasPorAluno[aId].b2 += faltasNum;
      else if (bNum === 3) faltasPorAluno[aId].b3 += faltasNum;
      else if (bNum === 4) faltasPorAluno[aId].b4 += faltasNum;
      faltasPorAluno[aId].total += faltasNum;

      // Detalhamento por disciplina
      if (!faltasPorAluno[aId].disciplinas[dId]) {
        faltasPorAluno[aId].disciplinas[dId] = {
          id: dId,
          nome: dNome,
          b1: 0,
          b2: 0,
          b3: 0,
          b4: 0,
          total: 0,
        };
      }

      if (bNum === 1) faltasPorAluno[aId].disciplinas[dId].b1 += faltasNum;
      else if (bNum === 2) faltasPorAluno[aId].disciplinas[dId].b2 += faltasNum;
      else if (bNum === 3) faltasPorAluno[aId].disciplinas[dId].b3 += faltasNum;
      else if (bNum === 4) faltasPorAluno[aId].disciplinas[dId].b4 += faltasNum;
      faltasPorAluno[aId].disciplinas[dId].total += faltasNum;
    }

    // 6. Monta o resultado final formatado
    const estudantes = alunos.map((al) => {
      const f = faltasPorAluno[al.aluno_id] || { b1: 0, b2: 0, b3: 0, b4: 0, total: 0, disciplinas: {} };
      const just = justificativasMap[al.aluno_id] || { dias: 0, qtd: 0 };
      const listaDisciplinas = Object.values(f.disciplinas);

      return {
        aluno_id: al.aluno_id,
        codigo: al.codigo || '—',
        nome: al.nome,
        foto: al.foto || null,
        status: al.status || 'ativo',
        faltas: {
          b1: f.b1,
          b2: f.b2,
          b3: f.b3,
          b4: f.b4,
          total: f.total,
        },
        justificadas: just,
        disciplinas: listaDisciplinas,
      };
    });

    return res.json({
      ok: true,
      turma,
      ano_letivo: anoEfetivo,
      total_alunos: estudantes.length,
      estudantes,
    });
  } catch (err) {
    console.error('[secretaria-faltas] Erro ao buscar faltas da turma:', err);
    return res.status(500).json({ ok: false, message: 'Erro interno ao consultar faltas da turma.' });
  }
});

export default router;
