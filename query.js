import pool from './db.js';
pool.query(`SELECT * FROM conteudos_objetivos_escola LIMIT 10`)
  .then(r => { console.log(r[0]); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
