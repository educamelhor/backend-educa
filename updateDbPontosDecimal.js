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
        await pool.query("ALTER TABLE tipos_ocorrencia MODIFY COLUMN pontos DECIMAL(5,1) DEFAULT 0.0;");
        console.log("Modified pontos to DECIMAL.");
    } catch (e) {
        console.error("Error modifying pontos:", e.message);
    }
    process.exit(0);
}

main();
