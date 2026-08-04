const pool = require('./db');
pool.query(`SELECT to_regclass('public.agenda_pedagogica');`)
  .then(res => {
    console.log(res.rows[0]);
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
