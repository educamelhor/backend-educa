// migrations/2026_10_05_f1_agrupamentos.mjs
// =============================================================================
// F1 — Turmas de Agrupamento (IFA / eletivas / PCA por escolha) — BANCO ADITIVO
//
// O que faz (tudo aditivo e idempotente):
//   1) Backup nativo de `disciplinas` (única tabela existente alterada):
//      disciplinas_bak_20261005
//   2) disciplinas.modo_oferta ENUM('TURMA','AGRUPAMENTO') DEFAULT 'TURMA'
//      (backfill por `tipo` somente no momento em que a coluna é criada)
//   3) Cria: agrupamentos, agrupamento_componentes, agrupamento_alunos,
//            agrupamento_modulacao
//
// O que NÃO faz: não altera modulacao, matriculas, turmas, notas, turma_cargas.
//
// Uso:
//   node migrations/2026_10_05_f1_agrupamentos.mjs              (dry-run: só audita)
//   node migrations/2026_10_05_f1_agrupamentos.mjs --apply      (aplica)
//   node migrations/2026_10_05_f1_agrupamentos.mjs --rollback   (remove o que a F1 criou,
//                                                                 só se as tabelas estiverem vazias)
// Não importa db.js (evita auto-migrações de boot).
// =============================================================================
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACK = path.resolve(__dirname, '..');
const require = createRequire(BACK + '/package.json');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const env = dotenv.parse(fs.readFileSync(path.join(BACK, process.env.ENV_FILE || '.env.development')));

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const BAK = 'disciplinas_bak_20261005';
const NOVAS = ['agrupamento_modulacao', 'agrupamento_alunos', 'agrupamento_componentes', 'agrupamentos']; // ordem de DROP

