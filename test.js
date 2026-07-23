import pool from './db.js';

async function test() {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM gabarito_respostas WHERE codigo_aluno = '249679' OR nome_aluno LIKE '%EMILLY RODRIGUES%'`
    );
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
test();
