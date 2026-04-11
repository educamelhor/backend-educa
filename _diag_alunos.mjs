import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env.development") });

const { MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = process.env;

const conn = await mysql.createConnection({
  host: MYSQL_HOST, port: MYSQL_PORT || 3306,
  user: MYSQL_USER, password: MYSQL_PASSWORD, database: MYSQL_DATABASE,
  timezone: '+00:00',
});

// 1. Diagnóstico: turmas com alunos inativados recentemente
const [inativados] = await conn.query(`
  SELECT t.nome AS turma, COUNT(*) AS total_inativos
  FROM alunos a
  JOIN turmas t ON t.id = a.turma_id
  WHERE a.escola_id = 1 AND a.status = 'inativo' AND t.ano = '2026'
  GROUP BY t.nome
  ORDER BY t.nome
`);
console.log("=== Alunos INATIVOS por turma (2026) ===");
let totalInativos = 0;
inativados.forEach(r => { console.log(`  ${r.turma}: ${r.total_inativos}`); totalInativos += r.total_inativos; });
console.log(`  TOTAL: ${totalInativos}\n`);

// 2. Verificar alunos duplicados (inseridos pelo import equivocado)
const [duplicados] = await conn.query(`
  SELECT a.codigo, a.estudante, a.status, t.nome AS turma, a.id
  FROM alunos a
  JOIN turmas t ON t.id = a.turma_id
  WHERE a.escola_id = 1 AND t.ano = '2026'
  ORDER BY a.codigo, a.id
  LIMIT 30
`);
console.log("=== Primeiros 30 alunos (2026) ===");
duplicados.forEach(r => console.log(`  [${r.status}] RE=${r.codigo} ${r.estudante} (turma=${r.turma}, id=${r.id})`));

// 3. Verificar se há duplicatas de código
const [dups] = await conn.query(`
  SELECT codigo, COUNT(*) as cnt
  FROM alunos
  WHERE escola_id = 1 AND turma_id IN (SELECT id FROM turmas WHERE ano = '2026' AND escola_id = 1)
  GROUP BY codigo
  HAVING cnt > 1
  LIMIT 10
`);
console.log(`\n=== Códigos duplicados: ${dups.length} ===`);
dups.forEach(r => console.log(`  RE=${r.codigo}: ${r.cnt} registros`));

// 4. Verificar matriculas
const [matrs] = await conn.query(`
  SELECT m.status, COUNT(*) as total
  FROM matriculas m
  WHERE m.escola_id = 1 AND m.ano_letivo = 2026
  GROUP BY m.status
`);
console.log(`\n=== Matrículas 2026 por status ===`);
matrs.forEach(r => console.log(`  ${r.status}: ${r.total}`));

await conn.end();
