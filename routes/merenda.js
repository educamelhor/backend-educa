import express from "express";
import pool from "../db.js";

const router = express.Router();

// ============================================================================
// [GET] /api/merenda/produtos
// Lista todos os produtos cadastrados da escola
// ============================================================================
router.get("/produtos", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  
  if (!escola_id) {
    return res.status(400).json({ error: "escola_id não fornecido no token." });
  }

  try {
    const [rows] = await pool.query(
      "SELECT * FROM merenda_produtos WHERE escola_id = ? ORDER BY produto ASC",
      [escola_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("[GET /api/merenda/produtos] Erro:", err);
    return res.status(500).json({ error: "Erro ao buscar produtos." });
  }
});

// ============================================================================
// [POST] /api/merenda/produtos
// Cria um novo produto
// ============================================================================
router.post("/produtos", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  const { produto, categoria, gramatura, marca, validade, lote } = req.body;

  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });
  if (!produto || !categoria) return res.status(400).json({ error: "Produto e Categoria são obrigatórios." });

  // Se a validade estiver em branco (""), passamos null para o BD
  let valFinal = validade && validade.trim() !== "" ? validade : null;
  if (valFinal && valFinal.length > 10) valFinal = valFinal.substring(0, 10);

  try {
    const [result] = await pool.query(
      `INSERT INTO merenda_produtos 
        (escola_id, produto, categoria, gramatura, marca, validade, lote)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, produto, categoria, gramatura || null, marca || null, valFinal, lote || null]
    );

    return res.status(201).json({ 
      message: "Produto cadastrado com sucesso",
      id: result.insertId 
    });
  } catch (err) {
    console.error("[POST /api/merenda/produtos] Erro:", err);
    return res.status(500).json({ error: "Erro ao criar produto." });
  }
});

// ============================================================================
// [PUT] /api/merenda/produtos/:id
// Atualiza um produto existente
// ============================================================================
router.put("/produtos/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  const { id } = req.params;
  const { produto, categoria, gramatura, marca, validade, lote } = req.body;

  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });
  if (!produto || !categoria) return res.status(400).json({ error: "Produto e Categoria são obrigatórios." });

  let valFinal = validade && validade.trim() !== "" ? validade : null;
  if (valFinal && valFinal.length > 10) valFinal = valFinal.substring(0, 10);

  try {
    const [result] = await pool.query(
      `UPDATE merenda_produtos 
       SET produto = ?, categoria = ?, gramatura = ?, marca = ?, validade = ?, lote = ?
       WHERE id = ? AND escola_id = ?`,
      [produto, categoria, gramatura || null, marca || null, valFinal, lote || null, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Produto não encontrado ou não pertence a esta escola." });
    }

    return res.json({ message: "Produto atualizado com sucesso" });
  } catch (err) {
    console.error("[PUT /api/merenda/produtos/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao atualizar produto." });
  }
});

// ============================================================================
// [DELETE] /api/merenda/produtos/:id
// Exclui um produto
// ============================================================================
router.delete("/produtos/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  const { id } = req.params;

  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [result] = await pool.query(
      "DELETE FROM merenda_produtos WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Produto não encontrado ou não pertence a esta escola." });
    }

    return res.json({ message: "Produto excluído com sucesso" });
  } catch (err) {
    console.error("[DELETE /api/merenda/produtos/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao excluir produto." });
  }
});

// ============================================================================
// [GET] /api/merenda/entradas
// Lista as chegadas de gêneros
// ============================================================================
router.get("/entradas", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [rows] = await pool.query(
      `SELECT e.*, p.produto, p.marca, p.categoria, p.gramatura 
       FROM merenda_entradas e
       JOIN merenda_produtos p ON e.produto_id = p.id
       WHERE e.escola_id = ?
       ORDER BY e.created_at DESC`,
      [escola_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("[GET /api/merenda/entradas] Erro:", err);
    return res.status(500).json({ error: "Erro ao buscar chegadas." });
  }
});

// ============================================================================
// [POST] /api/merenda/entradas
// Registra uma nova chegada (com suporte a múltiplos lotes)
// ============================================================================
router.post("/entradas", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  const { produto_id, origem, data_chegada, lotes } = req.body;

  if (!produto_id || !lotes || !Array.isArray(lotes) || lotes.length === 0) {
    return res.status(400).json({ error: "produto_id e array de lotes são obrigatórios." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    for (const item of lotes) {
      let { quantidade_unidades, peso_kg, lote, validade } = item;
      
      let valFinal = validade && validade.trim() !== "" ? validade : null;
      if (valFinal && valFinal.length > 10) valFinal = valFinal.substring(0, 10);

      let createdAtStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (data_chegada && data_chegada.trim() !== "") {
        createdAtStr = `${data_chegada.trim()} 12:00:00`;
      }

      await connection.query(
        `INSERT INTO merenda_entradas 
         (escola_id, produto_id, quantidade_unidades, peso_kg, lote, validade, origem, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [escola_id, produto_id, quantidade_unidades, peso_kg, lote || null, valFinal, origem || 'Governo (SEEDF)', createdAtStr]
      );
    }

    await connection.commit();
    return res.status(201).json({ message: "Chegada registrada com sucesso" });
  } catch (err) {
    await connection.rollback();
    console.error("[POST /api/merenda/entradas] Erro:", err);
    return res.status(500).json({ error: "Erro ao registrar chegada." });
  } finally {
    connection.release();
  }
});

