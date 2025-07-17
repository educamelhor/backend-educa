// api/controllers/questoesUploadController.js
import fs from "fs";
import path from "path";
import Tesseract from "tesseract.js";
import { parsePdfFile } from "../utils/pdfParser.js";




// Passo 7.3: Esqueleto da função de extração de texto via Tesseract.js
export const extrairTextoQuestao = async (req, res) => {
  try {
    // 1) Caminho do arquivo de imagem recebido no upload
    const imagemPath = req.file.path;

    // 1.1) Idioma: pode vir no body ou default para português
     const lang = req.body.lang || "por";




    // 2) Chamada real ao Tesseract.js para extrair texto em português
     const { data: { text } } = await Tesseract.recognize(imagemPath, lang, {
       logger: m => console.log(`Tesseract: ${m.status} ${(m.progress*100).toFixed(2)}%`)
     });
 



     // 3) Limpar quebras de linha e hífens residuais
     const cleanedText = text
       // junta palavras quebradas por hífen + quebra de linha
       .replace(/-\s*\n\s*/g, "")
       // reduz múltiplas quebras a duas quebras
       .replace(/\n{2,}/g, "\n\n")
       .trim();
 
     // 4) Deletar o arquivo temporário
     fs.unlink(imagemPath, err => {
       if (err) console.warn("Falha ao remover arquivo temporário:", err);
     });
 
     // 5) Retornar o texto limpo
     return res.json({ texto: cleanedText });





  } catch (error) {
    console.error('Erro na extração de texto:', error);
    return res.status(500).json({ error: 'Falha ao extrair texto da imagem' });
  }
};







/**
 * Passo 7.7 – Upload de PDF de questão e extração de texto
 */
export const uploadPdfQuestao = async (req, res) => {
  try {
    // 1) Caminho do PDF enviado
    const pdfPath = req.file.path;

    // 2) Extrair texto do PDF
    const textoPdf = await parsePdfFile(pdfPath);

    // 3) Remover arquivo temporário
    fs.unlink(pdfPath, err => {
      if (err) console.warn("Erro ao remover PDF temporário:", err);
    });

    // 4) Retornar texto extraído
    return res.json({ textoPdf: textoPdf.trim() });
  } catch (error) {
    console.error("Erro no uploadPdfQuestao:", error);
    return res.status(500).json({ error: "Falha ao processar PDF" });
  }
};









/**
 * uploadQuestao:
 *    1) Recebe o arquivo em req.file (já salvo em uploads/)
 *    2) Retorna um JSON com informação básica (nome do arquivo, caminho)
 *    3) (Futuramente) aqui chamaremos a rotina de IA para extrair texto
 */
export async function uploadQuestao(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Nenhum arquivo enviado." });
    }

    // Exemplo de dados básicos que podemos retornar:
    const { filename, mimetype, size, path: filePath } = req.file;

    // (Opcional) Se quiser apagar o arquivo depois de processar:
    // fs.unlinkSync(filePath);

    return res.status(200).json({
      message: "Upload recebido com sucesso.",
      arquivo: {
        nome: filename,
        tipo: mimetype,
        tamanho: size,
        caminho: filePath
      }
    });
  } catch (err) {
    console.error("Erro no upload de arquivo:", err);
    return res.status(500).json({ message: "Erro ao processar upload." });
  }
}