const DDL = {
  agrupamentos: `
    CREATE TABLE IF NOT EXISTS agrupamentos (
      id            INT NOT NULL AUTO_INCREMENT,
      escola_id     BIGINT UNSIGNED NOT NULL,
      ano_letivo    YEAR NOT NULL,
      semestre      TINYINT NOT NULL DEFAULT 1 COMMENT '0=anual, 1=1º semestre, 2=2º semestre',
      nome          VARCHAR(100) NOT NULL COMMENT 'nome dado pela escola (ex.: IFA Robótica A)',
      tipo          VARCHAR(30) NOT NULL DEFAULT 'IFA' COMMENT 'IFA|PCA|ELETIVA|PROJETO|OUTRO',
      etapa_id      INT NULL,
      turno         ENUM('Matutino','Vespertino','Noturno','Integral') NOT NULL,
      capacidade    SMALLINT UNSIGNED NULL,
      status        ENUM('RASCUNHO','ABERTO','ENCERRADO') NOT NULL DEFAULT 'ABERTO',
      origem_disciplina_legada_id INT NULL COMMENT 'rastreio do Assistente de Migração (disciplina IFA_* de origem)',
      criado_em     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_agrupamento (escola_id, ano_letivo, semestre, turno, nome),
      KEY idx_agr_escola_ano (escola_id, ano_letivo, semestre),
      CONSTRAINT fk_agr_escola FOREIGN KEY (escola_id) REFERENCES escolas (id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_agr_etapa  FOREIGN KEY (etapa_id)  REFERENCES etapas (id)  ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  agrupamento_componentes: `
    CREATE TABLE IF NOT EXISTS agrupamento_componentes (
      id             INT NOT NULL AUTO_INCREMENT,
      escola_id      BIGINT UNSIGNED NOT NULL,
      agrupamento_id INT NOT NULL,
      disciplina_id  INT NOT NULL COMMENT 'componente/atividade cadastrada pela escola no catálogo',
      carga_semanal  TINYINT UNSIGNED NOT NULL DEFAULT 1,
      criado_em      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_agr_comp (agrupamento_id, disciplina_id),
      KEY idx_agr_comp_escola (escola_id),
      KEY idx_agr_comp_disc (disciplina_id),
      CONSTRAINT fk_agrcomp_agr  FOREIGN KEY (agrupamento_id) REFERENCES agrupamentos (id) ON DELETE CASCADE,
      CONSTRAINT fk_agrcomp_disc FOREIGN KEY (disciplina_id)  REFERENCES disciplinas (id),
      CONSTRAINT fk_agrcomp_escola FOREIGN KEY (escola_id) REFERENCES escolas (id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  agrupamento_alunos: `
    CREATE TABLE IF NOT EXISTS agrupamento_alunos (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      escola_id       BIGINT UNSIGNED NOT NULL,
      agrupamento_id  INT NOT NULL,
      aluno_id        BIGINT UNSIGNED NOT NULL,
      matricula_id    BIGINT UNSIGNED NULL COMMENT 'matrícula da turma base (rastreio; não substitui)',
      turma_origem_id INT NULL,
      status          ENUM('ativo','inativo') NOT NULL DEFAULT 'ativo',
      entrada_em      DATE NULL,
      saida_em        DATE NULL,
      criado_em       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_agr_aluno (agrupamento_id, aluno_id),
      KEY idx_agr_aluno_escola (escola_id, aluno_id),
      CONSTRAINT fk_agral_agr    FOREIGN KEY (agrupamento_id)  REFERENCES agrupamentos (id) ON DELETE CASCADE,
      CONSTRAINT fk_agral_aluno  FOREIGN KEY (aluno_id)        REFERENCES alunos (id)       ON DELETE CASCADE,
      CONSTRAINT fk_agral_matr   FOREIGN KEY (matricula_id)    REFERENCES matriculas (id)   ON DELETE SET NULL,
      CONSTRAINT fk_agral_turma  FOREIGN KEY (turma_origem_id) REFERENCES turmas (id)       ON DELETE SET NULL,
      CONSTRAINT fk_agral_escola FOREIGN KEY (escola_id) REFERENCES escolas (id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  agrupamento_modulacao: `
    CREATE TABLE IF NOT EXISTS agrupamento_modulacao (
      id             INT NOT NULL AUTO_INCREMENT,
      escola_id      BIGINT UNSIGNED NOT NULL,
      agrupamento_id INT NOT NULL,
      professor_id   INT NOT NULL,
      disciplina_id  INT NOT NULL,
      aulas          INT NOT NULL,
      criado_em      DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_agr_mod (agrupamento_id, professor_id, disciplina_id),
      KEY idx_agr_mod_prof (professor_id),
      KEY idx_agr_mod_escola (escola_id),
      CONSTRAINT fk_agrmod_comp FOREIGN KEY (agrupamento_id, disciplina_id)
        REFERENCES agrupamento_componentes (agrupamento_id, disciplina_id) ON DELETE CASCADE,
      CONSTRAINT fk_agrmod_prof FOREIGN KEY (professor_id) REFERENCES professores (id),
      CONSTRAINT fk_agrmod_escola FOREIGN KEY (escola_id) REFERENCES escolas (id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
};

const conn = await mysql.createConnection({
  host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE,
  ssl: { rejectUnauthorized: false }, timezone: '+00:00',
});
const one = async (sql, p = []) => { const [r] = await conn.query(sql, p); return r; };
const count = async (t) => Number((await one(`SELECT COUNT(*) n FROM \`${t}\``))[0].n);
const exists = async (t) => (await one(`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [t])).length > 0;
const hasCol = async (t, c) => (await one(`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [t, c])).length > 0;
const SENTINELAS = ['notas', 'matriculas', 'modulacao', 'turma_cargas', 'turmas', 'alunos', 'disciplinas', 'professor_vinculos'];
const snap = async () => { const o = {}; for (const t of SENTINELAS) o[t] = await count(t); return o; };

try {
  console.log(`\n=== F1 AGRUPAMENTOS — modo: ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY-RUN'} — banco: ${env.MYSQL_DATABASE} ===\n`);

  if (ROLLBACK) {
    for (const t of NOVAS) {
      if (!(await exists(t))) { console.log(`- ${t}: não existe, nada a fazer`); continue; }
      const n = await count(t);
      if (n > 0) throw new Error(`ROLLBACK ABORTADO: ${t} tem ${n} linha(s). Remova/arquive os dados antes.`);
      await conn.query(`DROP TABLE \`${t}\``);
      console.log(`- ${t}: removida (estava vazia)`);
    }
    if (await hasCol('disciplinas', 'modo_oferta')) {
      await conn.query('ALTER TABLE disciplinas DROP COLUMN modo_oferta');
      console.log('- disciplinas.modo_oferta: removida');
    }
    console.log('\nROLLBACK concluído. Backup mantido:', BAK);
  } else {
    const antes = await snap();
    console.log('[ANTES]', JSON.stringify(antes));

    const jaTemCol = await hasCol('disciplinas', 'modo_oferta');
    const planejado = [
      `backup ${BAK}: ${(await exists(BAK)) ? 'já existe (mantido)' : 'será criado'}`,
      `disciplinas.modo_oferta: ${jaTemCol ? 'já existe' : 'será criada'}`,
      ...await Promise.all(Object.keys(DDL).map(async (t) => `${t}: ${(await exists(t)) ? 'já existe' : 'será criada'}`)),
    ];
    console.log('[PLANO]\n  - ' + planejado.join('\n  - '));

    if (!APPLY) {
      console.log('\nDRY-RUN: nada foi alterado. Rode com --apply para executar.');
    } else {
      // 1) Backup nativo
      if (!(await exists(BAK))) {
        // LIKE preserva a PK (o MySQL gerenciado tem sql_require_primary_key=ON)
        await conn.query(`CREATE TABLE \`${BAK}\` LIKE disciplinas`);
        await conn.query(`INSERT INTO \`${BAK}\` SELECT * FROM disciplinas`);
        const [a, b] = [await count(BAK), antes.disciplinas];
        if (a !== b) throw new Error(`Backup divergente: ${a} != ${b}`);
        console.log(`✔ backup ${BAK}: ${a} linhas`);
      }
      // 2) Coluna modo_oferta (+ backfill só na criação)
      if (!jaTemCol) {
        await conn.query(`ALTER TABLE disciplinas
          ADD COLUMN modo_oferta ENUM('TURMA','AGRUPAMENTO') NOT NULL DEFAULT 'TURMA'
          COMMENT 'TURMA=matriz da turma | AGRUPAMENTO=por escolha do aluno' AFTER tipo`);
        const [r] = await conn.query(`UPDATE disciplinas SET modo_oferta='AGRUPAMENTO' WHERE tipo IN ('IFA','ELETIVA','PROJETO')`);
        console.log(`✔ disciplinas.modo_oferta criada; backfill por tipo afetou ${r.affectedRows} linha(s)`);
      }
      // 3) Tabelas novas (ordem de dependência)
      for (const t of ['agrupamentos', 'agrupamento_componentes', 'agrupamento_alunos', 'agrupamento_modulacao']) {
        await conn.query(DDL[t]);
        console.log(`✔ ${t}: ok`);
      }
      // 4) Gates
      const depois = await snap();
      console.log('[DEPOIS]', JSON.stringify(depois));
      for (const t of SENTINELAS) if (antes[t] !== depois[t]) throw new Error(`GATE FALHOU: ${t} ${antes[t]} -> ${depois[t]}`);
      for (const t of NOVAS) if ((await count(t)) !== 0) throw new Error(`GATE FALHOU: ${t} deveria estar vazia`);
      const orf = await one(`SELECT COUNT(*) n FROM disciplinas WHERE modo_oferta IS NULL`);
      if (Number(orf[0].n) !== 0) throw new Error('GATE FALHOU: modo_oferta nulo');
      console.log('\n✔ GATES OK: contagens do legado idênticas; novas tabelas vazias.');
    }
  }
} catch (e) {
  console.error('\n✖ ERRO:', e.message);
  process.exitCode = 1;
} finally {
  await conn.end();
}
