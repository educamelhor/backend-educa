// routes/monitoramento.js
// ============================================================================
// ROTAS DO MÓDULO DE MONITORAMENTO (CÂMERAS IP)
// Nesta fase inicial, devolvemos apenas imagens placeholder simulando
// o "frame atual" de cada câmera instalada.
// ============================================================================

import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const router = express.Router();

// ============================================================================
// CONFIGURAÇÃO DE CAMINHOS
// ============================================================================
// __dirname não existe nativamente em ES Modules, então calculamos manualmente.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pasta onde estão armazenadas as imagens das câmeras simuladas.
// Estrutura esperada (real no seu projeto):
//   educa-backend/
//     routes/monitoramento.js   (este arquivo)
//     uploads/monitoramento/camera1.jpg
//                              camera2.jpg
//                              camera3.jpg
//
// OBS: Como este arquivo está em /routes e as imagens estão em /uploads,
// precisamos subir um nível com ".."
const BASE_FOLDER = path.join(__dirname, "..", "uploads", "monitoramento");

// ============================================================================
// ROTA DE TESTE (diagnóstico rápido)
// GET /api/monitoramento/teste
// ============================================================================
// Esta rota é útil para verificar se o módulo está operacional e sem bloqueio
// de autenticação (usada em fases de validação e integração com o frontend).
// ============================================================================
router.get("/teste", (req, res) => {
  console.log("[monitoramento] ROTA /teste chamada com sucesso");
  return res.json({
    ok: true,
    message: "Rota de monitoramento ativa e funcional.",
  });
});

// ============================================================================
// ROTA PRINCIPAL: FRAME DE CADA CÂMERA
// GET /api/monitoramento/camera/:id/frame
// ============================================================================
// Retorna uma imagem (frame atual da câmera) baseada no ID solicitado.
// IDs válidos nesta fase inicial: 1, 2 ou 3
// ============================================================================
router.get("/camera/:id/frame", (req, res) => {
  const { id } = req.params;

  console.log(`[monitoramento] GET /camera/${id}/frame`);

  // Segurança básica: aceitar apenas 1, 2 ou 3
  if (!["1", "2", "3"].includes(id)) {
    console.warn(`[monitoramento] Câmera inválida (${id})`);
    return res.status(400).json({
      ok: false,
      message: "Câmera inválida. Use 1, 2 ou 3.",
    });
  }

  // Monta o caminho do arquivo
  const fileName = `camera${id}.jpg`;
  const filePath = path.join(BASE_FOLDER, fileName);

  console.log(`[monitoramento] Tentando ler arquivo: ${filePath}`);

  // Verifica se o arquivo existe
  if (!fs.existsSync(filePath)) {
    console.warn(`[monitoramento] Arquivo não encontrado: ${filePath}`);
    return res.status(404).json({
      ok: false,
      message: `Frame não encontrado para câmera ${id}`,
    });
  }

  // Define tipo do conteúdo (image/jpeg)
  res.setHeader("Content-Type", "image/jpeg");

  // Stream da imagem
  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    console.error("[monitoramento] Erro ao ler imagem:", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao carregar frame da câmera.",
    });
  });

  // Envia o stream para o cliente
  stream.pipe(res);
});

// ============================================================================
// EXPORTAÇÃO DO ROUTER
// ============================================================================
export default router;
