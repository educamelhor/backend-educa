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

// Buscar turma_id de "6º ANO A" no ano 2026
const [[turma]] = await conn.query(
  "SELECT id, nome, ano FROM turmas WHERE nome = '6º ANO A' AND escola_id = 1 AND ano = '2026'"
);
console.log("Turma no DB:", turma);

// Verificar alunos com turma_id = turma.id
const [alunos] = await conn.query(
  "SELECT id, codigo, estudante, status, turma_id FROM alunos WHERE turma_id = ? LIMIT 5",
  [turma.id]
);
console.log(`\nAlunos com turma_id=${turma.id} (${alunos.length} total):`);
alunos.forEach(a => console.log(`  RE=${a.codigo} ${a.estudante} [${a.status}] turma_id=${a.turma_id}`));

// Verificar se existem alunos com turma_id NULL mas matriculados nessa turma
const [viaMatriculas] = await conn.query(`
  SELECT a.id, a.codigo, a.estudante, a.status, a.turma_id, m.turma_id AS matricula_turma_id
  FROM alunos a
  JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = a.escola_id
  WHERE m.turma_id = ? AND a.escola_id = 1
  LIMIT 5
`, [turma.id]);
console.log(`\nAlunos via matriculas (turma_id=${turma.id}):`);
viaMatriculas.forEach(a => console.log(`  RE=${a.codigo} ${a.estudante} [${a.status}] alunos.turma_id=${a.turma_id} matriculas.turma_id=${a.matricula_turma_id}`));

// Contar total via alunos.turma_id vs matriculas.turma_id
const [[c1]] = await conn.query("SELECT COUNT(*) AS cnt FROM alunos WHERE turma_id = ?", [turma.id]);
const [[c2]] = await conn.query("SELECT COUNT(*) AS cnt FROM matriculas WHERE turma_id = ? AND escola_id = 1", [turma.id]);
console.log(`\n[6º ANO A] alunos.turma_id: ${c1.cnt} | matriculas.turma_id: ${c2.cnt}`);

// Checar como turma_id é resolvido no endpoint importar-pdf
const turmaNome = "6º ANO A";
const [[found]] = await conn.query(
  "SELECT id FROM turmas WHERE nome = ? AND escola_id = 1",
  [turmaNome]
);
console.log(`\nBusca turma por nome "${turmaNome}" (SEM filtro ano): id=${found?.id}`);

// Se há múltiplas turmas com mesmo nome
const [todas] = await conn.query(
  "SELECT id, nome, ano FROM turmas WHERE nome = ? AND escola_id = 1 ORDER BY ano",
  [turmaNome]
);
console.log(`\nTurmas com nome "${turmaNome}":`);
todas.forEach(t => console.log(`  id=${t.id} ano=${t.ano}`));

await conn.end();
