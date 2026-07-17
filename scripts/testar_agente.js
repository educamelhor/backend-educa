// scripts/testar_agente.js
// ============================================================================
// TESTE RÁPIDO DO MÓDULO AGENTE AUTÔNOMO
// Executa:
//   1. Self-test da criptografia AES-256-GCM
//   2. Login de teste no EducaDF (se credenciais forem fornecidas)
//
// Uso:
//   node scripts/testar_agente.js                          (só criptografia)
//   node scripts/testar_agente.js LOGIN SENHA              (criptografia + login)
//   node scripts/testar_agente.js LOGIN SENHA --visible    (login com browser visível)
// ============================================================================

import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carregar env
dotenv.config({ path: join(__dirname, '..', '.env.development') });

const { encrypt, decrypt, validateMasterKey, selfTest } = await import('../modules/agente/agente.crypt.js');

console.log('\n═════════════════════════════════════════════════════');
console.log('  🤖 TESTE DO MÓDULO AGENTE AUTÔNOMO — EducaDF Bridge');
console.log('═════════════════════════════════════════════════════\n');

// ============================================================================
// TESTE 1: Validar chave master
// ============================================================================
console.log('▶ TESTE 1: Validar AGENTE_MASTER_KEY');
const keyResult = validateMasterKey();
console.log(`  ${keyResult.ok ? '✅' : '❌'} ${keyResult.message}`);

// ============================================================================
// TESTE 2: Self-test criptografia
// ============================================================================
console.log('\n▶ TESTE 2: Self-test criptografia (encrypt → decrypt)');
const testResult = selfTest();
console.log(`  ${testResult.ok ? '✅' : '❌'} ${testResult.message}`);

// ============================================================================
// TESTE 3: Criptografar e descriptografar uma senha de exemplo
// ============================================================================
console.log('\n▶ TESTE 3: Criptografia de senha');
try {
  const senhaOriginal = 'MinhaSenhaSecreta@2026';
  const { encrypted, iv, tag } = encrypt(senhaOriginal);
  console.log(`  📦 Encrypted: ${encrypted.slice(0, 20)}...`);
  console.log(`  🔑 IV:        ${iv}`);
  console.log(`  🏷️  Tag:       ${tag}`);

  const senhaDecrypt = decrypt(encrypted, iv, tag);
  const match = senhaDecrypt === senhaOriginal;
  console.log(`  ${match ? '✅' : '❌'} Decrypt OK: ${match}`);
} catch (err) {
  console.log(`  ❌ Erro: ${err.message}`);
}

// ============================================================================
// TESTE 4: Login no EducaDF (opcional — requer argumentos CLI)
// ============================================================================
const args = process.argv.slice(2);
const loginArg = args[0];
const senhaArg = args[1];
const isVisible = args.includes('--visible');

if (loginArg && senhaArg) {
  console.log('\n▶ TESTE 4: Login no EducaDF');
  console.log(`  Login: ${loginArg}`);
  console.log(`  Senha: ${'*'.repeat(senhaArg.length)}`);
  console.log(`  Modo:  ${isVisible ? 'VISÍVEL (não-headless)' : 'HEADLESS'}`);
  console.log('  Aguarde...\n');

  try {
    const { EducaDFBrowser } = await import('../modules/agente/educadf/educadf.browser.js');
    const { testCredentials } = await import('../modules/agente/educadf/educadf.login.js');

    const result = await EducaDFBrowser.withSession(
      async (session) => {
        return await testCredentials(session, { login: loginArg, senha: senhaArg });
      },
      {
        headless: !isVisible,
        escolaId: 'teste',
        professorId: 'manual',
      }
    );

    console.log(`  ${result.ok ? '✅' : '❌'} ${result.message}`);
    console.log(`  ⏱️  Duração: ${result.durationMs}ms`);
    if (result.screenshotPath) {
      console.log(`  📸 Screenshot: ${result.screenshotPath}`);
    }
    if (result.errorCode) {
      console.log(`  ⚠️  Código de erro: ${result.errorCode}`);
    }
  } catch (err) {
    console.log(`  ❌ Erro no login: ${err.message}`);
  }
} else {
  console.log('\n▶ TESTE 4: Login no EducaDF — PULADO');
  console.log('  Para testar login: node scripts/testar_agente.js MATRICULA SENHA');
  console.log('  Para browser visível: node scripts/testar_agente.js MATRICULA SENHA --visible');
}

console.log('\n═════════════════════════════════════════════════════');
console.log('  Teste finalizado.');
console.log('═════════════════════════════════════════════════════\n');

process.exit(0);
