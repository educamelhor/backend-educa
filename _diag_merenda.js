// Script de diagnóstico — CEF04 / merenda
const mysql = require('mysql2/promise');
require('dotenv').config({ path: '.env' });

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
  });

  try {
    // 1. Encontrar escola CEF04-CCMDF
    const [escolas] = await db.query(
      "SELECT id, nome, apelido FROM escolas WHERE apelido LIKE '%CEF04%' OR nome LIKE '%CEF04%' LIMIT 5"
    );
    console.log('\n=== ESCOLAS ENCONTRADAS ===');
    console.log(JSON.stringify(escolas, null, 2));

    if (!escolas.length) { console.log('NENHUMA ESCOLA CEF04'); await db.end(); return; }

    const escolaId = escolas[0].id;
    console.log('\nUsando escola_id:', escolaId, '/', escolas[0].nome);

    // 2. Teto geral: escola_modulos
    const [ceiling] = await db.query(
      'SELECT modulo, ativo FROM escola_modulos WHERE escola_id = ? ORDER BY modulo',
      [escolaId]
    );
    const ceilingAtivos = ceiling.filter(r => Number(r.ativo) === 1).map(r => r.modulo);
    console.log('\n=== escola_modulos (teto geral) — ativos (' + ceilingAtivos.length + ') ===');
    console.log(ceilingAtivos.join(', '));

    // 3. Per-perfil: merenda
    const [merenda] = await db.query(
      "SELECT modulo, ativo FROM escola_perfil_modulos WHERE escola_id = ? AND perfil = 'merenda' ORDER BY modulo",
      [escolaId]
    );
    console.log('\n=== escola_perfil_modulos — merenda (' + merenda.length + ' registros) ===');
    merenda.forEach(r => console.log(`  ${r.modulo} = ${Number(r.ativo) === 1 ? 'ATIVO' : 'inativo'}`));

    // 4. Check: merenda na interseção com ceiling
    const ceilingSet = new Set(ceilingAtivos);
    const merendaAtivos = merenda.filter(r => Number(r.ativo) === 1).map(r => r.modulo);
    const merendaFiltrado = merendaAtivos.filter(m => ceilingSet.has(m));
    console.log('\n=== RESULTADO: merenda ativos no perfil ===', merendaAtivos);
    console.log('=== APÓS filtro ceoCeiling ===', merendaFiltrado);

    // 5. Usuário TALITA
    const [talita] = await db.query(
      "SELECT u.id, u.nome, u.perfil, u.escola_id FROM cadastro_membros_escola u WHERE u.escola_id = ? AND LOWER(u.perfil) = 'merenda' LIMIT 5",
      [escolaId]
    );
    console.log('\n=== USUÁRIOS com perfil merenda nessa escola ===');
    console.log(JSON.stringify(talita, null, 2));

    // 6. Se não encontrou, tentar outras tabelas
    if (!talita.length) {
      const [outros] = await db.query(
        "SELECT id, nome, perfil, escola_id FROM cadastro_membros_escola WHERE escola_id = ? LIMIT 10",
        [escolaId]
      );
      console.log('\n=== Todos membros dessa escola ===');
      console.log(JSON.stringify(outros, null, 2));
    }

  } finally {
    await db.end();
  }
})().catch(e => console.error('ERRO:', e.message, e.stack));
