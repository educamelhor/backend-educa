// teste-embeddings.js
import fetch from "node-fetch";

const BASE = "http://localhost:3000/api/monitoramento/embeddings";
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c3VhcmlvSWQiOjMsImVzY29sYV9pZCI6MSwibm9tZV9lc2NvbGEiOiJDRUYwNCAtIENDTURGIiwicGVyZmlsIjoiYWRtaW4iLCJpYXQiOjE3NjIyNTIxOTYsImV4cCI6MTc2MjI1NTc5Nn0.8bJhPhONTjxOoCouEx6TUSdEF1VHcEedGSDfPFk7aA4";

async function testar() {
  for (const rota of ["ping", "cache"]) {
    const res = await fetch(`${BASE}/${rota}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await res.json();
    console.log(`🔹 ${rota} →`, res.status, json);
  }
}

testar().catch(console.error);
