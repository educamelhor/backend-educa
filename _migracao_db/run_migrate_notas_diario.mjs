import pool from '../db.js';

async function migrate() {
  const conn = await pool.getConnection();
  try {
    // 1) notas_diario
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notas_diario (
        id INT AUTO_INCREMENT PRIMARY KEY,
        escola_id BIGINT UNSIGNED NOT NULL,
        plano_id INT NOT NULL,
        turma_id INT NOT NULL,
        aluno_id BIGINT UNSIGNED NOT NULL,
        item_idx TINYINT NOT NULL,
        oportunidade_idx TINYINT NOT NULL DEFAULT 0,
        nota DECIMAL(5,2) DEFAULT NULL,
        cor VARCHAR(10) DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unq_nota_diario (plano_id, turma_id, aluno_id, item_idx, oportunidade_idx),
        KEY idx_plano_turma (plano_id, turma_id),
        KEY idx_aluno (aluno_id),
        CONSTRAINT fk_nd_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
        CONSTRAINT fk_nd_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Tabela notas_diario criada');

    // 2) Atualizar ENUM do planos_avaliacao
    await conn.query(`
      ALTER TABLE planos_avaliacao 
      MODIFY COLUMN status ENUM('RASCUNHO','ENVIADO','APROVADO','REJEITADO','FECHADO') DEFAULT 'RASCUNHO'
    `);
    console.log('✅ ENUM planos_avaliacao.status atualizado com FECHADO');

    // 3) Tabela de controle de fechamento
    await conn.query(`
      CREATE TABLE IF NOT EXISTS diario_fechamento (
        id INT AUTO_INCREMENT PRIMARY KEY,
        escola_id BIGINT UNSIGNED NOT NULL,
        plano_id INT NOT NULL,
        turma_id INT NOT NULL,
        fechado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        fechado_por INT DEFAULT NULL,
        total_alunos INT DEFAULT 0,
        total_notas_exportadas INT DEFAULT 0,
        UNIQUE KEY unq_fechamento (plano_id, turma_id),
        CONSTRAINT fk_df_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Tabela diario_fechamento criada');

  } catch (err) {
    console.error('❌ Erro na migração:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

migrate();
