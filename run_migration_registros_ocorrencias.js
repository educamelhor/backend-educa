import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
dotenv.config({ path: join(__dirname, envFile) });

import pool from "./db.js";

async function run() {
    try {
        // Executar cada statement diretamente (sem depender de parsing do arquivo SQL)
        const statements = [
            "RENAME TABLE tipos_ocorrencia TO registros_ocorrencias",
            "ALTER TABLE registros_ocorrencias CHANGE COLUMN motivo descricao_ocorrencia VARCHAR(500) NOT NULL",
            "ALTER TABLE registros_ocorrencias CHANGE COLUMN tipo tipo_ocorrencia VARCHAR(50) DEFAULT 'Leve'",
            "ALTER TABLE registros_ocorrencias ADD COLUMN medida_disciplinar VARCHAR(100) NOT NULL DEFAULT 'Advertência Oral' AFTER escola_id",
            "ALTER TABLE registros_ocorrencias DROP INDEX unique_motivo_escola, ADD UNIQUE KEY unique_descricao_escola (escola_id, descricao_ocorrencia)",
        ];

        for (const stmt of statements) {
            const preview = stmt.substring(0, 80);
            console.log(`Executando: ${preview}...`);
            try {
                await pool.query(stmt);
                console.log("  ✅ OK");
            } catch (e) {
                // Ignora erros de coluna/tabela/index já existente (para idempotência)
                const ignoreCodes = [
                    "ER_TABLE_EXISTS_ERROR",
                    "ER_DUP_FIELDNAME",
                    "ER_CANT_DROP_FIELD_OR_KEY",
                    "ER_BAD_TABLE_ERROR",       // tabela antiga já não existe
                ];
                if (ignoreCodes.includes(e.code)) {
                    console.log(`  ⚠️ Ignorado (já aplicado): ${e.message}`);
                } else {
                    throw e;
                }
            }
        }

        console.log("\n✅ Migração concluída com sucesso!");
    } catch (e) {
        console.error("❌ Erro na migração:", e);
    } finally {
        pool.end();
    }
}

run();
