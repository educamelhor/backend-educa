import pool from './db.js';
pool.query("SELECT chave, descricao, tipo, opcoes_json FROM governanca_itens WHERE chave LIKE '%plano%' OR chave LIKE '%avaliacao%' OR chave LIKE '%conteudo%'").then(([r]) => { console.log(r); pool.end(); });
