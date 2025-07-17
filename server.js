// api/server.js

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import horariosRoutes from "./routes/horarios.js";
import ocrRouter from "./routes/ocr.js";
import redacoesRouter from "./routes/redacoes.js";
import correcoesOpenAI from "./routes/correcoes_openai.js";
import gabaritosRoutes from "./routes/gabaritos.js";



// ────────────────────────────────────────────────────────────────
// Import dos routers de cada módulo (CRUD + upload, quando houver)
// ────────────────────────────────────────────────────────────────
import alunosRouter from "./routes/alunos.js";               // inclui POST /:id/foto
import professoresRouter from "./routes/professores.js";     // inclui POST /:id/foto (se ativado)
import disciplinasRouter from "./routes/disciplinas.js";
import turmasRouter from "./routes/turmas.js";
import questoesRouter from "./routes/questoes.js";            // CRUD de questões
import questoesUploadRouter from "./routes/questoesUpload.js"; // POST /upload para questões
import escolasRouter from "./routes/escolas.js";


// ────────────────────────────────────────────────────────────────
// Para usar __dirname em ES module:
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ────────────────────────────────────────────────────────────────

const app = express();

// ────────────────────────────────────────────────────────────────
// 1) Middlewares de parsing (JSON) e CORS
// ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors());
app.use(bodyParser.json());

/*
  2) Expor a pasta “uploads/” como estática para que qualquer arquivo dentro dela
     (ex: /uploads/alunos/123.jpg, /uploads/professores/45.jpg, /uploads/questoes/xyz.png)
     possa ser acessado via URL: http://localhost:3000/uploads/...
*/
app.use("/uploads", express.static(join(__dirname, "uploads")));

// ──────────────────────────────────────────────────────────────────
// 3) Montar as rotas de cada módulo (CRUD + upload, quando existir)
// ──────────────────────────────────────────────────────────────────

// Módulo “Gestão de Alunos”
// - Dentro de alunosRouter (./routes/alunos.js) já existem todos os endpoints:
//   GET /api/alunos
//   GET /api/alunos/:id
//   POST /api/alunos
//   PUT /api/alunos/:id
//   DELETE /api/alunos/:id
//   e também POST /api/alunos/:id/foto (mulherar foto em uploads/alunos/<id>.jpg)
app.use("/api/alunos", alunosRouter);

// Módulo “Gestão de Professores”
// - Dentro de professoresRouter (./routes/professores.js) já existem:
//   GET /api/professores
//   GET /api/professores/:id
//   POST /api/professores
//   PUT /api/professores/:id
//   DELETE /api/professores/:id
//   e, se você habilitou, POST /api/professores/:id/foto (upload em uploads/professores/<id>.jpg)
app.use("/api/professores", professoresRouter);

// Módulo “Gestão de Disciplinas” (“disciplinas.js”) – sem upload, apenas CRUD
app.use("/api/disciplinas", disciplinasRouter);

// Módulo “Gestão de Turmas” (“turmas.js”) – sem upload, apenas CRUD
app.use("/api/turmas", turmasRouter);



// Módulo Pedagogico - Horários
app.use("/api/horarios", horariosRoutes);

// Módulo “Gestão de Questões”
// - Dentro de questoesRouter (./routes/questoes.js) estão:
//   GET /api/questoes
//   GET /api/questoes/:id
//   POST /api/questoes
//   PUT /api/questoes/:id
//   DELETE /api/questoes/:id
app.use("/api/questoes", questoesRouter);

// Módulo “Upload de Questões” (OCR / imagem / áudio)
// - A rota definida em “questoesUpload.js” é POST "/upload", então, com prefixo "/api/questoes", 
//   o endpoint completo fica: POST http://localhost:3000/api/questoes/upload
app.use("/api/questoes", questoesUploadRouter);


app.use("/api/escolas", escolasRouter);

// OCR Azure
app.use("/api/ocr", ocrRouter);

app.use("/api/redacoes", redacoesRouter);

app.use("/api/correcoes_openai", correcoesOpenAI);

app.use("/api/gabaritos", gabaritosRoutes);


// ──────────────────────────────────────────────────────────────────
// 4) Middleware genérico para rota não encontrada
// ──────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: "Rota não encontrada." });
});

// ──────────────────────────────────────────────────────────────────
// 5) Iniciando o servidor
// ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
});
