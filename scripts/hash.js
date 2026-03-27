// scripts/hash.js
import bcrypt from "bcryptjs";

const senha = process.argv[2];

if (!senha) {
  console.log("Uso: node scripts/hash.js SUA_SENHA");
  process.exit(1);
}

const hash = await bcrypt.hash(String(senha), 10);
console.log(hash);
