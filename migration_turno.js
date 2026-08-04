import db from './db.js';

async function run() {
  console.log('\n=== PASSO 1: Migration — adicionar coluna turno ===');
  try {
    await db.query(`
      ALTER TABLE planos_avaliacao
        ADD COLUMN turno VARCHAR(30) NULL DEFAULT NULL
        AFTER turmas
    `);
    console.log('✅ Coluna turno adicionada com sucesso.');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('⚠️  Coluna turno já existia — ignorando migration.');
    } else {
      throw err;
    }
  }

  // Confirmar estrutura
  const [cols] = await db.query(`
    SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'planos_avaliacao'
      AND COLUMN_NAME = 'turno'
  `);
  console.table(cols);

  console.log('\n=== PASSO 2: Backfill — popular turno nos registros existentes ===');
  const [backfill] = await db.query(`
    UPDATE planos_avaliacao pa
    JOIN usuarios u ON u.id = pa.usuario_id
    JOIN professores p
      ON REPLACE(REPLACE(p.cpf,'.',''),'-','') = REPLACE(REPLACE(u.cpf,'.',''),'-','')
     AND p.escola_id = pa.escola_id
    JOIN modulacao mo ON mo.professor_id = p.id AND mo.escola_id = pa.escola_id
    JOIN turmas t ON t.id = mo.turma_id
      AND CONVERT(t.nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
        = CONVERT(pa.turmas USING utf8mb4) COLLATE utf8mb4_unicode_ci
      AND t.ano = pa.ano
    JOIN disciplinas d ON d.id = mo.disciplina_id
      AND CONVERT(d.nome USING utf8mb4) COLLATE utf8mb4_unicode_ci
        = CONVERT(pa.disciplina USING utf8mb4) COLLATE utf8mb4_unicode_ci
    SET pa.turno = t.turno
    WHERE pa.turno IS NULL
  `);
  console.log(`✅ Backfill executado: ${backfill.affectedRows} registros atualizados.`);

  // Verificar quantos ainda ficaram NULL
  const [[{ restantes_null }]] = await db.query(`
    SELECT COUNT(*) AS restantes_null FROM planos_avaliacao
    WHERE turno IS NULL
  `);
  console.log(`ℹ️  Registros com turno ainda NULL: ${restantes_null} (planos sem usuário ou modulação correspondente — backward compatible)`);

  // Mostrar distribuição de turnos
  const [dist] = await db.query(`
    SELECT turno, COUNT(*) as total FROM planos_avaliacao GROUP BY turno ORDER BY total DESC
  `);
  console.log('\n=== Distribuição de turnos após backfill ===');
  console.table(dist);

  process.exit();
}

run().catch(err => { console.error(err); process.exit(1); });
