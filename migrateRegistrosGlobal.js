/**
 * Migração: Tornar registros_ocorrencias uma tabela GLOBAL (sem escola_id).
 * 
 * Os registros de ocorrências vêm do regimento e são idênticos para todas
 * as escolas cívico-militares. Não há necessidade de escola_id.
 * 
 * Passos:
 * 1. Remover registros duplicados (manter apenas 1 cópia de cada)
 * 2. Remover constraint antiga
 * 3. Remover coluna escola_id
 * 4. Criar nova constraint UNIQUE (tipo_ocorrencia, descricao_ocorrencia)
 * 5. Resetar AUTO_INCREMENT
 */
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
        console.log("🔄 Iniciando migração: registros_ocorrencias → tabela GLOBAL\n");

        // Contar registros antes
        const [beforeCount] = await conn.query("SELECT COUNT(*) as total FROM registros_ocorrencias");
        console.log(`📊 Registros antes: ${beforeCount[0].total}`);

        await conn.beginTransaction();

        // 1. Remover duplicados (manter o menor ID de cada combinação tipo+descricao)
        console.log("\n1️⃣  Removendo registros duplicados...");
        const [dupsDeleted] = await conn.query(`
            DELETE r1 FROM registros_ocorrencias r1
            INNER JOIN registros_ocorrencias r2
            WHERE r1.id > r2.id
              AND r1.tipo_ocorrencia = r2.tipo_ocorrencia
              AND r1.descricao_ocorrencia = r2.descricao_ocorrencia
        `);
        console.log(`   ✅ Duplicados removidos: ${dupsDeleted.affectedRows}`);

        // 2. Remover constraint antiga
        console.log("\n2️⃣  Removendo constraint antiga...");
        try {
            await conn.query("ALTER TABLE registros_ocorrencias DROP INDEX unique_descricao_escola");
            console.log("   ✅ Constraint unique_descricao_escola removida");
        } catch (e) {
            console.log("   ⏭️  Constraint não existia, seguindo...");
        }

        // 3. Remover coluna escola_id
        console.log("\n3️⃣  Removendo coluna escola_id...");
        try {
            await conn.query("ALTER TABLE registros_ocorrencias DROP COLUMN escola_id");
            console.log("   ✅ Coluna escola_id removida");
        } catch (e) {
            console.log("   ⏭️  Coluna escola_id não existia:", e.message);
        }

        // 4. Criar nova constraint UNIQUE
        console.log("\n4️⃣  Criando nova constraint UNIQUE (tipo_ocorrencia, descricao_ocorrencia)...");
        await conn.query(
            "ALTER TABLE registros_ocorrencias ADD UNIQUE KEY unique_tipo_descricao (tipo_ocorrencia, descricao_ocorrencia)"
        );
        console.log("   ✅ Nova constraint criada");

        // 5. Resetar AUTO_INCREMENT
        console.log("\n5️⃣  Resetando AUTO_INCREMENT...");
        await conn.query("ALTER TABLE registros_ocorrencias AUTO_INCREMENT = 1");
        console.log("   ✅ AUTO_INCREMENT resetado");

        await conn.commit();

        // Contar registros depois
        const [afterCount] = await conn.query("SELECT COUNT(*) as total FROM registros_ocorrencias");
        console.log(`\n📊 Registros depois: ${afterCount[0].total}`);
        console.log(`\n🎉 Migração concluída com sucesso! (${beforeCount[0].total} → ${afterCount[0].total} registros)`);

    } catch (error) {
        await conn.rollback();
        console.error("\n❌ Erro durante migração:", error.message);
        throw error;
    } finally {
        conn.release();
        process.exit(0);
    }
}

main();
