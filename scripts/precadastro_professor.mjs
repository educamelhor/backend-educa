/**
 * Script: pré-cadastro de professor via SQL
 * Professor: CASSIO RODRIGUES VIANA | CPF: 86356712104
 *
 * Uso:
 *   node scripts/precadastro_professor.mjs            → lista escolas
 *   node scripts/precadastro_professor.mjs <escola_id> → insere o professor
 */

import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env.development") });

const CPF  = "86356712104";
const NOME = "CASSIO RODRIGUES VIANA";

const pool = await mysql.createPool({
  host    : process.env.MYSQL_HOST,
  port    : Number(process.env.MYSQL_PORT || 25060),
  user    : process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl     : { ca: fs.readFileSync(path.join(__dirname, "../certs/do-mysql-ca.crt")) },
  connectionLimit: 3,
});

const escolaIdArg = process.argv[2] ? Number(process.argv[2]) : null;

if (!escolaIdArg) {
  // ── Modo consulta: lista escolas e verifica se o CPF já existe ──
  console.log("\n📋 Lista de escolas disponíveis:\n");
  const [escolas] = await pool.query("SELECT id, nome, apelido FROM escolas ORDER BY id");
  console.table(escolas.map(e => ({ id: e.id, nome: e.nome, apelido: e.apelido })));

  const [jaExiste] = await pool.query(
    "SELECT id, escola_id, nome, cpf, status FROM professores WHERE REPLACE(REPLACE(cpf,'.',''),'-','') = ?",
    [CPF]
  );
  if (jaExiste.length > 0) {
    console.log("\n⚠️  Professor já cadastrado nas seguintes escolas:");
    console.table(jaExiste);
  } else {
    console.log("\n✅ CPF ainda não cadastrado em professores.");
  }

  const [jaUsuario] = await pool.query(
    "SELECT id, escola_id, nome, cpf, perfil, ativo FROM usuarios WHERE REPLACE(REPLACE(cpf,'.',''),'-','') = ?",
    [CPF]
  );
  if (jaUsuario.length > 0) {
    console.log("\n⚠️  CPF já existe em usuarios:");
    console.table(jaUsuario);
  } else {
    console.log("✅ CPF ainda não cadastrado em usuarios.");
  }

  console.log(`\n👉 Execute novamente passando o escola_id desejado:\n   node scripts/precadastro_professor.mjs <escola_id>\n`);
  await pool.end();
  process.exit(0);
}

// ── Modo inserção ──
console.log(`\n🚀 Inserindo professor CPF=${CPF} nome="${NOME}" na escola_id=${escolaIdArg} …\n`);

// Verifica duplicata
const [[jaExiste]] = await pool.query(
  "SELECT id FROM professores WHERE REPLACE(REPLACE(cpf,'.',''),'-','') = ? AND escola_id = ? LIMIT 1",
  [CPF, escolaIdArg]
);
if (jaExiste) {
  console.log(`⚠️  Professor já cadastrado nesta escola (id=${jaExiste.id}). Nenhuma ação necessária.`);
  await pool.end();
  process.exit(0);
}

// Insere em professores
const [res1] = await pool.query(
  "INSERT INTO professores (escola_id, cpf, nome, aulas, status) VALUES (?, ?, UPPER(?), 0, 'ativo')",
  [escolaIdArg, CPF, NOME]
);
console.log(`✅ professores → INSERT OK  (insertId=${res1.insertId})`);

// Insere/atualiza em usuarios
const [res2] = await pool.query(
  `INSERT INTO usuarios (cpf, nome, perfil, escola_id, senha_hash, ativo)
   VALUES (?, UPPER(?), 'professor', ?, '', 1)
   ON DUPLICATE KEY UPDATE nome=VALUES(nome), perfil='professor', ativo=1`,
  [CPF, NOME, escolaIdArg]
);
console.log(`✅ usuarios    → INSERT/UPDATE OK  (affectedRows=${res2.affectedRows})`);

console.log("\n🎉 Pré-cadastro concluído com sucesso!\n");
await pool.end();
