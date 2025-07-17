import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: "educamelhor2025.com.br",
  user: "cef4co09_educa_user",
  password: "EducaMelhor@2025",
  database: "cef4co09_educamelhor_db",
});

export default pool;