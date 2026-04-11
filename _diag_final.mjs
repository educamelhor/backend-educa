import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env.development") });

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  timezone: '+00:00',
});

// Aluno ORIGINAL (id=1220) e NOVO (id=2308) — ambos RE=254831
const [original] = await conn.query("SELECT id, codigo, HEX(codigo) as h FROM alunos WHERE id = 1220");
const [novo] = await conn.query("SELECT id, codigo, HEX(codigo) as h FROM alunos WHERE id = 2308");
console.log("Original:", JSON.stringify(original[0]));
console.log("Novo:", JSON.stringify(novo[0]));

// O campo 'codigo' é int ou varchar?
const [cols] = await conn.query("SHOW COLUMNS FROM alunos WHERE Field = 'codigo'");
console.log("\nColumn type:", JSON.stringify(cols[0]));

// Teste de match direto
const codOriginal = original[0]?.codigo;
const codNovo = novo[0]?.codigo;
console.log(`\ncod original: "${codOriginal}" (${typeof codOriginal})`);
console.log(`cod novo: "${codNovo}" (${typeof codNovo})`);
console.log(`String match: ${String(codOriginal) === String(codNovo)}`);

// AGORA: limpar duplicatas criadas pelo import errado
const [[cntDups]] = await conn.query(`
  SELECT COUNT(*) as c FROM alunos 
  WHERE id >= 2307 AND id <= 2500 AND escola_id = 1
`);
console.log(`\nAlunos inseridos pelo import errado (id >= 2307): ${cntDups.c}`);

await conn.end();
