// controllers/provasController.js
import pool from '../db.js';

// ── helpers ──────────────────────────────────────────────────────────────────
const escolaFilter = (escola_id) =>
  escola_id ? '(p.escola_id = ? OR p.escola_id IS NULL)' : '1=1';
const escolaParam  = (escola_id) => (escola_id ? [escola_id] : []);

// ── 1) LISTAR provas da escola ────────────────────────────────────────────────
export async function listarProvas(req, res) {
  const { escola_id } = req.user;
  const { status } = req.query;
  try {
    const cond   = [escolaFilter(escola_id)];
    const params = [...escolaParam(escola_id)];
    if (status) { cond.push('p.status = ?'); params.push(status); }

    const [provas] = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM prova_questoes pq WHERE pq.prova_id = p.id) AS total_questoes,
        (SELECT COALESCE(SUM(pq.valor_pontos),0) FROM prova_questoes pq WHERE pq.prova_id = p.id) AS total_pontos
       FROM provas p
       WHERE ${cond.join(' AND ')}
       ORDER BY p.id DESC`,
      params
    );
    res.json(provas);
  } catch (err) {
    console.error('listarProvas:', err);
    res.status(500).json({ message: 'Erro no servidor.' });
  }
}

// ── 2) OBTER prova completa (com questões) ────────────────────────────────────
export async function obterProva(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  try {
    const [[prova]] = await pool.query(
      `SELECT * FROM provas p
       WHERE p.id = ? AND ${escolaFilter(escola_id)}`,
      [id, ...escolaParam(escola_id)]
    );
    if (!prova) return res.status(404).json({ message: 'Prova não encontrada.' });

    const [itens] = await pool.query(
      `SELECT pq.id, pq.ordem, pq.valor_pontos,
              q.id AS questao_id, q.conteudo_bruto, q.tipo, q.nivel,
              q.disciplina, q.alternativas_json, q.correta, q.tags,
              q.habilidade_bncc, q.imagem_base64
       FROM prova_questoes pq
       JOIN questoes q ON q.id = pq.questao_id
       WHERE pq.prova_id = ?
       ORDER BY pq.ordem ASC`,
      [id]
    );
    res.json({ ...prova, itens });
  } catch (err) {
    console.error('obterProva:', err);
    res.status(500).json({ message: 'Erro no servidor.' });
  }
}

// ── 3) CRIAR prova ────────────────────────────────────────────────────────────
export async function criarProva(req, res) {
  const { escola_id, professor_id } = req.user;
  const {
    titulo = 'Nova Prova', disciplina, turma, bimestre,
    ano_letivo, template_slug = 'objetiva_2col', config_json,
  } = req.body;
  try {
    const [r] = await pool.query(
      `INSERT INTO provas
        (escola_id, professor_id, titulo, disciplina, turma, bimestre, ano_letivo, template_slug, config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        escola_id || null, professor_id || null,
        titulo, disciplina || null, turma || null,
        bimestre || null, ano_letivo || new Date().getFullYear(),
        template_slug, config_json ? JSON.stringify(config_json) : null,
      ]
    );
    res.status(201).json({ id: r.insertId, message: 'Prova criada.' });
  } catch (err) {
    console.error('criarProva:', err);
    res.status(500).json({ message: 'Erro ao criar prova.', detail: err.message });
  }
}

// ── 4) ATUALIZAR prova ────────────────────────────────────────────────────────
export async function atualizarProva(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const {
    titulo, disciplina, turma, bimestre, ano_letivo,
    template_slug, config_json, status,
  } = req.body;
  try {
    const [r] = await pool.query(
      `UPDATE provas SET
        titulo = ?, disciplina = ?, turma = ?, bimestre = ?, ano_letivo = ?,
        template_slug = ?, config_json = ?, status = ?, atualizada_em = NOW()
       WHERE id = ? AND ${escolaFilter(escola_id)}`,
      [
        titulo, disciplina || null, turma || null, bimestre || null,
        ano_letivo || null, template_slug || 'objetiva_2col',
        config_json ? JSON.stringify(config_json) : null,
        status || 'montando',
        id, ...escolaParam(escola_id),
      ]
    );
    if (r.affectedRows === 0) return res.status(404).json({ message: 'Prova não encontrada.' });
    res.json({ message: 'Prova atualizada.' });
  } catch (err) {
    console.error('atualizarProva:', err);
    res.status(500).json({ message: 'Erro ao atualizar prova.' });
  }
}