// ============================================================================
// [PUT] /api/merenda/entradas/:id
// Edita uma chegada existente
// ============================================================================
router.put("/entradas/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  const { id } = req.params;
  const { quantidade_unidades, peso_kg, lote, validade, origem, data_chegada } = req.body;

  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  let valFinal = validade && validade.trim() !== "" ? validade : null;
  if (valFinal && valFinal.length > 10) valFinal = valFinal.substring(0, 10);

  try {
    let createdAtStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (data_chegada && data_chegada.trim() !== "") {
      createdAtStr = `${data_chegada.trim()} 12:00:00`;
    }

    const [result] = await pool.query(
      `UPDATE merenda_entradas 
       SET quantidade_unidades = ?, peso_kg = ?, lote = ?, validade = ?, origem = ?, created_at = ? 
       WHERE id = ? AND escola_id = ?`,
      [quantidade_unidades, peso_kg, lote || null, valFinal, origem || 'Governo (SEEDF)', createdAtStr, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Entrada não encontrada ou não pertence a esta escola." });
    }

    return res.json({ message: "Entrada atualizada com sucesso" });
  } catch (err) {
    console.error("[PUT /api/merenda/entradas/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao atualizar entrada." });
  }
});

// ============================================================================
// [DELETE] /api/merenda/entradas/:id
// Exclui uma chegada
// ============================================================================
router.delete("/entradas/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  const { id } = req.params;

  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [result] = await pool.query(
      "DELETE FROM merenda_entradas WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Entrada não encontrada ou não pertence a esta escola." });
    }

    return res.json({ message: "Entrada excluída com sucesso" });
  } catch (err) {
    console.error("[DELETE /api/merenda/entradas/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao excluir entrada." });
  }
});

// ============================================================================
// [GET] /api/merenda/estoque
// Lista os produtos em estoque (saldo_unidades > 0)
// ============================================================================
router.get("/estoque", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [rows] = await pool.query(
      `SELECT v.*, p.produto, p.marca, p.categoria, p.gramatura 
       FROM view_merenda_estoque_lotes v
       JOIN merenda_produtos p ON v.produto_id = p.id
       WHERE v.escola_id = ? AND v.saldo_unidades > 0
       ORDER BY p.produto ASC, v.validade ASC`,
      [escola_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("[GET /api/merenda/estoque] Erro:", err);
    return res.status(500).json({ error: "Erro ao buscar saldo de estoque." });
  }
});

// ============================================================================
// [GET] /api/merenda/saidas
// Lista o histórico de movimentação (saídas)
// ============================================================================
router.get("/saidas", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [rows] = await pool.query(
      `SELECT s.*, p.produto, p.marca, p.categoria, p.gramatura 
       FROM merenda_saidas s
       JOIN merenda_produtos p ON s.produto_id = p.id
       WHERE s.escola_id = ?
       ORDER BY s.created_at DESC`,
      [escola_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("[GET /api/merenda/saidas] Erro:", err);
    return res.status(500).json({ error: "Erro ao buscar histórico de movimentação." });
  }
});

