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

console.log("=== REVERTENDO ALUNOS INATIVADOS ===\n");

// 1. Reativar alunos inativados na tabela `alunos`
const [res1] = await conn.query(`
  UPDATE alunos a
  JOIN turmas t ON t.id = a.turma_id
  SET a.status = 'ativo'
  WHERE a.escola_id = 1 
    AND a.status = 'inativo' 
    AND t.ano = '2026'
`);
console.log(`[alunos] ${res1.affectedRows} reativados (inativo → ativo)`);

// 2. Reativar matrículas inativadas
const [res2] = await conn.query(`
  UPDATE matriculas 
  SET status = 'ativo'
  WHERE escola_id = 1 
    AND ano_letivo = 2026 
    AND status = 'inativo'
`);
console.log(`[matriculas] ${res2.affectedRows} reativadas (inativo → ativo)`);

// 3. Verificar resultado
const [check1] = await conn.query(`
  SELECT a.status, COUNT(*) as total
  FROM alunos a
  JOIN turmas t ON t.id = a.turma_id
  WHERE a.escola_id = 1 AND t.ano = '2026'
  GROUP BY a.status
`);
console.log("\n=== Status alunos após reversão ===");
check1.forEach(r => console.log(`  ${r.status}: ${r.total}`));

const [check2] = await conn.query(`
  SELECT status, COUNT(*) as total
  FROM matriculas
  WHERE escola_id = 1 AND ano_letivo = 2026
  GROUP BY status
`);
console.log("\n=== Status matrículas após reversão ===");
check2.forEach(r => console.log(`  ${r.status}: ${r.total}`));

await conn.end();
console.log("\n✅ Reversão concluída!");