// ── 5) EXCLUIR prova ──────────────────────────────────────────────────────────
export async function excluirProva(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  try {
    const [r] = await pool.query(
      `DELETE FROM provas WHERE id = ? AND ${escolaFilter(escola_id)}`,
      [id, ...escolaParam(escola_id)]
    );
    if (r.affectedRows === 0) return res.status(404).json({ message: 'Prova não encontrada.' });
    res.status(204).end();
  } catch (err) {
    console.error('excluirProva:', err);
    res.status(500).json({ message: 'Erro ao excluir prova.' });
  }
}

// ── 6) ADICIONAR questão à prova ──────────────────────────────────────────────
export async function addQuestaoProva(req, res) {
  const { id } = req.params; // prova_id
  const { questao_id, valor_pontos = 1.0 } = req.body;
  const { professor_id } = req.user || {};
  try {
    const [[{ maxOrdem }]] = await pool.query(
      'SELECT COALESCE(MAX(ordem), 0) AS maxOrdem FROM prova_questoes WHERE prova_id = ?', [id]
    );
    const [r] = await pool.query(
      'INSERT INTO prova_questoes (prova_id, questao_id, ordem, valor_pontos) VALUES (?, ?, ?, ?)',
      [id, questao_id, maxOrdem + 1, valor_pontos]
    );
    // Sprint 5: incrementa contador de uso e registra histórico
    await pool.query(
      'UPDATE questoes SET vezes_utilizada = COALESCE(vezes_utilizada,0) + 1 WHERE id = ?',
      [questao_id]
    );
    pool.query(
      `INSERT IGNORE INTO questoes_historico (questao_id, usuario_id, acao, prova_id, criado_em)
       VALUES (?, ?, 'usou_em_prova', ?, NOW())`,
      [questao_id, professor_id || null, id]
    ).catch(() => {});

    res.status(201).json({ id: r.insertId, ordem: maxOrdem + 1 });
  } catch (err) {
    console.error('addQuestaoProva:', err);
    res.status(500).json({ message: 'Erro ao adicionar questão.', detail: err.message });
  }
}


// ── 7) REMOVER questão da prova ───────────────────────────────────────────────
export async function removeQuestaoProva(req, res) {
  const { id, itemId } = req.params;
  try {
    await pool.query('DELETE FROM prova_questoes WHERE id = ? AND prova_id = ?', [itemId, id]);
    res.status(204).end();
  } catch (err) {
    console.error('removeQuestaoProva:', err);
    res.status(500).json({ message: 'Erro ao remover questão.' });
  }
}

// ── 8) ATUALIZAR item (pontos) ────────────────────────────────────────────────
export async function atualizarItemProva(req, res) {
  const { id, itemId } = req.params;
  const { valor_pontos } = req.body;
  try {
    await pool.query(
      'UPDATE prova_questoes SET valor_pontos = ? WHERE id = ? AND prova_id = ?',
      [valor_pontos, itemId, id]
    );
    res.json({ message: 'Item atualizado.' });
  } catch (err) {
    console.error('atualizarItemProva:', err);
    res.status(500).json({ message: 'Erro ao atualizar item.' });
  }
}

// ── 9) REORDENAR questões ─────────────────────────────────────────────────────
export async function reordenarProva(req, res) {
  const { id } = req.params;
  const { ordem } = req.body; // [{id: itemId, ordem: N}, ...]
  if (!Array.isArray(ordem)) return res.status(400).json({ message: 'Payload inválido.' });
  try {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    for (const item of ordem) {
      await conn.query(
        'UPDATE prova_questoes SET ordem = ? WHERE id = ? AND prova_id = ?',
        [item.ordem, item.id, id]
      );
    }
    await conn.commit();
    conn.release();
    res.json({ message: 'Reordenado.' });
  } catch (err) {
    console.error('reordenarProva:', err);
    res.status(500).json({ message: 'Erro ao reordenar.' });
  }
}
