import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config({ path: "C:/projetos/sistema_educacional/apps/educa-backend/.env" });

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "123456",
    database: process.env.DB_NAME || "educa_db",
  });
  
  const [rows] = await connection.query("SELECT * FROM governanca_itens");
  console.log(JSON.stringify(rows, null, 2));
  
  await connection.end();
}

run().catch(console.error);
