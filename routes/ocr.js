import express from "express";
import multer from "multer";
import axios from "axios";
import * as dotenv from "dotenv";
import sharp from "sharp"; // NOVO!
dotenv.config();

const router = express.Router();
const upload = multer(); // arquivos em memória

// Middleware para garantir que a escola esteja definida
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ error: "Acesso negado: escola não definida." });
  }
  next();
}

// Util para pegar URL do .env corretamente
const AZURE_CV_ENDPOINT = process.env.AZURE_CV_ENDPOINT?.replace(/\/+$/, ""); // tira / do final se houver
const AZURE_CV_KEY = process.env.AZURE_CV_KEY;

// 1) OCR simples: só texto puro (com CROP do cabeçalho para imagens!)
router.post("/azure-text", verificarEscola, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo não enviado." });

  console.log("Tamanho do arquivo recebido:", req.file.size, req.file.mimetype);

  // === CROP AUTOMÁTICO DO CABEÇALHO ===
  let imgBuffer = req.file.buffer;
  if (req.file.mimetype && req.file.mimetype.startsWith("image/")) {
    try {
      const meta = await sharp(imgBuffer).metadata();
      const cropHeight = Math.round(meta.height * 0.30); // 30% do topo
      imgBuffer = await sharp(imgBuffer)
        .extract({ left: 0, top: 0, width: meta.width, height: cropHeight })
        .toBuffer();
      console.log(`Crop do cabeçalho aplicado: ${meta.width}x${cropHeight} pixels`);
    } catch (err) {
      console.error("Erro ao fazer crop do cabeçalho:", err);
      // fallback: usa o buffer original
    }
  }

  try {
    const { data } = await axios.post(
      `${AZURE_CV_ENDPOINT}/vision/v3.2/ocr?language=pt&detectOrientation=true`,
      imgBuffer,
      {
        headers: {
          "Ocp-Apim-Subscription-Key": AZURE_CV_KEY,
          "Content-Type": req.file.mimetype,
        },
      }
    );

    const lines = [];
    if (data.regions) {
      for (const region of data.regions) {
        for (const line of region.lines) {
          const textLine = line.words.map(w => w.text).join(" ");
          lines.push(textLine);
        }
      }
    }
    res.json({ text: lines.join("\n") });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: "Erro no OCR Azure.", detail: err?.response?.data || err.message });
  }
});

// 2) OCR estruturado: texto + posição + palavras
router.post("/azure-struct", verificarEscola, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo não enviado." });

  try {
    const resp = await axios.post(
      `${AZURE_CV_ENDPOINT}/vision/v3.2/read/analyze`,
      req.file.buffer,
      {
        headers: {
          "Ocp-Apim-Subscription-Key": AZURE_CV_KEY,
          "Content-Type": req.file.mimetype,
        },
      }
    );
    const operationLocation = resp.headers["operation-location"];
    if (!operationLocation) throw new Error("operation-location não encontrado.");

    let resultado;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const { data } = await axios.get(operationLocation, {
        headers: { "Ocp-Apim-Subscription-Key": AZURE_CV_KEY },
      });
      if (data.status === "succeeded") {
        resultado = data;
        break;
      }
      if (data.status === "failed") throw new Error("OCR Azure falhou.");
    }
    if (!resultado) throw new Error("Timeout esperando resultado do OCR Azure.");

    const analysis = resultado.analyzeResult;
    const linhas = [];
    for (const page of analysis?.readResults || []) {
      for (const line of page.lines) {
        linhas.push({
          text: line.text,
          boundingBox: line.boundingBox,
          words: line.words.map(w => ({
            text: w.text,
            boundingBox: w.boundingBox,
            confidence: w.confidence
          }))
        });
      }
    }
    res.json({
      lines: linhas,
      fullText: linhas.map(l => l.text).join("\n")
    });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: "Erro no OCR Azure.", detail: err?.response?.data || err.message });
  }
});

export default router;
