import fs from "fs";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/**
 * Lê um PDF do disco e retorna o texto extraído.
 * @param {string} filePath - Caminho completo para o PDF a ser parseado.
 * @returns {Promise<string>} Texto extraído do PDF.
 */
export const parsePdfFile = async (filePath) => {
  // 1) Ler buffer do arquivo
  const dataBuffer = fs.readFileSync(filePath);

  // 2) Executar o parsing
  const { text } = await pdfParse(dataBuffer);

  // 3) Retornar apenas o texto (você pode normalizar linhas aqui, se quiser)
  return text;
};
