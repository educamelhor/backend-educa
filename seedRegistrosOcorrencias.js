/**
 * Seed: Popula registros_ocorrencias com dados do Excel do regimento.
 * Tabela GLOBAL — sem escola_id.
 * 
 * Os registros são universais para todas as escolas cívico-militares.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import XLSX from "xlsx";

const __filenameEnv = fileURLToPath(import.meta.url);
const __dirnameEnv = dirname(__filenameEnv);
const envFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
dotenv.config({ path: join(__dirnameEnv, envFile) });

import pool from "./db.js";

async function main() {
    const conn = await pool.getConnection();
    try {
        // 1. Ler o arquivo Excel
        const xlsxPath = join(__dirnameEnv, "..", "..", "geral", "ocorrencias_disciplinares_ccmdf.xlsx");
        const wb = XLSX.readFile(xlsxPath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws);

        console.log(`📋 Total de registros no Excel: ${data.length}`);

        await conn.beginTransaction();

        // 2. Excluir todos os dados existentes
        const [deleteResult] = await conn.query("DELETE FROM registros_ocorrencias");
        console.log(`🗑️  Registros excluídos: ${deleteResult.affectedRows}`);

        // Reset auto increment
        await conn.query("ALTER TABLE registros_ocorrencias AUTO_INCREMENT = 1");
        console.log("🔄 AUTO_INCREMENT resetado para 1");

        // 3. Inserir todos os dados do Excel (tabela GLOBAL, sem escola_id)
        let totalInseridos = 0;

        for (const row of data) {
            const medidaDisciplinar = row["Medida Disciplinar"] || "";
            const tipoOcorrencia = row["Tipo de ocorrência"] || "";
            const descricaoOcorrencia = row["Descrição da ocorrência"] || "";
            const pontos = row["Pontos"] !== undefined ? row["Pontos"] : 0;

            await conn.query(
                `INSERT INTO registros_ocorrencias 
                    (medida_disciplinar, tipo_ocorrencia, descricao_ocorrencia, pontos, ativo)
                 VALUES (?, ?, ?, ?, TRUE)`,
                [medidaDisciplinar, tipoOcorrencia, descricaoOcorrencia, pontos]
            );
            totalInseridos++;
        }

        await conn.commit();
        console.log(`\n✅ Seed concluído com sucesso!`);
        console.log(`📊 Total de registros inseridos: ${totalInseridos}`);

        // 4. Verificação final
        const [count] = await conn.query("SELECT COUNT(*) as total FROM registros_ocorrencias");
        console.log(`📊 Total de registros na tabela: ${count[0].total}`);

    } catch (error) {
        await conn.rollback();
        console.error("❌ Erro durante o seed:", error.message);
        throw error;
    } finally {
        conn.release();
        process.exit(0);
    }
}

main();
