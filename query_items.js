import pool from './db.js';
pool.query("SELECT * FROM governanca_itens WHERE categoria_id = 9").then(([r]) => { console.log(r); pool.end(); });
