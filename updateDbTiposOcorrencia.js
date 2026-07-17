import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __filenameEnv = fileURLToPath(import.meta.url);
const __dirnameEnv = dirname(__filenameEnv);
const envFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
dotenv.config({ path: join(__dirnameEnv, envFile) });

import pool from "./db.js";

async function main() {
    try {
        await pool.query("ALTER TABLE tipos_ocorrencia ADD COLUMN pontos INT DEFAULT 0;");
        console.log("Added pontos column.");
    } catch (e) {
        console.error("Error adding pontos:", e.message);
    }
    
    try {
        await pool.query("ALTER TABLE tipos_ocorrencia ADD COLUMN tipo VARCHAR(20) DEFAULT 'leve';");
        console.log("Added tipo column.");
    } catch (e) {
        console.error("Error adding tipo:", e.message);
    }
    
    process.exit(0);
}

main();
