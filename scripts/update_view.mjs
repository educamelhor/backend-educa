import pool from "../db.js";

async function up() {
  const connection = await pool.getConnection();
  try {
    const viewSQL = `CREATE OR REPLACE VIEW view_merenda_estoque_lotes AS 
    select e.escola_id AS escola_id,
    e.produto_id AS produto_id,
    e.lote AS lote,
    e.validade AS validade,
    MAX(e.created_at) AS data_chegada,
    sum(e.quantidade_unidades) AS total_entradas_unidades,
    sum(e.peso_kg) AS total_entradas_kg,
    coalesce((select sum(s.quantidade_unidades) from merenda_saidas s where ((s.escola_id = e.escola_id) and (s.produto_id = e.produto_id) and (ifnull(s.lote,'') = ifnull(e.lote,'')) and (ifnull(s.validade,'1900-01-01') = ifnull(e.validade,'1900-01-01')))),0) AS total_saidas_unidades,
    coalesce((select sum(s.peso_kg) from merenda_saidas s where ((s.escola_id = e.escola_id) and (s.produto_id = e.produto_id) and (ifnull(s.lote,'') = ifnull(e.lote,'')) and (ifnull(s.validade,'1900-01-01') = ifnull(e.validade,'1900-01-01')))),0) AS total_saidas_kg,
    coalesce((select sum(ci.quantidade_unidades) from (merenda_cardapio_itens ci join merenda_cardapio c on((ci.cardapio_id = c.id))) where ((c.escola_id = e.escola_id) and (ci.produto_id = e.produto_id) and (ifnull(ci.lote,'') = ifnull(e.lote,'')) and (ifnull(ci.validade,'1900-01-01') = ifnull(e.validade,'1900-01-01')))),0) AS total_consumo_unidades,
    coalesce((select sum(ci.quantidade_kg) from (merenda_cardapio_itens ci join merenda_cardapio c on((ci.cardapio_id = c.id))) where ((c.escola_id = e.escola_id) and (ci.produto_id = e.produto_id) and (ifnull(ci.lote,'') = ifnull(e.lote,'')) and (ifnull(ci.validade,'1900-01-01') = ifnull(e.validade,'1900-01-01')))),0) AS total_consumo_kg,
    ((sum(e.quantidade_unidades) - coalesce((select sum(s.quantidade_unidades) from merenda_saidas s where ((s.escola_id = e.escola_id) and (s.produto_id = e.produto_id) and (ifnull(s.lote,'') = ifnull(e.lote,'')) and (ifnull(s.validade,'1900-01-01') = ifnull(e.validade,'1900-01-01')))),0)) - coalesce((select sum(ci.quantidade_unidades) from (merenda_cardapio_itens ci join merenda_cardapio c on((ci.cardapio_id = c.id))) where ((c.escola_id = e.escola_id) and (ci.produto_id = e.produto_id) and (ifnull(ci.lote,'') = ifnull(e.lote,'')) and (ifnull(ci.validade,'1900-01-01') = ifnull(e.validade,'1900-01-01')))),0)) AS saldo_unidades,
    ((sum(e.peso_kg) - coalesce((select sum(s.peso_kg) from merenda_saidas s where ((s.escola_id = e.escola_id) and (s.produto_id = e.produto_id) and (ifnull(s.lote,'') = ifnull(e.lote,'')) and (ifnull(s.validade,'1900-01-01') = ifnull(e.validade,'1900-01-01')))),0)) - coalesce((select sum(ci.quantidade_kg) from (merenda_cardapio_itens ci join merenda_cardapio c on((ci.cardapio_id = c.id))) where ((c.escola_id = e.escola_id) and (ci.produto_id = e.produto_id) and (ifnull(ci.lote,'') = ifnull(e.lote,'')) and (ifnull(ci.validade,'1900-01-01') = ifnull(e.validade,'1900-01-01')))),0)) AS saldo_kg 
    from merenda_entradas e group by e.escola_id,e.produto_id,e.lote,e.validade`;
    await connection.query(viewSQL);
    console.log("View atualizada.");
  } catch (err) {
    console.error(err);
  } finally {
    connection.release();
    process.exit(0);
  }
}
up();
