/**
 * Insere CASSIO RODRIGUES VIANA na tabela usuarios (school_id=1)
 */
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env.development") });

const CPF       = "86356712104";
const NOME      = "CASSIO RODRIGUES VIANA";
const ESCOLA_ID = 1;

const pool = await mysql.createPool({
  host           : process.env.MYSQL_HOST,
  port           : Number(process.env.MYSQL_PORT || 25060),
  user           : process.env.MYSQL_USER,
  password       : process.env.MYSQL_PASSWORD,
  database       : process.env.MYSQL_DATABASE,
  ssl            : { ca: fs.readFileSync(path.join(__dirname, "../certs/do-mysql-ca.crt")) },
  connectionLimit: 2,
});

// 1) Insere / atualiza em usuarios
const [res] = await pool.query(
  `INSERT INTO usuarios (cpf, nome, perfil, escola_id, senha_hash, ativo)
   VALUES (?, UPPER(?), 'professor', ?, '', 1)
   ON DUPLICATE KEY UPDATE nome=VALUES(nome), perfil='professor', ativo=1`,
  [CPF, NOME, ESCOLA_ID]
);
console.log("usuarios INSERT/UPDATE OK — affectedRows:", res.affectedRows, "| insertId:", res.insertId);

// 2) Confirma resultado
const [rows] = await pool.query(
  "SELECT id, cpf, nome, perfil, escola_id, ativo FROM usuarios WHERE REPLACE(REPLACE(cpf,'.',''),'-','') = ?",
  [CPF]
);
console.log("\nRegistro final em usuarios:");
console.table(rows);

await pool.end();