// ============================================================================
// [POST] /api/merenda/saidas
// Registra uma nova movimentação de saída
// ============================================================================
router.post("/saidas", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  const { produto_id, lote, validade, quantidade_unidades, peso_kg, tipo_movimentacao, observacao } = req.body;

  if (!produto_id || !quantidade_unidades || !tipo_movimentacao) {
    return res.status(400).json({ error: "Dados incompletos para registrar movimentação." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    let valFinal = validade && validade.trim() !== "" ? validade : null;
    if (valFinal && valFinal.length > 10) valFinal = valFinal.substring(0, 10);

    // 1. Verifica saldo atual
    const [estoque] = await connection.query(
      `SELECT saldo_unidades 
       FROM view_merenda_estoque_lotes 
       WHERE escola_id = ? 
         AND produto_id = ? 
         AND IFNULL(lote, '') = IFNULL(?, '') 
         AND IFNULL(validade, '1900-01-01') = IFNULL(?, '1900-01-01')`,
      [escola_id, produto_id, lote || null, valFinal]
    );

    const saldoDisponivel = estoque.length > 0 ? Number(estoque[0].saldo_unidades) : 0;
    const qtdRetirar = Number(quantidade_unidades);

    if (qtdRetirar > saldoDisponivel) {
      await connection.rollback();
      return res.status(400).json({ 
        error: `Saldo insuficiente para o lote selecionado. Você tentou retirar ${qtdRetirar}, mas só há ${saldoDisponivel} disponível.` 
      });
    }

    // 2. Insere saída
    await connection.query(
      `INSERT INTO merenda_saidas 
       (escola_id, produto_id, lote, validade, quantidade_unidades, peso_kg, tipo_movimentacao, observacao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [escola_id, produto_id, lote || null, valFinal, qtdRetirar, peso_kg || 0, tipo_movimentacao, observacao || null]
    );

    await connection.commit();
    return res.status(201).json({ message: "Movimentação registrada com sucesso" });
  } catch (err) {
    await connection.rollback();
    console.error("[POST /api/merenda/saidas] Erro:", err);
    return res.status(500).json({ error: "Erro ao registrar movimentação." });
  } finally {
    connection.release();
  }
});

// ============================================================================
// [DELETE] /api/merenda/saidas/:id
// Estorna/exclui uma movimentação
// ============================================================================
router.delete("/saidas/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  const { id } = req.params;

  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [result] = await pool.query(
      "DELETE FROM merenda_saidas WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Movimentação não encontrada ou não pertence a esta escola." });
    }

    return res.json({ message: "Movimentação estornada com sucesso. O saldo foi recomposto." });
  } catch (err) {
    console.error("[DELETE /api/merenda/saidas/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao estornar movimentação." });
  }
});

// ============================================================================
// [GET] /api/merenda/percapita
// Lista os itens em estoque junto com a configuração de percápita e o total de alunos
// ============================================================================
router.get("/percapita", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    // 1. Busca quantidade de alunos ativos
    const [alunosCount] = await pool.query(
      `SELECT COUNT(*) as total FROM alunos WHERE escola_id = ? AND (status = 'ativo' OR status = 'MATRICULADO')`,
      [escola_id]
    );
    const total_alunos = alunosCount[0].total || 0;

    // 2. Busca estoque atual cruzado com a percápita (apenas itens com saldo > 0)
    const [rows] = await pool.query(
      `SELECT 
         v.*, 
         p.produto, p.marca, p.categoria, p.gramatura,
         mp.id as percapita_id,
         mp.percapita_kg
       FROM view_merenda_estoque_lotes v
       JOIN merenda_produtos p ON v.produto_id = p.id
       LEFT JOIN merenda_percapita mp ON v.produto_id = mp.produto_id AND v.escola_id = mp.escola_id
       WHERE v.escola_id = ? AND v.saldo_unidades > 0
       ORDER BY p.produto ASC, v.validade ASC`,
      [escola_id]
    );

    return res.json({
      total_alunos,
      itens: rows
    });
  } catch (err) {
    console.error("[GET /api/merenda/percapita] Erro:", err);
    return res.status(500).json({ error: "Erro ao buscar dados de percápita." });
  }
});

// ============================================================================
// [POST] /api/merenda/percapita
// Salva ou atualiza a percápita de um produto
// ============================================================================
router.post("/percapita", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  const { produto_id, percapita_kg } = req.body;

  if (!produto_id || percapita_kg === undefined) {
    return res.status(400).json({ error: "produto_id e percapita_kg são obrigatórios." });
  }

  try {
    // Upsert logic (Insere ou Atualiza se já existir para a escola e produto)
    await pool.query(
      `INSERT INTO merenda_percapita (escola_id, produto_id, percapita_kg)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE percapita_kg = VALUES(percapita_kg)`,
      [escola_id, produto_id, percapita_kg]
    );

    return res.status(201).json({ message: "Percápita configurada com sucesso" });
  } catch (err) {
    console.error("[POST /api/merenda/percapita] Erro:", err);
    return res.status(500).json({ error: "Erro ao configurar percápita." });
  }
});

// ============================================================================
// [DELETE] /api/merenda/percapita/:id
// Remove a percápita
// ============================================================================
router.delete("/percapita/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  const { id } = req.params;

  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [result] = await pool.query(
      "DELETE FROM merenda_percapita WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Percápita não encontrada." });
    }

    return res.json({ message: "Percápita removida com sucesso." });
  } catch (err) {
    console.error("[DELETE /api/merenda/percapita/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao excluir percápita." });
  }
});

// ============================================================================
// [GET] /api/merenda/cardapio
// Lista os cardápios cadastrados e seus itens
// ============================================================================
router.get("/cardapio", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  const mes = req.query.mes; // opcional, formato YYYY-MM

  try {
    let queryCardapios = "SELECT * FROM merenda_cardapio WHERE escola_id = ?";
    let paramsCardapios = [escola_id];

    if (mes) {
      queryCardapios += " AND DATE_FORMAT(data_cardapio, '%Y-%m') = ?";
      paramsCardapios.push(mes);
    }
    
    queryCardapios += " ORDER BY data_cardapio ASC";

    const [cardapios] = await pool.query(queryCardapios, paramsCardapios);

    if (cardapios.length === 0) {
      return res.json([]);
    }

    const cardapioIds = cardapios.map(c => c.id);
    const placeholders = cardapioIds.map(() => '?').join(',');

    const [itens] = await pool.query(
      `SELECT ci.*, p.produto, p.marca, p.gramatura 
       FROM merenda_cardapio_itens ci
       JOIN merenda_produtos p ON ci.produto_id = p.id
       WHERE ci.cardapio_id IN (${placeholders})`,
      cardapioIds
    );

    // Agrupa os itens dentro do cardapio
    const result = cardapios.map(c => ({
      ...c,
      itens: itens.filter(i => i.cardapio_id === c.id)
    }));

    return res.json(result);
  } catch (err) {
    console.error("[GET /api/merenda/cardapio] Erro:", err);
    return res.status(500).json({ error: "Erro ao buscar cardápios." });
  }
});

// ============================================================================
// [POST] /api/merenda/cardapio
// Cria um novo cardápio e salva seus itens
// ============================================================================
router.post("/cardapio", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  const { data_cardapio, nome, turno, itens } = req.body;

  if (!data_cardapio || !nome) {
    return res.status(400).json({ error: "Data e Nome são obrigatórios." });
  }

  const turnoFinal = turno || 'Todos';

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      "INSERT INTO merenda_cardapio (escola_id, data_cardapio, nome, turno) VALUES (?, ?, ?, ?)",
      [escola_id, data_cardapio, nome, turnoFinal]
    );

    const cardapio_id = result.insertId;

    if (itens && Array.isArray(itens) && itens.length > 0) {
      for (const item of itens) {
        let valFinal = item.validade && item.validade.trim() !== "" ? item.validade : null;
        if (valFinal && valFinal.length > 10) valFinal = valFinal.substring(0, 10);

        await connection.query(
          `INSERT INTO merenda_cardapio_itens (cardapio_id, produto_id, lote, validade, quantidade_unidades, quantidade_kg)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [cardapio_id, item.produto_id, item.lote || null, valFinal, item.quantidade_unidades || 0, item.quantidade_kg || 0]
        );
      }
    }

    await connection.commit();
    return res.status(201).json({ message: "Cardápio salvo com sucesso", id: cardapio_id });
  } catch (err) {
    await connection.rollback();
    console.error("[POST /api/merenda/cardapio] Erro:", err);
    return res.status(500).json({ error: "Erro ao criar cardápio." });
  } finally {
    connection.release();
  }
});

