import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __filenameEnv = fileURLToPath(import.meta.url);
const __dirnameEnv = dirname(__filenameEnv);
const envFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
dotenv.config({ path: join(__dirnameEnv, envFile) });

import pool from "./db.js";

async function main() {
    const conn = await pool.getConnection();
    try {
        // Adicionar coluna tipo_ocorrencia à tabela ocorrencias_disciplinares
        await conn.query(
            "ALTER TABLE ocorrencias_disciplinares ADD COLUMN tipo_ocorrencia VARCHAR(50) DEFAULT NULL AFTER motivo"
        );
        console.log("✅ Coluna tipo_ocorrencia adicionada a ocorrencias_disciplinares");
    } catch (e) {
        if (e.message.includes("Duplicate column")) {
            console.log("⏭️  Coluna tipo_ocorrencia já existe");
        } else {
            console.error("❌ Erro:", e.message);
        }
    }

    // Atualizar registros existentes com o tipo_ocorrencia correto
    try {
        const [result] = await conn.query(`
            UPDATE ocorrencias_disciplinares o
            JOIN registros_ocorrencias r ON r.descricao_ocorrencia = o.motivo
            SET o.tipo_ocorrencia = r.tipo_ocorrencia
            WHERE o.tipo_ocorrencia IS NULL
        `);
        console.log(`✅ Registros existentes atualizados: ${result.affectedRows}`);
    } catch (e) {
        console.error("❌ Erro ao atualizar registros:", e.message);
    }

    conn.release();
    process.exit(0);
}

main();
