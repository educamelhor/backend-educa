// modules/agente/agente.crypt.js
// ============================================================================
// COFRE DE CREDENCIAIS — AES-256-GCM
// ============================================================================
// Responsável por criptografar/descriptografar senhas de professores.
// A chave master (AGENTE_MASTER_KEY) NUNCA é armazenada no banco.
// ============================================================================

import crypto from 'crypto';

// ============================================================================
// CONFIGURAÇÃO
// ============================================================================
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;   // 128 bits
const TAG_LENGTH = 16;  // 128 bits
const KEY_LENGTH = 32;  // 256 bits

/**
 * Obtém a chave master do ambiente.
 * @returns {Buffer} Chave de 32 bytes
 * @throws {Error} Se a chave não estiver configurada ou for inválida
 */
function getMasterKey() {
  const keyHex = process.env.AGENTE_MASTER_KEY;

  if (!keyHex) {
    throw new Error(
      '[agente.crypt] AGENTE_MASTER_KEY não está definida. ' +
      'Configure a variável de ambiente com 64 caracteres hexadecimais (256 bits).'
    );
  }

  const key = Buffer.from(keyHex, 'hex');

  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `[agente.crypt] AGENTE_MASTER_KEY inválida. ` +
      `Esperado: ${KEY_LENGTH * 2} hex chars (${KEY_LENGTH} bytes). ` +
      `Recebido: ${keyHex.length} hex chars (${key.length} bytes).`
    );
  }

  return key;
}

// ============================================================================
// CRIPTOGRAFIA
// ============================================================================

/**
 * Criptografa um texto plaintext usando AES-256-GCM.
 *
 * @param {string} plaintext - Texto a ser criptografado (ex: senha do professor)
 * @returns {{ encrypted: string, iv: string, tag: string }}
 *   - encrypted: texto criptografado em hex
 *   - iv: initialization vector em hex
 *   - tag: auth tag em hex (GCM integrity)
 */
export function encrypt(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('[agente.crypt] plaintext inválido para criptografar.');
  }

  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    tag,
  };
}

/**
 * Descriptografa um texto criptografado usando AES-256-GCM.
 *
 * @param {string} encryptedHex - Texto criptografado em hex
 * @param {string} ivHex - Initialization vector em hex
 * @param {string} tagHex - Auth tag em hex
 * @returns {string} Texto original (plaintext)
 * @throws {Error} Se os dados forem inválidos ou a chave estiver errada
 */
export function decrypt(encryptedHex, ivHex, tagHex) {
  if (!encryptedHex || !ivHex || !tagHex) {
    throw new Error('[agente.crypt] Dados de descriptografia incompletos (encrypted, iv, tag).');
  }

  const key = getMasterKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// ============================================================================
// UTILIDADES
// ============================================================================

/**
 * Gera uma nova chave master de 256 bits.
 * Útil para setup inicial.
 *
 * @returns {string} Chave em formato hexadecimal (64 chars)
 */
export function generateMasterKey() {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

/**
 * Valida se a AGENTE_MASTER_KEY está configurada corretamente.
 *
 * @returns {{ ok: boolean, message: string }}
 */
export function validateMasterKey() {
  try {
    getMasterKey();
    return { ok: true, message: 'AGENTE_MASTER_KEY está configurada e válida.' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/**
 * Testa o ciclo completo de criptografia/descriptografia.
 * Útil para verificar se a chave está correta após deploy.
 *
 * @returns {{ ok: boolean, message: string }}
 */
export function selfTest() {
  try {
    const testPlaintext = `agente_selftest_${Date.now()}`;
    const { encrypted, iv, tag } = encrypt(testPlaintext);
    const decrypted = decrypt(encrypted, iv, tag);

    if (decrypted !== testPlaintext) {
      return { ok: false, message: 'Self-test falhou: plaintext != decrypted.' };
    }

    return { ok: true, message: 'Self-test OK: ciclo encrypt/decrypt validado.' };
  } catch (err) {
    return { ok: false, message: `Self-test falhou: ${err.message}` };
  }
}

export default {
  encrypt,
  decrypt,
  generateMasterKey,
  validateMasterKey,
  selfTest,
};
