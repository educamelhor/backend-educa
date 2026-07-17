// api/routes/questoesUpload.js

import express from "express";

import { uploadQuestao, extrairTextoQuestao, uploadPdfQuestao } from "../controllers/questoesUploadController.js";

import multer from "multer";
import path from "path";
import fs from "fs";








// 1) Defina o caminho absoluto para a subpasta "uploads/questoes"
const uploadDir = path.resolve("uploads", "questoes");

// 2) Caso a pasta não exista, crie-a (com recursive: true para criar toda a árvore)
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 3) Configuração básica do multer
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    // Adiciona timestamp para evitar conflito de nomes
    const nomeFinal = `${Date.now()}_${file.originalname}`;
    cb(null, nomeFinal);
  }
});

// 4) Função fileFilter corrigida (arrow function com =>)
const fileFilter = (_req, file, cb) => {
  // Aceita apenas imagens (jpeg, png) e áudios (mpeg/mp3, wav)
  const tiposPermitidos = ["image/jpeg", "image/png", "audio/mpeg", "audio/wav"];
  if (tiposPermitidos.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Tipo de arquivo não suportado."), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // limite de 5MB
});

const router = express.Router();

// Definição da rota: POST /api/questoes/upload
router.post("/upload", upload.single("file"), uploadQuestao);




// Teste de OCR: POST /api/questoes/extrair
router.post(
  "/extrair",
  upload.single("file"),
  extrairTextoQuestao
);





// POST /api/questoes/upload-pdf — faz parsing de PDF
  router.post(
    "/upload-pdf",
    upload.single("file"),
    uploadPdfQuestao
  );






export default router;
