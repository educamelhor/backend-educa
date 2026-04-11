import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env.development") });

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  timezone: '+00:00',
});

console.log("═══════════════════════════════════════════");
console.log("  LIMPEZA DO BANCO — Migração ieducar → educadf");
console.log("═══════════════════════════════════════════\n");

// ── DIAGNÓSTICO PRÉ-LIMPEZA ──
const [[pre1]] = await conn.query("SELECT COUNT(*) as c FROM alunos WHERE escola_id = 1");
const [[pre2]] = await conn.query("SELECT COUNT(*) as c FROM matriculas WHERE escola_id = 1");
const [[pre3]] = await conn.query(`
  SELECT COUNT(*) as c FROM alunos a 
  JOIN turmas t ON t.id = a.turma_id 
  WHERE a.escola_id = 1 AND t.ano = '2025'
`);
const [[pre4]] = await conn.query(`
  SELECT COUNT(*) as c FROM alunos 
  WHERE escola_id = 1 AND id >= 2307
`);
console.log("PRÉ-LIMPEZA:");
console.log(`  Total alunos: ${pre1.c}`);
console.log(`  Total matrículas: ${pre2.c}`);
console.log(`  Alunos em turmas 2025: ${pre3.c}`);
console.log(`  Alunos inseridos pelo import errado (id>=2307): ${pre4.c}`);

// ── 1. DELETAR MATRÍCULAS DOS ALUNOS INSERIDOS PELO IMPORT ERRADO ──
const [r1] = await conn.query(`
  DELETE FROM matriculas WHERE aluno_id IN (
    SELECT id FROM alunos WHERE id >= 2307 AND escola_id = 1
  )
`);
console.log(`\n[1/4] Matrículas do import errado deletadas: ${r1.affectedRows}`);

// ── 2. DELETAR ALUNOS INSERIDOS PELO IMPORT ERRADO ──
const [r2] = await conn.query(`
  DELETE FROM alunos WHERE id >= 2307 AND escola_id = 1
`);
console.log(`[2/4] Alunos do import errado deletados: ${r2.affectedRows}`);

// ── 3. DELETAR MATRÍCULAS DE 2025 ──
const [r3] = await conn.query(`
  DELETE FROM matriculas WHERE escola_id = 1 AND ano_letivo = 2025
`);
console.log(`[3/4] Matrículas 2025 deletadas: ${r3.affectedRows}`);

// ── 4. DELETAR ALUNOS DAS TURMAS DE 2025 ──
// Primeiro identificar IDs dos alunos vinculados SOMENTE a turmas 2025
// (alunos que têm turma_id apontando para turma 2025 E não têm matrícula 2026)
const [r4] = await conn.query(`
  DELETE a FROM alunos a
  JOIN turmas t ON t.id = a.turma_id
  WHERE a.escola_id = 1 AND t.ano = '2025'
  AND a.id NOT IN (
    SELECT aluno_id FROM matriculas WHERE escola_id = 1 AND ano_letivo = 2026
  )
`);
console.log(`[4/4] Alunos exclusivos de 2025 deletados: ${r4.affectedRows}`);

// ── GARANTIR que todos restantes estão ATIVOS ──
const [r5] = await conn.query(`
  UPDATE alunos SET status = 'ativo' WHERE escola_id = 1 AND status = 'inativo'
`);
const [r6] = await conn.query(`
  UPDATE matriculas SET status = 'ativo' WHERE escola_id = 1 AND ano_letivo = 2026 AND status = 'inativo'
`);
console.log(`\n[EXTRA] Alunos reativados: ${r5.affectedRows}`);
console.log(`[EXTRA] Matrículas reativadas: ${r6.affectedRows}`);

// ── VERIFICAÇÃO PÓS-LIMPEZA ──
const [[pos1]] = await conn.query("SELECT COUNT(*) as c FROM alunos WHERE escola_id = 1");
const [[pos2]] = await conn.query("SELECT COUNT(*) as c FROM matriculas WHERE escola_id = 1");
const [[pos3]] = await conn.query(`
  SELECT COUNT(*) as c FROM alunos a 
  JOIN turmas t ON t.id = a.turma_id 
  WHERE a.escola_id = 1 AND t.ano = '2025'
`);
const [[pos4]] = await conn.query(`
  SELECT a.status, COUNT(*) as c FROM alunos a
  WHERE a.escola_id = 1 GROUP BY a.status
`);

console.log("\n═══ PÓS-LIMPEZA ═══");
console.log(`  Total alunos: ${pos1.c} (era ${pre1.c})`);
console.log(`  Total matrículas: ${pos2.c} (era ${pre2.c})`);
console.log(`  Alunos 2025 restantes: ${pos3.c}`);
console.log("  Status alunos:");
pos4.forEach(r => console.log(`    ${r.status}: ${r.c}`));

// Verificar códigos duplicados
const [dups] = await conn.query(`
  SELECT codigo, COUNT(*) as cnt FROM alunos WHERE escola_id = 1 GROUP BY codigo HAVING cnt > 1
`);
console.log(`  Códigos duplicados: ${dups.length}`);

await conn.end();
console.log("\n✅ Limpeza concluída!");
