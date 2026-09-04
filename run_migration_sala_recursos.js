// run_migration_sala_recursos.js
// Cria as tabelas do módulo Sala de Recursos (AEE)
import pool from './db.js';

async function run() {
  const db = pool;
  console.log('[SALA DE RECURSOS] Iniciando migração...');

  // 1. aee_alunos_config
  await db.query(`
    CREATE TABLE IF NOT EXISTS aee_alunos_config (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      aluno_id BIGINT UNSIGNED NOT NULL,
      escola_id BIGINT UNSIGNED NOT NULL,
      ano_letivo INT NOT NULL,
      tipo_atendimento VARCHAR(100) DEFAULT 'Sala de Recursos Multifuncionais',
      turno_atendimento VARCHAR(50) DEFAULT 'Contraturno',
      dias_semana VARCHAR(100) NULL,
      horario_atendimento VARCHAR(50) NULL,
      status VARCHAR(50) DEFAULT 'ativo',
      professor_aee VARCHAR(150) NULL,
      necessidades_especificas TEXT NULL,
      criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_aee_cfg_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
      CONSTRAINT fk_aee_cfg_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE,
      UNIQUE KEY uq_aee_aluno_ano (aluno_id, escola_id, ano_letivo)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✅ aee_alunos_config verificada/criada');

  // 2. aee_laudos
  await db.query(`
    CREATE TABLE IF NOT EXISTS aee_laudos (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      aluno_id BIGINT UNSIGNED NOT NULL,
      escola_id BIGINT UNSIGNED NOT NULL,
      cid VARCHAR(50) NULL,
      diagnostico TEXT NULL,
      medico_nome VARCHAR(150) NULL,
      medico_crm VARCHAR(50) NULL,
      medico_especialidade VARCHAR(100) NULL,
      data_laudo DATE NULL,
      data_validade DATE NULL,
      medicamentos TEXT NULL,
      acompanhamento_externo TEXT NULL,
      arquivo_url TEXT NULL,
      observacoes TEXT NULL,
      criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_aee_laudo_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
      CONSTRAINT fk_aee_laudo_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✅ aee_laudos verificada/criada');

  // 3. aee_adequacoes_curriculares
  await db.query(`
    CREATE TABLE IF NOT EXISTS aee_adequacoes_curriculares (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      aluno_id BIGINT UNSIGNED NOT NULL,
      escola_id BIGINT UNSIGNED NOT NULL,
      ano_letivo INT NOT NULL,
      bimestre VARCHAR(30) NOT NULL,
      disciplina VARCHAR(100) NOT NULL,
      disciplina_id BIGINT UNSIGNED NULL,
      professor_regente VARCHAR(150) NULL,
      professor_aee VARCHAR(150) NULL,
      habilidades_prioritarias TEXT NULL,
      metodologias_estrategias TEXT NULL,
      recursos_didaticos TEXT NULL,
      avaliacao_adaptada TEXT NULL,
      parecer_conclusivo TEXT NULL,
      status VARCHAR(50) DEFAULT 'concluido',
      criado_por BIGINT UNSIGNED NULL,
      criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_aee_adeq_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
      CONSTRAINT fk_aee_adeq_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✅ aee_adequacoes_curriculares verificada/criada');

  // 4. aee_pdi
  await db.query(`
    CREATE TABLE IF NOT EXISTS aee_pdi (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      aluno_id BIGINT UNSIGNED NOT NULL,
      escola_id BIGINT UNSIGNED NOT NULL,
      ano_letivo INT NOT NULL,
      diagnostico_pedagogico TEXT NULL,
      objetivos_gerais TEXT NULL,
      cronograma_atendimento TEXT NULL,
      acoes_escola TEXT NULL,
      acoes_familia TEXT NULL,
      recursos_acessibilidade TEXT NULL,
      status VARCHAR(50) DEFAULT 'ativo',
      criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_aee_pdi_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
      CONSTRAINT fk_aee_pdi_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE,
      UNIQUE KEY uq_aee_pdi_aluno_ano (aluno_id, escola_id, ano_letivo)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✅ aee_pdi verificada/criada');

  // 5. aee_atendimentos (Diário de Sessões)
  await db.query(`
    CREATE TABLE IF NOT EXISTS aee_atendimentos (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      aluno_id BIGINT UNSIGNED NOT NULL,
      escola_id BIGINT UNSIGNED NOT NULL,
      data_atendimento DATE NOT NULL,
      horario_inicio VARCHAR(10) NULL,
      horario_fim VARCHAR(10) NULL,
      presenca TINYINT(1) DEFAULT 1,
      tipo_sessao VARCHAR(50) DEFAULT 'Individual',
      atividades_realizadas TEXT NULL,
      evolucao_observacoes TEXT NULL,
      registrado_por VARCHAR(150) NULL,
      criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_aee_atend_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
      CONSTRAINT fk_aee_atend_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✅ aee_atendimentos verificada/criada');

  // 6. aee_pareceres
  await db.query(`
    CREATE TABLE IF NOT EXISTS aee_pareceres (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      aluno_id BIGINT UNSIGNED NOT NULL,
      escola_id BIGINT UNSIGNED NOT NULL,
      ano_letivo INT NOT NULL,
      periodo VARCHAR(50) NOT NULL,
      desenvolvimento_cognitivo TEXT NULL,
      desenvolvimento_socioemocional TEXT NULL,
      desenvolvimento_motor_comunicacao TEXT NULL,
      conclusoes_encaminhamentos TEXT NULL,
      responsavel_elaboracao VARCHAR(150) NULL,
      criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_aee_par_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
      CONSTRAINT fk_aee_par_escola FOREIGN KEY (escola_id) REFERENCES escolas(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✅ aee_pareceres verificada/criada');

  // Índices para otimização
  try {
    await db.query(`CREATE INDEX idx_aee_adeq_busca ON aee_adequacoes_curriculares (escola_id, aluno_id, ano_letivo, bimestre);`);
  } catch (e) {
    if (e.code !== 'ER_DUP_KEYNAME') console.error('Erro index idx_aee_adeq_busca:', e.message);
  }

  try {
    await db.query(`CREATE INDEX idx_aee_atend_data ON aee_atendimentos (escola_id, aluno_id, data_atendimento DESC);`);
  } catch (e) {
    if (e.code !== 'ER_DUP_KEYNAME') console.error('Erro index idx_aee_atend_data:', e.message);
  }

  console.log('🎉 Migração Sala de Recursos concluída com sucesso!');
  process.exit(0);
}

run().catch((e) => {
  console.error('❌ Erro na migração:', e);
  process.exit(1);
});
