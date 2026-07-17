import pool from './db.js';
pool.query("SELECT id, nome FROM governanca_categorias").then(([r]) => { console.log(r); pool.end(); });
