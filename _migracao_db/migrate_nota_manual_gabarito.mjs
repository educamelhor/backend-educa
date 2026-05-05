// Migration: adiciona suporte a edição manual de nota no módulo Gabarito > Resultados
// Colunas: nota_manual (tinyint), nota_manual_justificativa (text)
import { createRequire } from "module";
import { createConnection } from "mysql2/promise";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, "../.env.development") });

const conn = await createConnection({
  host:     process.env.MYSQL_HOST,
  port:     Number(process.env.MYSQL_PORT || 3306),
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl:      { rejectUnauthorized: false },
});

try {
  console.log("[migrate] Adicionando colunas nota_manual em gabarito_respostas...");

  // MySQL < 8.0 não suporta ADD COLUMN IF NOT EXISTS — tentar separado
  for (const col of [
    "ALTER TABLE gabarito_respostas ADD COLUMN nota_manual TINYINT(1) NOT NULL DEFAULT 0",
    "ALTER TABLE gabarito_respostas ADD COLUMN nota_manual_justificativa TEXT NULL",
  ]) {
    try {
      await conn.query(col);
      console.log(`  ✅ ${col.split(" ADD COLUMN ")[1].split(" ")[0]} adicionada.`);
    } catch (e) {
      if (e.code === "ER_DUP_FIELDNAME") {
        console.log(`  ⏭  Coluna já existe (ignorado).`);
      } else {
        throw e;
      }
    }
  }

  console.log("[migrate] ✅ Concluído.");
} finally {
  await conn.end();
}
