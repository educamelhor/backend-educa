import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, ".env.development") });

import pool from "./db.js";

async function run() {
    try {
        const sql = fs.readFileSync(join(__dirname, "_migracao_db", "create_avaliacoes_tables.sql"), "utf8");
        // We might need to split statements if the driver doesn't support multiple statements, but let's try it first.
        // Usually mysql2 supports multiple statements if configured, otherwise we must split.
        const statements = sql.split(/;(?=\s*\n\s*--|s*\n\s*CREATE)/).filter(s => s.trim().length > 0);
        for(let stmt of statements) {
           await pool.query(stmt + ";");
        }
        console.log("Migration executada.");
    } catch (e) {
        console.error("Erro na migration:", e);
    } finally {
        pool.end();
    }
}
run();
