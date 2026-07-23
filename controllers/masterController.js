import pool from '../db.js';

export const listarMaster = async (req, res) => {
  try {
    const { disciplina, nivel, conteudo, tema, status, after_id = 0, limit = 20 } = req.query;
    const l = Math.min(Number(limit) || 20, 50);
    const after = Number(after_id) || 0;
    
    let query = 'SELECT * FROM questoes_master WHERE id > ?';
    const params = [after];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    } else {
      query += ' AND status != ?';
      params.push('arquivado');
    }

    if (disciplina) { query += ' AND disciplina = ?'; params.push(disciplina); }
    if (nivel) { query += ' AND nivel = ?'; params.push(nivel); }
    if (conteudo) { query += ' AND conteudo = ?'; params.push(conteudo); }
    if (tema) { query += ' AND tema = ?'; params.push(tema); }

    query += ' ORDER BY id ASC LIMIT ?';
    params.push(l + 1);

    const [rows] = await pool.query(query, params);
    
    let has_more = false;
    let data = rows;
    if (rows.length > l) {
      has_more = true;
      data = rows.slice(0, l);
    }
    
    const next_cursor = data.length > 0 ? data[data.length - 1].id : null;

    res.json({ data, next_cursor, has_more });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const obterMaster = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM questoes_master WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const criarMasterQuestao = async (req, res) => {
  try {
    const { disciplina, conteudo, tema, nivel, enunciado, gabarito_comentado, fonte, temas, tipo = 'objetiva', alternativas_json, correta } = req.body;
    
    const [result] = await pool.query(
      `INSERT INTO questoes_master (disciplina, conteudo, tema, nivel, enunciado, gabarito_comentado, fonte, tipo, alternativas_json, correta, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rascunho')`,
      [disciplina, conteudo, tema, nivel, enunciado, gabarito_comentado, fonte, tipo, JSON.stringify(alternativas_json) || null, correta || null]
    );
    
    const insertId = result.insertId;
    const codigo = `EMQM-${insertId.toString().padStart(5, '0')}`;
    
    await pool.query('UPDATE questoes_master SET codigo = ? WHERE id = ?', [codigo, insertId]);
    
    if (Array.isArray(temas) && temas.length > 0) {
      const temasRows = temas.filter(Boolean).map(t => [insertId, String(t).slice(0, 100)]);
      if (temasRows.length > 0) await pool.query('INSERT INTO questao_master_temas (questao_id, tema) VALUES ?', [temasRows]);
    }
    
    res.status(201).json({ id: insertId, codigo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const editarMaster = async (req, res) => {
  try {
    const { id } = req.params;
    const { temas, ...fields } = req.body;
    
    if (Object.keys(fields).length > 0) {
      const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
      const values = Object.values(fields).map(v => typeof v === 'object' ? JSON.stringify(v) : v);
      await pool.query(`UPDATE questoes_master SET ${setClause} WHERE id = ?`, [...values, id]);
    }
    
    if (temas && Array.isArray(temas)) {
      await pool.query('DELETE FROM questao_master_temas WHERE questao_id = ?', [id]);
      const temasRows = temas.filter(Boolean).map(t => [id, String(t).slice(0, 100)]);
      if (temasRows.length > 0) await pool.query('INSERT INTO questao_master_temas (questao_id, tema) VALUES ?', [temasRows]);
    }
    
    res.json({ message: 'Atualizado com sucesso' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const publicarMaster = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT status FROM questoes_master WHERE id = ?', [id]);
    
    if (rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
    if (rows[0].status === 'publicado') return res.status(400).json({ error: 'Já publicado' });
    
    const revisor = req.user?.nome || 'CEO';
    await pool.query(
      `UPDATE questoes_master SET status = 'publicado', publicada_em = NOW(), revisada_por = ? WHERE id = ?`,
      [revisor, id]
    );
    
    const [updated] = await pool.query('SELECT * FROM questoes_master WHERE id = ?', [id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const excluirMaster = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT status FROM questoes_master WHERE id = ?', [id]);
    
    if (rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
    if (rows[0].status !== 'rascunho') return res.status(400).json({ error: 'Apenas rascunhos podem ser excluídos' });
    
    await pool.query('DELETE FROM questao_master_temas WHERE questao_id = ?', [id]);
    await pool.query('DELETE FROM questoes_master WHERE id = ?', [id]);
    
    res.json({ message: 'Excluído com sucesso' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const buscarMaster = async (req, res) => {
  try {
    const { q, disciplina, nivel, conteudo, tema, after_id = 0, limit = 20 } = req.query;
    const l = Math.min(Number(limit) || 20, 50);
    const after = Number(after_id) || 0;
    
    let query = `SELECT id, codigo, disciplina, area_conhecimento, conteudo, tema, subtema, nivel, serie, habilidade_bncc, palavras_chave, tipo, enunciado, imagem_url, texto_apoio, alternativas_json, correta, fonte, fonte_tipo, ano_fonte, status, criada_por, revisada_por, publicada_em, criada_em, atualizada_em, visualizacoes
                 FROM questoes_master WHERE status = 'publicado' AND id > ?`;
    const params = [after];
    
    if (q) {
      query += ' AND MATCH(enunciado, gabarito_comentado) AGAINST (? IN BOOLEAN MODE)';
      params.push(q);
    }
    
    if (disciplina) { query += ' AND disciplina = ?'; params.push(disciplina); }
    if (nivel) { query += ' AND nivel = ?'; params.push(nivel); }
    if (conteudo) { query += ' AND conteudo = ?'; params.push(conteudo); }
    if (tema) { query += ' AND tema = ?'; params.push(tema); }
    
    query += ' ORDER BY id ASC LIMIT ?';
    params.push(l + 1);
    
    const [rows] = await pool.query(query, params);
    
    let has_more = false;
    let data = rows;
    if (rows.length > l) {
      has_more = true;
      data = rows.slice(0, l);
    }
    
    const next_cursor = data.length > 0 ? data[data.length - 1].id : null;
    
    res.json({ data, next_cursor, has_more });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const importarLoteMaster = async (req, res) => {
  try {
    const { questoes } = req.body;
    if (!Array.isArray(questoes) || questoes.length === 0) return res.status(400).json({ error: 'Lote vazio' });
    
    let inseridas = 0;
    let codigos = [];
    
    for (const q of questoes) {
      const [result] = await pool.query(
        `INSERT INTO questoes_master (disciplina, conteudo, tema, nivel, enunciado, gabarito_comentado, fonte, tipo, alternativas_json, correta, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rascunho')`,
        [q.disciplina, q.conteudo, q.tema, q.nivel, q.enunciado, q.gabarito_comentado, q.fonte, q.tipo || 'objetiva', JSON.stringify(q.alternativas_json) || null, q.correta || null]
      );
      const insertId = result.insertId;
      const codigo = `EMQM-${insertId.toString().padStart(5, '0')}`;
      await pool.query('UPDATE questoes_master SET codigo = ? WHERE id = ?', [codigo, insertId]);
      
      inseridas++;
      codigos.push(codigo);
    }
    
    res.json({ inseridas, codigos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
