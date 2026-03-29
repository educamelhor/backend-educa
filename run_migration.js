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
        const sql = fs.readFileSync(join(__dirname, "_migracao_db", "create_tipos_ocorrencia.sql"), "utf8");
        await pool.query(sql);
        console.log("Migration executada.");
    } catch (e) {
        console.error("Erro na migration:", e);
    } finally {
        pool.end();
    }
}
run();
