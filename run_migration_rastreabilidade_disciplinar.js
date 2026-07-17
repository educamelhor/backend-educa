// run_migration_rastreabilidade_disciplinar.js
// ============================================================
// Adiciona colunas de rastreabilidade à tabela ocorrencias_disciplinares:
//   - usuario_impressao_id : quem imprimiu o registro (pode ser NULL)
//   - usuario_edicao_id    : quem editou o registro pela última vez
// ============================================================

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
dotenv.config({ path: join(__dirname, envFile) });

import pool from "./db.js";

async function run() {
  try {
    const statements = [
      // Rastreabilidade: quem imprimiu o PDF do registro
      `ALTER TABLE ocorrencias_disciplinares
       ADD COLUMN usuario_impressao_id INT NULL DEFAULT NULL
       AFTER usuario_finalizacao_id`,

      // Rastreabilidade: quem editou o registro pela última vez
      `ALTER TABLE ocorrencias_disciplinares
       ADD COLUMN usuario_edicao_id INT NULL DEFAULT NULL
       AFTER usuario_impressao_id`,

      // Índices para facilitar JOINs de rastreabilidade
      `ALTER TABLE ocorrencias_disciplinares
       ADD INDEX idx_usuario_impressao (usuario_impressao_id)`,

      `ALTER TABLE ocorrencias_disciplinares
       ADD INDEX idx_usuario_edicao (usuario_edicao_id)`,
    ];

    for (const stmt of statements) {
      const preview = stmt.trim().substring(0, 80).replace(/\s+/g, " ");
      console.log(`Executando: ${preview}...`);
      try {
        await pool.query(stmt);
        console.log("  ✅ OK");
      } catch (e) {
        const ignoreCodes = [
          "ER_DUP_FIELDNAME",         // coluna já existe
          "ER_DUP_KEYNAME",           // índice já existe
          "ER_CANT_DROP_FIELD_OR_KEY",
        ];
        if (ignoreCodes.includes(e.code)) {
          console.log(`  ⚠️  Ignorado (já aplicado): ${e.message}`);
        } else {
          throw e;
        }
      }
    }

    console.log("\n✅ Migração de rastreabilidade disciplinar concluída!");
  } catch (e) {
    console.error("❌ Erro na migração:", e);
  } finally {
    pool.end();
  }
}

run();
