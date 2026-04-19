/**
 * seed_notas_bimestral.mjs
 * ─────────────────────────────────────────────────────────
 * Alimenta notas PROVISÓRIAS (0 a 5,00) na coluna Avaliação Bimestral
 * (fixo_direcao = 1) para as turmas: 9º ANO H, I, J, K
 *
 * APENAS PARA TESTES — limpeza: node cleanup_notas_bimestral.mjs
 *
 * Como rodar:  node seed_notas_bimestral.mjs
 * ─────────────────────────────────────────────────────────
 *
 * Estrutura verificada no BD:
 *   alunos:         id, escola_id, codigo, estudante, turma_id, status
 *   turmas:         id, escola_id, nome, ano
 *   itens_avaliacao: id, plano_id, atividade, fixo_direcao
 *   notas_diario:   id, escola_id, plano_id, turma_id, aluno_id, item_idx, nota
 *   item_idx = posição base-0 do item no plano (contagem de ids menores)
 */

import pool from './db.js';

const TURMAS_ALVO = ['9º ANO H', '9º ANO I', '9º ANO J', '9º ANO K'];
const ANO         = 2026;
const nota = () => Math.round(Math.random() * 50) / 10; // 0.0 a 5.0

async function seed() {
  const conn = await pool.getConnection();
  try {

    // ── 1. Busca planos aprovados das turmas alvo com coluna Bimestral ──
    const [planos] = await conn.query(`
      SELECT
        pa.id         AS plano_id,
        pa.turmas     AS turma_nome,
        pa.escola_id,
        ia.id         AS item_id,
        (SELECT COUNT(*) FROM itens_avaliacao x WHERE x.plano_id = pa.id AND x.id < ia.id) AS item_idx
      FROM planos_avaliacao pa
      JOIN itens_avaliacao  ia ON ia.plano_id = pa.id AND ia.fixo_direcao = 1
      WHERE pa.ano = ?
        AND pa.status IN ('APROVADO','ENVIADO')
        AND pa.turmas IN (${TURMAS_ALVO.map(() => '?').join(',')})
    `, [ANO, ...TURMAS_ALVO]);

    if (!planos.length) {
      console.error('❌ Nenhum plano encontrado. Verifique status e ano.');
      return;
    }

    console.log(`✅ ${planos.length} plano(s) encontrado(s):`);
    planos.forEach(p => console.log(`   • plano_id=${p.plano_id} | "${p.turma_nome}" | item_idx=${p.item_idx}`));

    let inseridos = 0, ignorados = 0;

    for (const plano of planos) {

      // ── 2. Busca turma_id e alunos ────────────────────────────────────
      const [[turma]] = await conn.query(
        `SELECT id FROM turmas WHERE escola_id = ? AND nome = ? LIMIT 1`,
        [plano.escola_id, plano.turma_nome]
      );

      if (!turma) {
        console.warn(`  ⚠️  Turma "${plano.turma_nome}" não encontrada em turmas.`);
        continue;
      }

      const [alunos] = await conn.query(`
        SELECT id AS aluno_id, estudante
        FROM alunos
        WHERE escola_id = ? AND turma_id = ? AND status = 'ATIVO'
      `, [plano.escola_id, turma.id]);

      if (!alunos.length) {
        console.warn(`  ⚠️  Nenhum aluno ativo na turma "${plano.turma_nome}" (turma_id=${turma.id})`);
        continue;
      }

      console.log(`\n  → "${plano.turma_nome}" (plano_id=${plano.plano_id}): ${alunos.length} alunos`);

      // ── 3. INSERT notas (ON DUPLICATE KEY: só insere se NULL) ─────────
      for (const aluno of alunos) {
        const n = nota();
        try {
          const [res] = await conn.query(`
            INSERT INTO notas_diario
              (escola_id, plano_id, turma_id, aluno_id, item_idx, oportunidade_idx, nota)
            VALUES (?, ?, ?, ?, ?, 0, ?)
            ON DUPLICATE KEY UPDATE
              nota = IF(nota IS NULL, VALUES(nota), nota)
          `, [plano.escola_id, plano.plano_id, turma.id, aluno.aluno_id, plano.item_idx, n]);

          if (res.affectedRows === 1) {
            inseridos++;
            process.stdout.write(`    ✔ ${String(aluno.estudante).padEnd(45)} → ${n.toFixed(1)}\n`);
          } else {
            ignorados++; // duplicate — nota já existia
          }
        } catch (err) {
          if (err.code === 'ER_DUP_ENTRY') { ignorados++; }
          else console.warn(`    ⚠️  aluno_id=${aluno.aluno_id}: ${err.message}`);
        }
      }
    }

    console.log(`\n══════════════════════════════════════════════`);
    console.log(`✅ Seed concluído!`);
    console.log(`   Notas inseridas : ${inseridos}`);
    console.log(`   Já existiam     : ${ignorados} (preservadas)`);
    console.log(`\n🧹 Para limpar: node cleanup_notas_bimestral.mjs`);

  } catch (err) {
    console.error('❌ Erro no seed:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

seed();
