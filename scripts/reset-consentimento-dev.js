/**
 * Script DEV — Reset de consentimento LGPD para testes
 * Uso: node scripts/reset-consentimento-dev.js
 * Remove APENAS os registros do CPF especificado.
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const CPF = "80426069153"; // André Luiz Morais dos Santos

const db = await mysql.createConnection({
  host:     process.env.MYSQL_HOST,
  port:     Number(process.env.MYSQL_PORT) || 3306,
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: process.env.MYSQL_SSL_MODE === "REQUIRED" ? { rejectUnauthorized: false } : undefined,
});

console.log(`\n🔍 Buscando responsável CPF ${CPF}...`);

const [[resp]] = await db.query(
  "SELECT id, nome, cpf FROM responsaveis WHERE REPLACE(cpf, '.', '') = REPLACE(REPLACE(?, '-', ''), '.', '') OR cpf = ? LIMIT 1",
  [CPF, CPF]
);

if (!resp) {
  console.error("❌ Responsável não encontrado.");
  await db.end();
  process.exit(1);
}

console.log(`✅ Encontrado: [${resp.id}] ${resp.nome}`);

// 1. Busca vínculos + log IDs antes de apagar
const [vinculos] = await db.query(
  "SELECT aluno_id, consentimento_imagem, consentimento_log_id FROM responsaveis_alunos WHERE responsavel_id = ?",
  [resp.id]
);

console.log(`\n📋 Vínculos encontrados: ${vinculos.length}`);
vinculos.forEach(v =>
  console.log(`   aluno_id=${v.aluno_id} | consentimento=${v.consentimento_imagem} | log_id=${v.consentimento_log_id}`)
);

const logIds = vinculos.map(v => v.consentimento_log_id).filter(Boolean);

// 2. Reseta flags em responsaveis_alunos
const [upd] = await db.query(
  `UPDATE responsaveis_alunos
   SET consentimento_imagem       = 0,
       consentimento_imagem_em    = NULL,
       consentimento_imagem_por   = NULL,
       consentimento_canal        = NULL,
       consentimento_versao_termo = NULL,
       consentimento_log_id       = NULL
   WHERE responsavel_id = ?`,
  [resp.id]
);
console.log(`\n✅ responsaveis_alunos resetado: ${upd.affectedRows} linha(s).`);

// 3. Remove entradas do audit log
if (logIds.length > 0) {
  const [del] = await db.query(
    `DELETE FROM consentimentos_log WHERE responsavel_id = ?`,
    [resp.id]
  );
  console.log(`✅ consentimentos_log removido: ${del.affectedRows} registro(s).`);
} else {
  console.log("ℹ️  Nenhum log de auditoria para remover.");
}

// 4. Verifica estado final
const [final] = await db.query(
  "SELECT aluno_id, consentimento_imagem, consentimento_canal FROM responsaveis_alunos WHERE responsavel_id = ?",
  [resp.id]
);
console.log("\n📊 Estado final:");
final.forEach(v =>
  console.log(`   aluno_id=${v.aluno_id} | consentimento=${v.consentimento_imagem} | canal=${v.consentimento_canal}`)
);

console.log("\n🎯 Reset concluído! O responsável será redirecionado ao Gate de Consentimento no próximo login.\n");

await db.end();