// ============================================================================
// [PUT] /api/merenda/cardapio/:id
// Edita um cardápio existente
// ============================================================================
router.put("/cardapio/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  const { id } = req.params;
  const { nome, turno, itens } = req.body;

  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });
  if (!nome) return res.status(400).json({ error: "Nome é obrigatório." });

  const turnoFinal = turno || 'Todos';

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      "UPDATE merenda_cardapio SET nome = ?, turno = ? WHERE id = ? AND escola_id = ?",
      [nome, turnoFinal, id, escola_id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Cardápio não encontrado." });
    }

    // Recria os itens
    await connection.query("DELETE FROM merenda_cardapio_itens WHERE cardapio_id = ?", [id]);

    if (itens && Array.isArray(itens) && itens.length > 0) {
      for (const item of itens) {
        let valFinal = item.validade && item.validade.trim() !== "" ? item.validade : null;
        if (valFinal && valFinal.length > 10) valFinal = valFinal.substring(0, 10);

        await connection.query(
          `INSERT INTO merenda_cardapio_itens (cardapio_id, produto_id, lote, validade, quantidade_unidades, quantidade_kg)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, item.produto_id, item.lote || null, valFinal, item.quantidade_unidades || 0, item.quantidade_kg || 0]
        );
      }
    }

    await connection.commit();
    return res.json({ message: "Cardápio atualizado com sucesso" });
  } catch (err) {
    await connection.rollback();
    console.error("[PUT /api/merenda/cardapio/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao atualizar cardápio." });
  } finally {
    connection.release();
  }
});

// ============================================================================
// [DELETE] /api/merenda/cardapio/:id
// Remove o cardápio e estorna os itens para o estoque
// ============================================================================
router.delete("/cardapio/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  const { id } = req.params;

  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [result] = await pool.query(
      "DELETE FROM merenda_cardapio WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Cardápio não encontrado." });
    }

    return res.json({ message: "Cardápio cancelado e itens estornados ao estoque." });
  } catch (err) {
    console.error("[DELETE /api/merenda/cardapio/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao excluir cardápio." });
  }
});

// ============================================================================
// [GET] /api/merenda/saldo-completo
// Lista todos os itens que já deram entrada no estoque (mesmo com saldo zerado) para prestação de contas
// ============================================================================
router.get("/saldo-completo", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [rows] = await pool.query(
      `SELECT 
         v.*, 
         p.produto, p.marca, p.categoria, p.gramatura,
         mc.total_deposito_kg AS quantidade_deposito_kg
       FROM view_merenda_estoque_lotes v
       JOIN merenda_produtos p ON v.produto_id = p.id
       LEFT JOIN (
           SELECT escola_id, produto_id, SUM(quantidade_deposito_kg) as total_deposito_kg 
           FROM merenda_conferencia 
           GROUP BY escola_id, produto_id
       ) mc 
         ON mc.escola_id = v.escola_id 
         AND mc.produto_id = v.produto_id 
       WHERE v.escola_id = ?
       ORDER BY p.produto ASC, v.validade ASC`,
      [escola_id]
    );

    const [distribuicoes] = await pool.query(
      `SELECT * FROM merenda_distribuicoes WHERE escola_id = ? ORDER BY data_inicio ASC`,
      [escola_id]
    );

    const [entradas] = await pool.query(
      `SELECT produto_id, peso_kg, created_at 
       FROM merenda_entradas 
       WHERE escola_id = ? 
       ORDER BY created_at DESC`,
      [escola_id]
    );

    const formatDate = (val) => {
      if (!val) return '';
      if (val instanceof Date) {
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const d = String(val.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      return String(val).split('T')[0];
    };

    const formatBrDate = (isoStr) => {
      if (!isoStr) return '';
      const [y, m, d] = isoStr.split('-');
      return `${d}/${m}/${y}`;
    };

    const entradasGrupadas = {};
    for (const ent of entradas) {
      const key = String(ent.produto_id);
      if (!entradasGrupadas[key]) entradasGrupadas[key] = [];
      entradasGrupadas[key].push(ent);
    }

    const getDistribuicaoName = (dateVal) => {
      if (!dateVal) return null;
      const d = formatDate(dateVal);
      const index = distribuicoes.findIndex(dist => {
         const inicio = formatDate(dist.data_inicio);
         const fim = formatDate(dist.data_fim);
         return d >= inicio && d <= fim;
      });
      return index >= 0 ? `${index + 1}ª` : null;
    };

    const aggregated = {};
    for (const row of rows) {
       const pid = String(row.produto_id);
       if (!aggregated[pid]) {
          aggregated[pid] = {
             produto_id: row.produto_id,
             produto: row.produto,
             marca: row.marca,
             categoria: row.categoria,
             gramatura: row.gramatura,
             quantidade_deposito_kg: row.quantidade_deposito_kg,
             saldo_kg: 0,
             saldo_unidades: 0,
             lotes: new Set(),
             validades: new Set()
          };
       }
       aggregated[pid].saldo_kg += Number(row.saldo_kg);
       aggregated[pid].saldo_unidades += Number(row.saldo_unidades);
       if (row.lote) aggregated[pid].lotes.add(row.lote);
       if (row.validade) {
          aggregated[pid].validades.add(formatBrDate(formatDate(row.validade)));
       }
    }

    const resultRows = [];
    for (const agg of Object.values(aggregated)) {
      const row = {
         ...agg,
         lote: Array.from(agg.lotes).join(' | '),
         validade: Array.from(agg.validades).join(' | ')
      };

      const saldoKg = row.saldo_kg;
      row.distribuicoes_breakdown = [];
      
      if (saldoKg > 0) {
        const ents = entradasGrupadas[String(row.produto_id)] || [];
        
        let remaining = saldoKg;
        const distMap = {};

        for (const ent of ents) {
          if (remaining <= 0) break;
          
          const entKg = Number(ent.peso_kg);
          const distName = getDistribuicaoName(ent.created_at);
          
          const take = Math.min(entKg, remaining);
          if (take > 0 && distName) {
            distMap[distName] = (distMap[distName] || 0) + take;
            remaining -= take;
          }
        }
        
        for (const [name, kg] of Object.entries(distMap)) {
          row.distribuicoes_breakdown.push({ nome: name, kg });
        }
        row.distribuicoes_breakdown.sort((a, b) => parseInt(a.nome) - parseInt(b.nome));
      }
      
      resultRows.push(row);
    }
    
    resultRows.sort((a, b) => a.produto.localeCompare(b.produto, 'pt-BR'));

    return res.json(resultRows);
  } catch (err) {
    console.error("[GET /api/merenda/saldo-completo] Erro:", err);
    return res.status(500).json({ error: "Erro ao buscar saldo completo." });
  }
});

// ============================================================================
// [POST] /api/merenda/conferencia
// Salva as contagens físicas do depósito
// ============================================================================
router.post("/conferencia", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  const { itens } = req.body; // Array de { produto_id, lote, validade, quantidade_deposito_kg }

  if (!itens || !Array.isArray(itens)) {
    return res.status(400).json({ error: "Lista de itens inválida." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    for (const item of itens) {
      let valFinal = item.validade && item.validade.trim() !== "" ? item.validade : null;
      if (valFinal && valFinal.length > 10) valFinal = valFinal.substring(0, 10);
      
      const loteFinal = item.lote && item.lote.trim() !== "" ? item.lote : null;

      await connection.query(
        `INSERT INTO merenda_conferencia (escola_id, produto_id, lote, validade, quantidade_deposito_kg)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE quantidade_deposito_kg = VALUES(quantidade_deposito_kg)`,
        [escola_id, item.produto_id, loteFinal, valFinal, item.quantidade_deposito_kg || 0]
      );
    }

    await connection.commit();
    return res.json({ message: "Conferência salva com sucesso!" });
  } catch (err) {
    await connection.rollback();
    console.error("[POST /api/merenda/conferencia] Erro:", err);
    return res.status(500).json({ error: "Erro ao salvar conferência." });
  } finally {
    connection.release();
  }
});

// ============================================================================
// [GET] /api/merenda/distribuicoes
// Lista as distribuições cadastradas ordenadas por data de início
// ============================================================================
router.get("/distribuicoes", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  try {
    const [rows] = await pool.query(
      `SELECT * FROM merenda_distribuicoes 
       WHERE escola_id = ? 
       ORDER BY data_inicio ASC`,
      [escola_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("[GET /api/merenda/distribuicoes] Erro:", err);
    return res.status(500).json({ error: "Erro ao buscar distribuições." });
  }
});

// ============================================================================
// [POST] /api/merenda/distribuicoes
// Cria uma nova distribuição
// ============================================================================
router.post("/distribuicoes", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  const { data_inicio, data_fim } = req.body;
  if (!data_inicio || !data_fim) return res.status(400).json({ error: "Data início e fim são obrigatórias." });

  let dInicio = data_inicio;
  if (dInicio.length > 10) dInicio = dInicio.substring(0, 10);
  let dFim = data_fim;
  if (dFim.length > 10) dFim = dFim.substring(0, 10);

  try {
    const [result] = await pool.query(
      `INSERT INTO merenda_distribuicoes (escola_id, data_inicio, data_fim) VALUES (?, ?, ?)`,
      [escola_id, dInicio, dFim]
    );
    return res.status(201).json({ message: "Distribuição registrada com sucesso", id: result.insertId });
  } catch (err) {
    console.error("[POST /api/merenda/distribuicoes] Erro:", err);
    return res.status(500).json({ error: "Erro ao registrar distribuição." });
  }
});

// ============================================================================
// [PUT] /api/merenda/distribuicoes/:id
// Edita as datas de uma distribuição
// ============================================================================
router.put("/distribuicoes/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  const { id } = req.params;
  const { data_inicio, data_fim } = req.body;
  if (!data_inicio || !data_fim) return res.status(400).json({ error: "Data início e fim são obrigatórias." });

  let dInicio = data_inicio;
  if (dInicio.length > 10) dInicio = dInicio.substring(0, 10);
  let dFim = data_fim;
  if (dFim.length > 10) dFim = dFim.substring(0, 10);

  try {
    const [result] = await pool.query(
      `UPDATE merenda_distribuicoes 
       SET data_inicio = ?, data_fim = ? 
       WHERE id = ? AND escola_id = ?`,
      [dInicio, dFim, id, escola_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Distribuição não encontrada." });
    
    return res.json({ message: "Distribuição atualizada com sucesso" });
  } catch (err) {
    console.error("[PUT /api/merenda/distribuicoes/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao atualizar distribuição." });
  }
});

// ============================================================================
// [DELETE] /api/merenda/distribuicoes/:id
// Exclui uma distribuição
// ============================================================================
router.delete("/distribuicoes/:id", async (req, res) => {
  const escola_id = req.headers["x-escola-id"] || req.user?.escola_id;
  if (!escola_id) return res.status(400).json({ error: "escola_id não fornecido." });

  const { id } = req.params;
  try {
    const [result] = await pool.query(
      "DELETE FROM merenda_distribuicoes WHERE id = ? AND escola_id = ?",
      [id, escola_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Distribuição não encontrada." });
    
    return res.json({ message: "Distribuição excluída com sucesso" });
  } catch (err) {
    console.error("[DELETE /api/merenda/distribuicoes/:id] Erro:", err);
    return res.status(500).json({ error: "Erro ao excluir distribuição." });
  }
});

export default router;
