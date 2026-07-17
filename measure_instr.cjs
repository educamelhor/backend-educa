const PDFDocument = require('pdfkit');
const doc = new PDFDocument({ size: 'A4', margin: 0 });

const instrucoes = [
  "1. Este CADERNO DE QUESTOES contem 25 questoes numeradas de 01 a 25 dispostas da seguinte maneira:\na) questoes de numero 01 a 12, relativas a area de Historia e suas Tecnologias.\nb) questoes de numero 13 a 25, relativas a area de Geografia e suas Tecnologias.",
  "2. Confira se a quantidade e a ordem das questoes do seu CADERNO DE QUESTOES estao de acordo com as instrucoes anteriores. Caso o caderno esteja incompleto, tenha defeito ou apresente qualquer divergencia, comunique ao aplicador da sala.",
  "3. Para cada uma das questoes objetivas, sao apresentadas 4 opcoes. Apenas uma responde corretamente a questao.",
  "4. O tempo disponivel para estas provas e de 3h00. Reserve tempo suficiente para preencher o CARTAO-RESPOSTA.",
  "5. Os rascunhos e as marcacoes assinaladas no CADERNO DE QUESTOES e no RASCUNHO (se houver) nao serao considerados na avaliacao.",
  "6. Proibido porte e uso de qualquer tipo de aparelho eletronico ou digital (celular, fone, smartwatch, etc.)",
  "7. Voce podera deixar o local de prova somente apos decorrido 1h00 de prova."
].join('\n\n');

// Template 2 (Moderno): A4W=595, STRIPE=62, MARGIN=28
const A4W = 595;
const STRIPE = 62;
const MARGIN = 28;
const instrW = A4W - STRIPE - MARGIN - 20; // 485pt

doc.font('Helvetica').fontSize(8.8);
const h = doc.heightOf(instrucoes, { width: instrW, lineGap: 0.5, paragraphGap: 2 });

// T2 layout: instrSepY = titleY + 128, titleY = sepY2 + 10, sepY2 = HEADER_H_M + 4 + 4 = 103
// instrStartY = instrSepY + 26
const HEADER_H_M = 95;
const sepY2 = HEADER_H_M + 8; // 103
const titleY = sepY2 + 10;    // 113
const instrSepY = titleY + 128; // 241
const instrStartY = instrSepY + 26; // 267
const imageStartY = instrStartY + h + 10;
const instrTextEnd = instrStartY + h;

console.log('=== Template 2 (Moderno) ===');
console.log('instrW:', instrW, 'pt');
console.log('instrTextH:', h.toFixed(2), 'pt');
console.log('instrStartY:', instrStartY, 'pt');
console.log('instrTextEnd:', instrTextEnd.toFixed(2), 'pt ->', Math.ceil(instrTextEnd * 2), 'canvas px');
console.log('imageStartY:', imageStartY.toFixed(2), 'pt ->', Math.ceil(imageStartY * 2), 'canvas px');

// Now check all templates
// T1 Classico
const instrW1 = A4W - MARGIN * 2 - 32; // 507
const h1 = doc.heightOf(instrucoes, { width: instrW1, lineGap: 0.5, paragraphGap: 2 });
const instrY1 = 273; // approximate: afterHeader~135, titleY~141, instrY=titleY+132
const imageStart1 = instrY1 + (h1 + 38) + 6;
console.log('\n=== Template 1 (Classico) ===');
console.log('instrW:', instrW1, 'pt, instrTextH:', h1.toFixed(2), 'pt');
console.log('instrTextEnd canvas px:', Math.ceil((instrY1 + h1) * 2));
console.log('imageStartY:', imageStart1.toFixed(2), 'pt ->', Math.ceil(imageStart1 * 2), 'canvas px');

// T3 Formal
const instrW3 = A4W - 70; // 525
const h3 = doc.heightOf(instrucoes, { width: instrW3, lineGap: 0.5, paragraphGap: 2 });
const instrBaseY3 = 278; // bandBottom+128 approx
const instrStartY3 = instrBaseY3 + 28;
const imageStart3 = instrStartY3 + h3 + 8;
console.log('\n=== Template 3 (Formal) ===');
console.log('instrW:', instrW3, 'pt, instrTextH:', h3.toFixed(2), 'pt');
console.log('instrTextEnd canvas px:', Math.ceil((instrStartY3 + h3) * 2));
console.log('imageStartY:', imageStart3.toFixed(2), 'pt ->', Math.ceil(imageStart3 * 2), 'canvas px');

// T4 Colorido
const instrW4 = A4W - MARGIN * 2 - 24; // 515
const h4 = doc.heightOf(instrucoes, { width: instrW4, lineGap: 0.5, paragraphGap: 2 });
const instrTop4 = 268; // approximate
const instrStartY4 = instrTop4 + 28;
const imageStart4 = instrTop4 + (h4 + 36) + 8;
console.log('\n=== Template 4 (Colorido) ===');
console.log('instrW:', instrW4, 'pt, instrTextH:', h4.toFixed(2), 'pt');
console.log('instrTextEnd canvas px:', Math.ceil((instrStartY4 + h4) * 2));
console.log('imageStartY:', imageStart4.toFixed(2), 'pt ->', Math.ceil(imageStart4 * 2), 'canvas px');

// T5 Dark
const instrW5 = A4W - MARGIN * 2 - 24; // 515
const h5 = doc.heightOf(instrucoes, { width: instrW5, lineGap: 0.5, paragraphGap: 2 });
const instrTop5 = 235; // approximate
const instrStartY5 = instrTop5 + 28;
const imageStart5 = instrTop5 + (h5 + 36) + 8;
console.log('\n=== Template 5 (Dark) ===');
console.log('instrW:', instrW5, 'pt, instrTextH:', h5.toFixed(2), 'pt');
console.log('instrTextEnd canvas px:', Math.ceil((instrStartY5 + h5) * 2));
console.log('imageStartY:', imageStart5.toFixed(2), 'pt ->', Math.ceil(imageStart5 * 2), 'canvas px');
