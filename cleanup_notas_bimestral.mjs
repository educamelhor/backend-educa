/**
 * cleanup_notas_bimestral.mjs
 * ─────────────────────────────────────────────────────────
 * Remove as notas PROVISÓRIAS inseridas pelo seed_notas_bimestral.mjs
 * nas turmas: 9º ANO H, I, J, K
 *
 * Como rodar:
 *   node cleanup_notas_bimestral.mjs
 * ─────────────────────────────────────────────────────────
 */

import pool from './db.js';

const TURMAS_ALVO = ['9º ANO H', '9º ANO I', '9º ANO J', '9º ANO K'];
const ANO         = 2026;

async function cleanup() {
  const conn = await pool.getConnection();
  try {
    // Busca planos das turmas alvo com item bimestral
    const [planos] = await conn.query(`
      SELECT
        pa.id       AS plano_id,
        pa.turmas,
        ia.item_idx AS item_idx
      FROM planos_avaliacao pa
      JOIN itens_avaliacao  ia ON ia.plano_id = pa.id AND ia.fixo_direcao = 1
      WHERE pa.ano = ?
      HAVING turmas IN (${TURMAS_ALVO.map(() => '?').join(',')})
    `, [ANO, ...TURMAS_ALVO]);

    if (!planos.length) {
      console.warn('⚠️  Nenhum plano encontrado para as turmas alvo.');
      return;
    }

    for (const plano of planos) {
      const [result] = await conn.query(`
        DELETE FROM notas_diario
        WHERE plano_id  = ?
          AND item_idx  = ?
      `, [plano.plano_id, plano.item_idx ?? 0]);

      console.log(`✅ "${plano.turmas}" (plano_id=${plano.plano_id}): ${result.affectedRows} notas removidas`);
    }

    console.log('\n🧹 Limpeza concluída — notas provisórias removidas.');
  } catch (err) {
    console.error('❌ Erro no cleanup:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

cleanup();
