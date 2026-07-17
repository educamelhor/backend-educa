// test-db.js
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
    });

    const [rows] = await conn.query("SELECT NOW() AS data_atual");
    console.log("✅ Conexão OK! Data no servidor:", rows[0].data_atual);

    await conn.end();
  } catch (err) {
    console.error("❌ Falha na conexão:", err.message);
  }
})();
