// run_migration_fo_coletivo_lote.js
// ============================================================
// Adiciona rastreabilidade de registros coletivos:
//   - lote_id  : UUID que agrupa todos alunos de um F.O. Coletivo
//   - origem   : 'individual' | 'coletivo'
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
      // UUID que vincula todos os alunos de um mesmo F.O. Coletivo
      `ALTER TABLE ocorrencias_disciplinares
       ADD COLUMN lote_id VARCHAR(36) NULL DEFAULT NULL
       AFTER usuario_edicao_id`,

      // Origem do registro: individual (padrão) ou coletivo
      `ALTER TABLE ocorrencias_disciplinares
       ADD COLUMN origem ENUM('individual','coletivo') NOT NULL DEFAULT 'individual'
       AFTER lote_id`,

      // Índices para buscas por lote e origem
      `ALTER TABLE ocorrencias_disciplinares
       ADD INDEX idx_lote_id (lote_id)`,

      `ALTER TABLE ocorrencias_disciplinares
       ADD INDEX idx_origem (origem)`,

      // Índice composto escola + origem + data → otimiza a busca do modal de impressão
      `ALTER TABLE ocorrencias_disciplinares
       ADD INDEX idx_escola_origem_data (escola_id, origem, data_ocorrencia)`,
    ];

    for (const stmt of statements) {
      const preview = stmt.trim().replace(/\s+/g, " ").substring(0, 90);
      console.log(`Executando: ${preview}...`);
      try {
        await pool.query(stmt);
        console.log("  ✅ OK");
      } catch (e) {
        const ignoreCodes = [
          "ER_DUP_FIELDNAME",
          "ER_DUP_KEYNAME",
          "ER_CANT_DROP_FIELD_OR_KEY",
        ];
        if (ignoreCodes.includes(e.code)) {
          console.log(`  ⚠️  Ignorado (já aplicado): ${e.message}`);
        } else {
          throw e;
        }
      }
    }

    console.log("\n✅ Migração F.O. Coletivo (lote_id + origem) concluída!");
  } catch (e) {
    console.error("❌ Erro na migração:", e);
  } finally {
    pool.end();
  }
}

run();
