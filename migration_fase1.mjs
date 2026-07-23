// migration_fase1.mjs — executa no diretório do backend
import pool from './db.js';

console.log('Iniciando migration Fase 1+2...\n');

try {
  // 1. imagem_url em questoes
  await pool.query(`ALTER TABLE questoes ADD COLUMN IF NOT EXISTS imagem_url VARCHAR(500) NULL AFTER imagem_base64`);
  console.log('✅ questoes.imagem_url adicionada');

  // 2. imagem_url em questoes_banco_global
  await pool.query(`ALTER TABLE questoes_banco_global ADD COLUMN IF NOT EXISTS imagem_url VARCHAR(500) NULL AFTER imagem_base64`);
  console.log('✅ questoes_banco_global.imagem_url adicionada');

  // 3. Tabela questao_temas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questao_temas (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      questao_id INT NOT NULL,
      fonte      ENUM('local','global','master') NOT NULL DEFAULT 'local',
      tema       VARCHAR(100) NOT NULL,
      INDEX idx_tema (tema),
      INDEX idx_questao_fonte (questao_id, fonte)
    )
  `);
  console.log('✅ questao_temas criada');

  // 4. Tabela questoes_master
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questoes_master (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      codigo              VARCHAR(20) UNIQUE,
      disciplina          VARCHAR(80) NOT NULL,
      area_conhecimento   VARCHAR(80),
      conteudo            VARCHAR(120) NOT NULL,
      tema                VARCHAR(120) NOT NULL,
      subtema             VARCHAR(120),
      nivel               ENUM('basico','intermediario','avancado','vestibular','enem') NOT NULL DEFAULT 'intermediario',
      serie               VARCHAR(20),
      habilidade_bncc     VARCHAR(20),
      palavras_chave      JSON,
      tipo                ENUM('objetiva','discursiva','verdadeiro_falso') NOT NULL DEFAULT 'objetiva',
      enunciado           TEXT NOT NULL,
      imagem_url          VARCHAR(500),
      texto_apoio         TEXT,
      alternativas_json   JSON,
      correta             CHAR(1),
      gabarito_comentado  TEXT NOT NULL,
      dicas               JSON,
      resolucao_completa  TEXT,
      conceito_chave      TEXT,
      fonte               VARCHAR(300) NOT NULL,
      fonte_tipo          ENUM('enem','vestibular','concurso','livro','autoria_educa') DEFAULT 'enem',
      ano_fonte           YEAR,
      status              ENUM('rascunho','revisao','publicado','arquivado') NOT NULL DEFAULT 'rascunho',
      criada_por          VARCHAR(80) DEFAULT 'agente_ia',
      revisada_por        VARCHAR(80),
      publicada_em        DATETIME,
      criada_em           DATETIME DEFAULT NOW(),
      atualizada_em       DATETIME DEFAULT NOW() ON UPDATE NOW(),
      visualizacoes       INT DEFAULT 0,
      FULLTEXT INDEX ft_busca (enunciado, gabarito_comentado),
      INDEX idx_disciplina (disciplina),
      INDEX idx_nivel (nivel),
      INDEX idx_status (status),
      INDEX idx_conteudo (conteudo)
    )
  `);
  console.log('✅ questoes_master criada');

  // 5. Tabela questao_master_temas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questao_master_temas (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      questao_id INT NOT NULL,
      tema       VARCHAR(100) NOT NULL,
      INDEX idx_tema (tema),
      INDEX idx_questao (questao_id)
    )
  `);
  console.log('✅ questao_master_temas criada');

  // 6. Limpar dados de teste
  const [r1] = await pool.query('DELETE FROM questoes');
  console.log(`🗑️  questoes de teste removidas: ${r1.affectedRows}`);
  const [r2] = await pool.query('DELETE FROM questoes_banco_global');
  console.log(`🗑️  questoes_banco_global de teste removidas: ${r2.affectedRows}`);

  console.log('\n✅ Migration concluída com sucesso!');
} catch(err) {
  console.error('\n❌ ERRO:', err.message);
  console.error(err);
} finally {
  await pool.end();
  process.exit(0);
}
