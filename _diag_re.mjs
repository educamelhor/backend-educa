import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env.development") });

const { MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = process.env;

const conn = await mysql.createConnection({
  host: MYSQL_HOST, port: MYSQL_PORT || 3306,
  user: MYSQL_USER, password: MYSQL_PASSWORD, database: MYSQL_DATABASE,
  timezone: '+00:00',
});

// REs do banco (turma 6º ANO A)
const [dbAlunos] = await conn.query(
  "SELECT codigo FROM alunos WHERE turma_id = 202 ORDER BY codigo LIMIT 15"
);
console.log("=== REs no BANCO (6º ANO A, primeiros 15) ===");
dbAlunos.forEach(a => console.log(`  ${a.codigo} (tipo: ${typeof a.codigo})`));

// Ler o PDF e parsear para comparar
// Vou ler o relatório do agent para ver os REs que ele extraiu
const agentDir = "c:\\projetos\\sistema_educacional\\apps\\educa-agent\\downloads";
const files = fs.readdirSync(agentDir)
  .filter(f => f.startsWith("relatorio_"))
  .sort()
  .reverse();

if (files.length > 0) {
  const rel = JSON.parse(fs.readFileSync(join(agentDir, files[0]), "utf-8"));
  // O relatório não tem os REs individuais - preciso ver o PDF diretamente
  console.log(`\nÚltimo relatório: ${files[0]}`);
  console.log(`Turmas scraping: ${rel.etapa_scraping?.total_turmas}`);
  console.log(`Importação: ${JSON.stringify(rel.etapa_importacao?.detalhes?.[0])}`);
}

// Verificar codec/encoding do campo codigo
const [[sample]] = await conn.query("SELECT codigo, HEX(codigo) as hex_codigo FROM alunos WHERE turma_id = 202 LIMIT 1");
console.log(`\nSample: codigo="${sample.codigo}" hex="${sample.hex_codigo}" tipo=${typeof sample.codigo}`);

// Verificar se o parser do PDF retorna string ou int
// Checando pelo que o import inseriu (os 27 novos inseridos antes da reversão)
// Na verdade, os novos foram inseridos COM os REs do PDF, então devem estar no DB agora
const [todos] = await conn.query(`
  SELECT a.id, a.codigo, a.estudante, a.status 
  FROM alunos a 
  WHERE a.turma_id = 202 
  ORDER BY a.id DESC
  LIMIT 30
`);
console.log(`\n=== Últimos alunos inseridos na turma 202 (por id DESC) ===`);
todos.forEach(a => console.log(`  id=${a.id} RE="${a.codigo}" (tipo=${typeof a.codigo}) ${a.estudante} [${a.status}]`));

// Verificar total
const [[cnt]] = await conn.query("SELECT COUNT(*) as c FROM alunos WHERE turma_id = 202");
console.log(`\nTotal alunos na turma 202: ${cnt.c}`);

await conn.end();
