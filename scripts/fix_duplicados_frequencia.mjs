// scripts/fix_duplicados_frequencia.mjs
// ============================================================================
// Remove lançamentos DUPLICADOS das tabelas de Frequência:
//   - frequencia_busca_ativa        → duplicata: mesmo aluno + mesma data + mesmo meio + mesmo resultado
//   - frequencia_justificativas     → duplicata: mesmo aluno + mesmo tipo + mesmo período (já protegido via UNIQUE no POST)
//
// Critério: mantém o registro com o MENOR id (o mais antigo), remove os demais.
// Uso: node scripts/fix_duplicados_frequencia.mjs
// ============================================================================

import dotenv from "dotenv";
import { createPool } from "mysql2/promise";

dotenv.config();

const pool = createPool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT || 3306),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const conn = await pool.getConnection();

  try {
    console.log("🔍 Verificando duplicatas em frequencia_busca_ativa...\n");

    // ── 1. BUSCA ATIVA ──────────────────────────────────────────────────────
    // Encontrar grupos duplicados: mesmo escola_id + aluno_id + data_contato + meio_contato + resultado
    const [duplicasBuscaAtiva] = await conn.query(`
      SELECT
        escola_id,
        aluno_id,
        DATE(data_contato) AS data_contato,
        meio_contato,
        resultado,
        COUNT(*) AS total,
        MIN(id) AS id_manter,
        GROUP_CONCAT(id ORDER BY id ASC) AS ids
      FROM frequencia_busca_ativa
      GROUP BY escola_id, aluno_id, DATE(data_contato), meio_contato, resultado
      HAVING COUNT(*) > 1
      ORDER BY total DESC
    `);

    if (duplicasBuscaAtiva.length === 0) {
      console.log("  ✅ Nenhuma duplicata encontrada em frequencia_busca_ativa.\n");
    } else {
      console.log(`  ⚠️  Encontrados ${duplicasBuscaAtiva.length} grupos com duplicatas:\n`);

      let totalRemovidosBuscaAtiva = 0;

      for (const grupo of duplicasBuscaAtiva) {
        const ids = grupo.ids.split(",").map(Number);
        const idsRemover = ids.filter(id => id !== grupo.id_manter);

        console.log(`    Aluno ID ${grupo.aluno_id} | ${grupo.data_contato} | ${grupo.meio_contato} | ${grupo.resultado}`);
        console.log(`      → Mantendo ID ${grupo.id_manter}, removendo IDs: [${idsRemover.join(", ")}]`);

        const [res] = await conn.query(
          `DELETE FROM frequencia_busca_ativa WHERE id IN (?)`,
          [idsRemover]
        );
        totalRemovidosBuscaAtiva += res.affectedRows;
      }

      console.log(`\n  🗑️  Total removido: ${totalRemovidosBuscaAtiva} registros de frequencia_busca_ativa.\n`);
    }

    // ── 2. JUSTIFICATIVAS ───────────────────────────────────────────────────
    console.log("🔍 Verificando duplicatas em frequencia_justificativas...\n");

    const [duplicasJustificativas] = await conn.query(`
      SELECT
        escola_id,
        aluno_id,
        tipo,
        data_inicio,
        data_fim,
        COUNT(*) AS total,
        MIN(id) AS id_manter,
        GROUP_CONCAT(id ORDER BY id ASC) AS ids
      FROM frequencia_justificativas
      GROUP BY escola_id, aluno_id, tipo, data_inicio, data_fim
      HAVING COUNT(*) > 1
      ORDER BY total DESC
    `);

    if (duplicasJustificativas.length === 0) {
      console.log("  ✅ Nenhuma duplicata encontrada em frequencia_justificativas.\n");
    } else {
      console.log(`  ⚠️  Encontrados ${duplicasJustificativas.length} grupos com duplicatas:\n`);

      let totalRemovidosJustificativas = 0;

      for (const grupo of duplicasJustificativas) {
        const ids = grupo.ids.split(",").map(Number);
        const idsRemover = ids.filter(id => id !== grupo.id_manter);

        console.log(`    Aluno ID ${grupo.aluno_id} | ${grupo.tipo} | ${grupo.data_inicio} → ${grupo.data_fim}`);
        console.log(`      → Mantendo ID ${grupo.id_manter}, removendo IDs: [${idsRemover.join(", ")}]`);

        const [res] = await conn.query(
          `DELETE FROM frequencia_justificativas WHERE id IN (?)`,
          [idsRemover]
        );
        totalRemovidosJustificativas += res.affectedRows;
      }

      console.log(`\n  🗑️  Total removido: ${totalRemovidosJustificativas} registros de frequencia_justificativas.\n`);
    }

    // ── 3. CONTAGEM FINAL ───────────────────────────────────────────────────
    const [[{ total_ba }]] = await conn.query("SELECT COUNT(*) AS total_ba FROM frequencia_busca_ativa");
    const [[{ total_jst }]] = await conn.query("SELECT COUNT(*) AS total_jst FROM frequencia_justificativas");

    console.log("📊 Totais finais:");
    console.log(`   frequencia_busca_ativa:    ${total_ba} registros`);
    console.log(`   frequencia_justificativas: ${total_jst} registros`);
    console.log("\n✅ Limpeza concluída com sucesso!");

  } catch (err) {
    console.error("\n❌ Erro durante a limpeza:", err.message);
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
