import pool from './db.js';
pool.query("SELECT id, nome, cpf FROM responsaveis WHERE cpf = '00000000019'").then(r => { console.log(r[0]); process.exit(0); });
