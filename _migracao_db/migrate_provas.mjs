// migrate_provas.mjs — Cria tabelas provas e prova_questoes
// Executar: node _migracao_db/migrate_provas.mjs

import mysql from 'mysql2/promise';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env.development') });

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: process.env.MYSQL_SSLMODE === 'REQUIRED' ? { rejectUnauthorized: false } : undefined,
  multipleStatements: true,
});

console.log('✅ Conectado:', process.env.MYSQL_DATABASE);

// ── provas ────────────────────────────────────────────────────────────────
await conn.query(`
  CREATE TABLE IF NOT EXISTS provas (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    escola_id     INT DEFAULT NULL,
    professor_id  INT DEFAULT NULL,
    titulo        VARCHAR(200) NOT NULL DEFAULT 'Nova Prova',
    disciplina    VARCHAR(100) DEFAULT NULL,
    turma         VARCHAR(80)  DEFAULT NULL,
    bimestre      TINYINT DEFAULT NULL,
    ano_letivo    YEAR DEFAULT NULL,
    template_slug VARCHAR(50)  NOT NULL DEFAULT 'objetiva_2col',
    config_json   JSON,
    status        ENUM('montando','pronta','impressa','aplicada') NOT NULL DEFAULT 'montando',
    pdf_url       VARCHAR(500) DEFAULT NULL,
    criada_em     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizada_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_provas_escola (escola_id),
    INDEX idx_provas_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);
console.log('  ✅ Tabela provas OK');

// ── prova_questoes ─────────────────────────────────────────────────────────
await conn.query(`
  CREATE TABLE IF NOT EXISTS prova_questoes (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    prova_id    INT NOT NULL,
    questao_id  INT NOT NULL,
    ordem       INT NOT NULL DEFAULT 0,
    valor_pontos DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    FOREIGN KEY (prova_id) REFERENCES provas(id) ON DELETE CASCADE,
    INDEX idx_pq_prova (prova_id),
    INDEX idx_pq_questao (questao_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`);
console.log('  ✅ Tabela prova_questoes OK');

const [[{ c1 }]] = await conn.query('SELECT COUNT(*) AS c1 FROM provas');
const [[{ c2 }]] = await conn.query('SELECT COUNT(*) AS c2 FROM prova_questoes');
console.log(`\n🎉 Migração Sprint 3 concluída! provas=${c1} prova_questoes=${c2}\n`);
await conn.end();
