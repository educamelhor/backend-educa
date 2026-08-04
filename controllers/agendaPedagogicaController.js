import pool from '../db.js';

export const listarEventos = async (req, res) => {
  try {
    const escola_id = req.user.escola_id;
    const { tema, limit } = req.query;

    let query = 'SELECT * FROM agenda_pedagogica WHERE escola_id = ?';
    let params = [escola_id];

    if (tema) {
      query += ' AND tema = ?';
      params.push(tema);
    }

    query += ' ORDER BY data_inicio ASC';

    if (limit) {
      query += ' LIMIT ?';
      params.push(parseInt(limit, 10));
    }

    // MySQL promise pool returns [rows, fields]
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Erro em listarEventos:', error);
    res.status(500).json({ error: 'Erro ao buscar agenda' });
  }
};

export const criarEvento = async (req, res) => {
  try {
    const escola_id = req.user.escola_id;
    const { tema, titulo, bimestre, data_inicio, data_fim, descricao } = req.body;

    const query = `
      INSERT INTO agenda_pedagogica (escola_id, tema, titulo, bimestre, data_inicio, data_fim, descricao)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const [result] = await pool.query(query, [
      escola_id, tema, titulo, bimestre || null, data_inicio, data_fim || null, descricao || null
    ]);

    // Buscar o evento recém-criado
    const [rows] = await pool.query('SELECT * FROM agenda_pedagogica WHERE id = ?', [result.insertId]);

    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Erro em criarEvento:', error);
    res.status(500).json({ error: 'Erro ao criar evento' });
  }
};

export const atualizarEvento = async (req, res) => {
  try {
    const escola_id = req.user.escola_id;
    const { id } = req.params;
    const { titulo, bimestre, data_inicio, data_fim, descricao } = req.body;

    const query = `
      UPDATE agenda_pedagogica
      SET titulo = ?, bimestre = ?, data_inicio = ?, data_fim = ?, descricao = ?
      WHERE id = ? AND escola_id = ?
    `;
    const [result] = await pool.query(query, [
      titulo, bimestre || null, data_inicio, data_fim || null, descricao || null, id, escola_id
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Evento não encontrado' });
    }

    const [rows] = await pool.query('SELECT * FROM agenda_pedagogica WHERE id = ?', [id]);
    res.json(rows[0]);
  } catch (error) {
    console.error('Erro em atualizarEvento:', error);
    res.status(500).json({ error: 'Erro ao atualizar evento' });
  }
};

export const excluirEvento = async (req, res) => {
  try {
    const escola_id = req.user.escola_id;
    const { id } = req.params;

    const query = 'DELETE FROM agenda_pedagogica WHERE id = ? AND escola_id = ?';
    const [result] = await pool.query(query, [id, escola_id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Evento não encontrado' });
    }

    res.json({ message: 'Evento excluído com sucesso' });
  } catch (error) {
    console.error('Erro em excluirEvento:', error);
    res.status(500).json({ error: 'Erro ao excluir evento' });
  }
};
