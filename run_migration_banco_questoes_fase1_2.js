/**
 * run_migration_banco_questoes_fase1_2.js
 * Executa a migration da Fase 1+2 do Banco de Questões
 * Uso: node run_migration_banco_questoes_fase1_2.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carrega .env.development local (se existir)
dotenv.config({ path: join(__dirname, ".env.development") });

import pool from "./db.js";

async function run() {
  try {
    const sqlPath = join(__dirname, "_migracao_db", "migrate_banco_questoes_fase1_2.sql");
    const sql = fs.readFileSync(sqlPath, "utf8");

    // Divide por DELIMITER para executar statements individualmente
    // O mysql2 não suporta múltiplos statements com DELIMITER por padrão
    // Usamos multipleStatements: true na pool (verificar se db.js suporta)
    const [results] = await pool.query(sql);
    console.log("✅ Migration Fase 1+2 executada com sucesso!");
    if (Array.isArray(results)) {
      // Mostra resultado da verificação final
      const lastResult = results[results.length - 1];
      if (lastResult && Array.isArray(lastResult)) {
        console.log("\nVerificação:");
        lastResult.forEach(r => console.log(`  ${r.campo}: ${r.status}`));
      }
    }
  } catch (e) {
    console.error("❌ Erro na migration:", e.message);
    console.error(e);
  } finally {
    await pool.end();
  }
}

run();
