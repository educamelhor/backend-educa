// utils/cryptoPdfHelper.js
// Criptografia AES-256-GCM em Repouso e Proteção de PDFs com Senha (LGPD - Sala de Recursos)
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import muhammara from 'muhammara';
import sharp from 'sharp';

// Chave mestra derivada do ambiente (32 bytes para AES-256)
const SECRET_SEED = process.env.AEE_DOC_ENCRYPTION_SECRET || process.env.JWT_SECRET || 'educa-melhor-aee-super-secret-key-32b-seedf-2026';
const MASTER_KEY = crypto.createHash('sha256').update(SECRET_SEED).digest();
const OWNER_PASSWORD = process.env.PDF_OWNER_MASTER_SECRET || 'EducaMelhor@MasterSec2026';

/**
 * Criptografa um Buffer com AES-256-GCM.
 * Formato empacotado: [ IV (12 bytes) | AuthTag (16 bytes) | Ciphertext ]
 */
export function encryptDocumentBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Descriptografa um Buffer criptografado com AES-256-GCM.
 */
export function decryptDocumentBuffer(packedBuffer) {
  if (!Buffer.isBuffer(packedBuffer)) {
    packedBuffer = Buffer.from(packedBuffer);
  }
  if (packedBuffer.length < 28) {
    throw new Error('Buffer criptografado inválido ou corrompido.');
  }
  const iv = packedBuffer.subarray(0, 12);
  const authTag = packedBuffer.subarray(12, 28);
  const ciphertext = packedBuffer.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Converte uma imagem (JPG, PNG, WEBP) em um documento PDF institucional A4
 */
export async function convertImageToPdfBuffer(imageBuffer, metadata = {}) {
  // Normaliza a imagem para PNG via sharp para compatibilidade total com PDFKit
  let cleanImageBuffer;
  try {
    cleanImageBuffer = await sharp(imageBuffer).rotate().png().toBuffer();
  } catch (err) {
    cleanImageBuffer = imageBuffer;
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        info: {
          Title: `Dossiê AEE - ${metadata.tipo_documento || 'Documento Médico'} - ${metadata.aluno_nome || 'Estudante'}`,
          Author: 'Sistema EDUCA.MELHOR — Sala de Recursos Multifuncionais',
          Subject: 'Laudo / Documento Comprobatório AEE',
          Keywords: 'AEE, Sala de Recursos, Laudo Médico, SEEDF, LGPD'
        }
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const PW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const L = doc.page.margins.left;

      // ── Cabeçalho Institucional ──
      doc.rect(L, doc.y, PW, 32).fill('#1e3a5f');
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff')
        .text('GOVERNO DO DISTRITO FEDERAL — SECRETARIA DE ESTADO DE EDUCAÇÃO', L, doc.y - 26, { width: PW, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fbbf24')
        .text('SALA DE RECURSOS MULTIFUNCIONAIS — DOSSIÊ DE DOCUMENTO MÉDICO / LAUDO (AEE)', L, doc.y + 2, { width: PW, align: 'center' });

      doc.y += 12;

      // ── Quadro de Identificação do Documento ──
      const boxTop = doc.y;
      doc.roundedRect(L, boxTop, PW, 85, 4).fillAndStroke('#f8fafc', '#cbd5e1');

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e3a5f').text('ESTUDANTE:', L + 10, boxTop + 8);
      doc.font('Helvetica').fontSize(8).fillColor('#0f172a').text(metadata.aluno_nome ? metadata.aluno_nome.toUpperCase() : 'NÃO INFORMADO', L + 80, boxTop + 8);

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e3a5f').text('TIPO DOCUMENTO:', L + 10, boxTop + 22);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#047857').text(metadata.tipo_documento || 'Laudo Médico', L + 110, boxTop + 22);

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e3a5f').text('CLASSIFICAÇÃO CID:', L + 320, boxTop + 22);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#b45309').text(metadata.cid || 'NÃO INFORMADO', L + 430, boxTop + 22);

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e3a5f').text('PROFISSIONAL / CRM:', L + 10, boxTop + 36);
      doc.font('Helvetica').fontSize(8).fillColor('#0f172a').text(`${metadata.medico_nome || '—'} (${metadata.medico_crm || 'CRM não informado'}) • ${metadata.medico_especialidade || 'Especialista'}`, L + 125, boxTop + 36);

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e3a5f').text('DATA DE EMISSÃO:', L + 10, boxTop + 50);
      doc.font('Helvetica').fontSize(8).fillColor('#0f172a').text(metadata.data_laudo || '—', L + 110, boxTop + 50);

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e3a5f').text('VALIDADE / REVISÃO:', L + 320, boxTop + 50);
      doc.font('Helvetica').fontSize(8).fillColor('#0f172a').text(metadata.data_validade || 'Indeterminada', L + 430, boxTop + 50);

      if (metadata.diagnostico) {
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#1e3a5f').text('DIAGNÓSTICO:', L + 10, boxTop + 64);
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#334155').text(metadata.diagnostico, L + 85, boxTop + 64, { width: PW - 95, lineBreak: false, ellipsis: true });
      }

      // ── Alerta LGPD ──
      doc.y = boxTop + 90;
      doc.rect(L, doc.y, PW, 16).fill('#fef2f2');
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#991b1b')
        .text('🔒 DOCUMENTO CONFIDENCIAL — PROTEGIDO PELA LEI GERAL DE PROTEÇÃO DE DADOS (LEI Nº 13.709/2018 - ART. 5º, II E ART. 14)', L, doc.y - 12, { width: PW, align: 'center' });

      doc.y += 10;

      // ── Imagem Digitalizada Anexada ──
      const availableH = doc.page.height - doc.y - doc.page.margins.bottom - 10;
      doc.image(cleanImageBuffer, L, doc.y, {
        fit: [PW, availableH],
        align: 'center',
        valign: 'center'
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Aplica proteção de senha (User Password) em um PDF existente em memória usando muhammara.
 */
export function protectPdfBufferWithPassword(pdfBuffer, userPassword) {
  if (!userPassword || typeof userPassword !== 'string' || !userPassword.trim()) {
    throw new Error('Senha do usuário é obrigatória para proteção do PDF.');
  }

  const rs = new muhammara.PDFRStreamForBuffer(pdfBuffer);
  const ws = new muhammara.PDFWStreamForBuffer();

  const writer = muhammara.createWriterToModify(rs, ws, {
    userPassword: String(userPassword).trim(),
    ownerPassword: OWNER_PASSWORD,
    userProtectionFlag: 4 // Permite impressão mas bloqueia edição desautorizada
  });

  writer.end();
  return ws.buffer;
}
