import multer from "multer";
import path from "path";
import fs from "fs";

// Cria a pasta uploads/professores se não existir
const pastaDestino = path.resolve("uploads/professores");
if (!fs.existsSync(pastaDestino)) {
  fs.mkdirSync(pastaDestino, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, pastaDestino);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const nome = path.basename(file.originalname, ext);
    const nomeArquivo = `${nome}-${Date.now()}${ext}`;
    cb(null, nomeArquivo);
  }
});

const upload = multer({ storage });

export default upload;
