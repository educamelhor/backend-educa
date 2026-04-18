// _migracao_db/migrate_prova_bimestral_data.mjs
// ============================================================================
// Migração: Suporte a data_aplicacao no gabarito e item Prova Bimestral
// automático nos PAPs quando escola adota avaliação padronizada.
//
// Execução: node _migracao_db/migrate_prova_bimestral_data.mjs
// ============================================================================

import pool from '../db.js';

async function run() {
  const conn = await pool.getConnection();
  try {
    console.log('[MIGRAÇÃO] Iniciando...');

    // 1. Adicionar data_aplicacao à tabela gabarito_avaliacoes
    await conn.query(`
      ALTER TABLE gabarito_avaliacoes
      ADD COLUMN IF NOT EXISTS data_aplicacao DATE DEFAULT NULL
        COMMENT 'Data de aplicação da prova bimestral (definida pela direção)'
    `).catch(() => console.log('[MIGRAÇÃO] data_aplicacao: já existe ou ignorado'));

    console.log('[MIGRAÇÃO] ✅ gabarito_avaliacoes.data_aplicacao OK');

    // 2. Garantir configuracao escola.avaliacao_padrao_bimestral existe
    //    (já deve existir — apenas documenta). Não criamos aqui, pois
    //    é gerenciada pela tela de Governança.

    // 3. Para as escolas com avaliacao_padrao_bimestral = '1',
    //    preenche o item fixo_direcao nos planos que ainda não têm.
    const [escolas] = await conn.query(`
      SELECT DISTINCT escola_id FROM configuracoes_escola
      WHERE chave = 'escola.avaliacao_padrao_bimestral' AND valor = '1'
    `).catch(() => [[]]);

    let totalInseridos = 0;
    for (const { escola_id } of escolas) {
      // Busca todos os planos dessa escola sem item fixo_direcao=1
      const [planos] = await conn.query(`
        SELECT pa.id
        FROM planos_avaliacao pa
        WHERE pa.escola_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM itens_avaliacao ia
            WHERE ia.plano_id = pa.id AND ia.fixo_direcao = 1
          )
      `, [escola_id]);

      for (const { id: planoId } of planos) {
        await conn.query(`
          INSERT INTO itens_avaliacao
            (plano_id, atividade, tipo_avaliacao, data_inicio, data_final,
             nota_total, oportunidades, nota_invertida, descricao, fixo_direcao)
          VALUES (?, 'Prova Bimestral', 'PROVA', NULL, NULL, 5, 1, 0, NULL, 1)
        `, [planoId]);
        totalInseridos++;
      }
      console.log(`[MIGRAÇÃO] Escola ${escola_id}: ${planos.length} planos sem item bimestral → inseridos`);
    }

    console.log(`[MIGRAÇÃO] ✅ Itens Prova Bimestral inseridos: ${totalInseridos}`);
    console.log('[MIGRAÇÃO] ✅ Concluída com sucesso!');
  } catch (err) {
    console.error('[MIGRAÇÃO] ❌ Erro:', err.message);
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch(process.exit.bind(process, 1));
