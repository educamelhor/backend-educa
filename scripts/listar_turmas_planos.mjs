/**
 * PASSO 1 — DIAGNÓSTICO: Lista turmas e planos de avaliação atuais
 * Executar ANTES de renomear para confirmar o estado atual.
 * NÃO faz nenhuma alteração no banco.
 *
 * node --env-file=.env.development scripts/listar_turmas_planos.mjs
 */
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env.development") });

const pool = await mysql.createPool({
  host           : process.env.MYSQL_HOST,
  port           : Number(process.env.MYSQL_PORT || 25060),
  user           : process.env.MYSQL_USER,
  password       : process.env.MYSQL_PASSWORD,
  database       : process.env.MYSQL_DATABASE,
  ssl            : { ca: fs.readFileSync(path.join(__dirname, "../certs/do-mysql-ca.crt")) },
  connectionLimit: 2,
});

// ── 1. Todas as turmas (todas as escolas, ano 2026) ───────────────────────────
console.log("\n════════════════════════════════════════");
console.log(" TURMAS cadastradas (ano 2026)");
console.log("════════════════════════════════════════");
const [turmas] = await pool.query(`
  SELECT id, escola_id, nome, turno, serie, ano
  FROM turmas
  WHERE ano = '2026'
  ORDER BY escola_id, nome
`);
console.table(turmas);

// ── 2. Planos de avaliação (coluna turmas — texto) ────────────────────────────
console.log("\n════════════════════════════════════════");
console.log(" PLANOS DE AVALIAÇÃO — campo 'turmas' (texto)");
console.log("════════════════════════════════════════");
const [planos] = await pool.query(`
  SELECT id, escola_id, turmas AS turma_nome_texto, disciplina, bimestre, status
  FROM planos_avaliacao
  ORDER BY escola_id, turmas
`);
console.table(planos);

// ── 3. Planos ÓRFÃOS (turma não bate com nenhuma turma cadastrada) ─────────
console.log("\n════════════════════════════════════════");
console.log(" PLANOS ÓRFÃOS (turma_nome_texto não encontrado na tabela turmas)");
console.log("════════════════════════════════════════");
const [orfaos] = await pool.query(`
  SELECT pa.id, pa.escola_id, pa.turmas AS turma_no_plano, pa.disciplina, pa.status
  FROM planos_avaliacao pa
  LEFT JOIN turmas t ON t.nome = pa.turmas AND t.escola_id = pa.escola_id
  WHERE t.id IS NULL
  ORDER BY pa.escola_id, pa.turmas
`);
if (orfaos.length === 0) {
  console.log("✅ Nenhum plano órfão — todos os planos têm turma correspondente.");
} else {
  console.warn(`⚠️  ${orfaos.length} plano(s) com turma NÃO encontrada:`);
  console.table(orfaos);
}

await pool.end();
console.log("\n[DIAGNÓSTICO CONCLUÍDO]");
