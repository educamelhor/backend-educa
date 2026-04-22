/**
 * recriar_admin_ceo.mjs
 * ============================================================================
 * Script de RECUPERAÇÃO — Recria o usuário CEO/Admin da Plataforma
 * ============================================================================
 * USO:
 *   node recriar_admin_ceo.mjs
 *
 * O script:
 *  1. Verifica se já existe usuário ADMIN ativo (escola_id = 0)
 *  2. Se não existir → insere com senha temporária
 *  3. Se encontrado mas inativo → reativa
 *  4. Exibe o e-mail e a senha temporária para primeiro acesso
 *
 * APÓS O PRIMEIRO LOGIN: altere a senha imediatamente pelo painel.
 * ============================================================================
 */

import bcrypt from "bcryptjs";
import pool from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÕES — Edite aqui antes de rodar se quiser customizar
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_EMAIL = "admin@educamelhor.com.br";
const ADMIN_NOME  = "Administrador CEO";
const ADMIN_PERFIL = "SUPER_ADMIN"; // ADMIN | SUPER_ADMIN | ADMIN_GLOBAL
// Senha temporária — será exibida no terminal e deve ser trocada imediatamente
const SENHA_TEMP = "EducaMelhor@2025!";
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔐 RECUPERAÇÃO DO USUÁRIO CEO/ADMIN DA PLATAFORMA");
  console.log("=".repeat(55));

  try {
    // 1) Verificar se já existe algum usuário admin global
    const [existentes] = await pool.query(
      `SELECT id, nome, email, ativo, perfil
       FROM usuarios
       WHERE escola_id = 0
         AND perfil IN ('ADMIN', 'SUPER_ADMIN', 'ADMIN_GLOBAL')
       ORDER BY id ASC`
    );

    if (existentes.length > 0) {
      console.log("\n📋 Usuários admin globais encontrados no banco:");
      existentes.forEach((u) => {
        const status = Number(u.ativo) === 1 ? "✅ ATIVO" : "❌ INATIVO";
        console.log(`   [${u.id}] ${u.email} — ${u.perfil} — ${status}`);
      });

      // Se algum já estiver ativo, não precisa fazer nada
      const ativo = existentes.find((u) => Number(u.ativo) === 1);
      if (ativo) {
        console.log(`\n✅ O usuário "${ativo.email}" já está ATIVO.`);
        console.log("   Verifique se o e-mail e senha estão corretos.");
        console.log("   Se esqueceu a senha, rode este script com --reset-senha para redefinir.\n");

        // Verifica se --reset-senha foi passado
        if (process.argv.includes("--reset-senha")) {
          await redefinirSenha(ativo.id, ativo.email);
        }

        await pool.end();
        return;
      }

      // Todos inativos → reativa o primeiro
      const inativo = existentes[0];
      console.log(`\n⚡ Reativando usuário "${inativo.email}" (id=${inativo.id})...`);
      const senhaHash = await bcrypt.hash(SENHA_TEMP, 12);
      await pool.query(
        `UPDATE usuarios
         SET ativo = 1, senha_hash = ?, perfil = ?
         WHERE id = ?`,
        [senhaHash, ADMIN_PERFIL, inativo.id]
      );
      console.log(`✅ Usuário REATIVADO com sucesso!`);
      exibirCredenciais(inativo.email, SENHA_TEMP);

    } else {
      // Nenhum admin global → criar novo
      console.log("\n⚠️  Nenhum usuário admin global encontrado. Criando novo...");

      // Verifica se o e-mail configurado já existe (mas em escola errada)
      const [[emailExiste]] = await pool.query(
        "SELECT id, escola_id, perfil FROM usuarios WHERE LOWER(email) = ? LIMIT 1",
        [ADMIN_EMAIL.toLowerCase()]
      );

      if (emailExiste) {
        // E-mail existe mas não é global — corrige
        console.log(`   ⚠️  E-mail "${ADMIN_EMAIL}" encontrado com escola_id=${emailExiste.escola_id}. Convertendo para global...`);
        const senhaHash = await bcrypt.hash(SENHA_TEMP, 12);
        await pool.query(
          `UPDATE usuarios
           SET escola_id = 0, perfil = ?, ativo = 1, senha_hash = ?
           WHERE id = ?`,
          [ADMIN_PERFIL, senhaHash, emailExiste.id]
        );
        console.log(`✅ Usuário convertido para ADMIN GLOBAL com sucesso!`);
      } else {
        // Insere novo
        const senhaHash = await bcrypt.hash(SENHA_TEMP, 12);
        const [result] = await pool.query(
          `INSERT INTO usuarios (nome, email, cpf, senha_hash, perfil, escola_id, ativo)
           VALUES (?, ?, ?, ?, ?, 0, 1)`,
          [ADMIN_NOME, ADMIN_EMAIL, "00000000000", senhaHash, ADMIN_PERFIL]
        );
        console.log(`✅ Usuário CEO/Admin criado com sucesso! (id=${result.insertId})`);
      }

      exibirCredenciais(ADMIN_EMAIL, SENHA_TEMP);
    }

  } catch (err) {
    console.error("\n❌ ERRO ao recuperar usuário admin:", err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

async function redefinirSenha(userId, email) {
  console.log(`\n🔑 Redefinindo senha para "${email}"...`);
  const senhaHash = await bcrypt.hash(SENHA_TEMP, 12);
  await pool.query(
    "UPDATE usuarios SET senha_hash = ? WHERE id = ?",
    [senhaHash, userId]
  );
  console.log("✅ Senha redefinida com sucesso!");
  exibirCredenciais(email, SENHA_TEMP);
}

function exibirCredenciais(email, senha) {
  console.log("\n" + "=".repeat(55));
  console.log("🔑 CREDENCIAIS DE ACESSO TEMPORÁRIAS:");
  console.log("=".repeat(55));
  console.log(`   📧 E-mail : ${email}`);
  console.log(`   🔑 Senha  : ${senha}`);
  console.log("=".repeat(55));
  console.log("⚠️  TROQUE A SENHA IMEDIATAMENTE após o primeiro login!");
  console.log("   Acesse: https://sistemaeducamelhor.com.br/login");
  console.log("   → aba \"Plataforma (CEO)\"");
  console.log("=".repeat(55) + "\n");
}

main();
