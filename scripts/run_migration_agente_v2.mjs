// scripts/run_migration_agente_v2.mjs
// ============================================================================
// MIGRATION: agente_credenciais v2 — adiciona usuario_id + nova chave única
//
// PROBLEMA: A tabela foi criada com UNIQUE KEY em (escola_id, professor_id),
// mas o código do backend salvava e buscava por usuario_id (que pode diferir
// do professor_id, especialmente para vice_diretor, coordenador, etc.).
// Resultado: usuários que não são professores nunca tinham credencial encontrada.
//
// SOLUÇÃO:
//   1. Adicionar coluna usuario_id (caso ainda não exista)
//   2. Popular usuario_id = professor_id nos registros existentes (fallback)
//   3. Adicionar unique key (escola_id, usuario_id)
//   4. Atualizar registros ativo=0 para ativo=1 em duplicatas (mais recente wins)
// ============================================================================

import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pool from '../db.js';

const __d = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__d, '..', '.env') });

async function run() {
  const db = await pool.getConnection();
  try {
    console.log('[MIG-v2] Iniciando migration agente_credenciais v2...');

    // 1. Adiciona coluna usuario_id se não existir
    try {
      await db.query(`
        ALTER TABLE agente_credenciais
        ADD COLUMN usuario_id INT NOT NULL DEFAULT 0
        AFTER escola_id
      `);
      console.log('[MIG-v2] ✅ Coluna usuario_id adicionada.');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('[MIG-v2] ℹ️  Coluna usuario_id já existe — pulando.');
      } else {
        throw e;
      }
    }

    // 2. Popula usuario_id com o professor_id existente (fallback retroativo)
    //    Preserva qualquer valor já setado (> 0)
    const [updated] = await db.query(`
      UPDATE agente_credenciais
      SET usuario_id = professor_id
      WHERE usuario_id = 0 AND professor_id > 0
    `);
    console.log(`[MIG-v2] ✅ ${updated.affectedRows} registros migrados professor_id → usuario_id.`);

    // 2.5 Remove a antiga unique key (escola_id, professor_id) — causava conflito
    //     quando professor_id=0 para múltiplos usuários (vice_diretor, coord, etc.)
    try {
      await db.query(`ALTER TABLE agente_credenciais DROP INDEX uk_prof_escola`);
      console.log('[MIG-v2] ✅ Antiga unique key uk_prof_escola removida.');
    } catch (e) {
      if (e.message?.includes("Can't DROP") || e.message?.includes('check that it exists')) {
        console.log('[MIG-v2] ℹ️  uk_prof_escola já não existe — pulando.');
      } else {
        console.warn('[MIG-v2] ⚠️  Erro ao remover uk_prof_escola (não crítico):', e.message);
      }
    }

    // 2.7 REMOVE LINHAS ÓRFÃS — usuario_id=0 E professor_id=0
    // Estas surgem quando: o Diretor/Vice/Coord salvou credenciais com professor_id=0
    // e a migration anterior setou usuario_id=professor_id=0 (sem dono identificável).
    // São inúteis (dados criptografados podem estar corrompidos) e bloqueiam novos INSERTs.
    // Usuários afetados precisarão re-salvar UMA VEZ — o código já lida com isso (422).
    const [orphansDeleted] = await db.query(`
      DELETE FROM agente_credenciais
      WHERE usuario_id = 0 AND professor_id = 0
    `);
    if (orphansDeleted.affectedRows > 0) {
      console.log(`[MIG-v2] ✅ ${orphansDeleted.affectedRows} linha(s) órfã(s) removida(s) (usuario_id=0, professor_id=0).`);
      console.log('[MIG-v2] ℹ️  Usuários impactados precisarão salvar suas credenciais UMA VEZ.');
    }

    // 3. Adiciona unique key (escola_id, usuario_id) se não existir
    try {
      await db.query(`
        ALTER TABLE agente_credenciais
        ADD UNIQUE KEY uk_escola_usuario (escola_id, usuario_id)
      `);
      console.log('[MIG-v2] ✅ Unique key uk_escola_usuario adicionada.');
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME' || e.message?.includes('Duplicate key name')) {
        console.log('[MIG-v2] ℹ️  Unique key já existe — pulando.');
      } else if (e.code === 'ER_DUP_ENTRY') {
        console.warn('[MIG-v2] ⚠️  Há duplicatas em (escola_id, usuario_id). Limpando...');
        // Remove duplicatas mantendo o registro mais recente (maior id)
        await db.query(`
          DELETE c1 FROM agente_credenciais c1
          INNER JOIN agente_credenciais c2
          WHERE c1.escola_id = c2.escola_id
            AND c1.usuario_id = c2.usuario_id
            AND c1.id < c2.id
        `);
        console.log('[MIG-v2] ✅ Duplicatas removidas. Tentando adicionar unique key...');
        await db.query(`
          ALTER TABLE agente_credenciais
          ADD UNIQUE KEY uk_escola_usuario (escola_id, usuario_id)
        `);
        console.log('[MIG-v2] ✅ Unique key uk_escola_usuario adicionada após limpeza.');
      } else {
        throw e;
      }
    }

    // 4. Adiciona índice em usuario_id se não existir
    try {
      await db.query(`ALTER TABLE agente_credenciais ADD INDEX idx_usuario (usuario_id)`);
      console.log('[MIG-v2] ✅ Índice idx_usuario adicionado.');
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME' || e.message?.includes('Duplicate key name')) {
        console.log('[MIG-v2] ℹ️  Índice idx_usuario já existe — pulando.');
      } else {
        console.warn('[MIG-v2] ⚠️  Erro ao adicionar índice (não crítico):', e.message);
      }
    }

    // 5. Garante que todos os registros estão ativo=1 (se ativo=0 por bug)
    const [reativados] = await db.query(`
      UPDATE agente_credenciais SET ativo = 1
      WHERE ativo = 0 AND educadf_login IS NOT NULL AND educadf_senha_enc IS NOT NULL
    `);
    if (reativados.affectedRows > 0) {
      console.log(`[MIG-v2] ✅ ${reativados.affectedRows} credenciais reativadas (ativo 0 → 1).`);
    }

    console.log('\n[MIG-v2] 🎉 Migration concluída com sucesso!');
    console.log('[MIG-v2] Agora todos os usuários (professor, vice_diretor, coordenador, etc.)');
    console.log('[MIG-v2] poderão salvar e testar suas credenciais corretamente.\n');

  } catch (err) {
    console.error('[MIG-v2] ❌ Erro fatal na migration:', err.message);
    process.exit(1);
  } finally {
    db.release();
    await pool.end();
    process.exit(0);
  }
}

run();
