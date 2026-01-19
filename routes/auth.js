// api/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";;
import jwt from "jsonwebtoken";
import pool from "../db.js";
import nodemailer from "nodemailer";
import { randomInt } from "crypto";

import multer from "multer";
import fs from "fs";
import path from "path";


const router = express.Router();
function getJwtSecret() {
  return process.env.JWT_SECRET || "superseguro";
}

// ──────────────────────────────────────────────────────────────
// Upload de foto (professores) — seguro e simples (salva caminho no MySQL)
// ──────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const UPLOADS_PROF_DIR = path.join(UPLOADS_DIR, "professores");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(UPLOADS_PROF_DIR)) fs.mkdirSync(UPLOADS_PROF_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_PROF_DIR),
  filename: (req, file, cb) => {
    const cpf = String(req.body?.cpf || "").replace(/\D/g, "");
    const escolaId = String(req.body?.escola_id || "");
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const stamp = Date.now();
    cb(null, `prof_${cpf}_${escolaId}_${stamp}${ext}`);
  },
});

const uploadFoto = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/.test(file.mimetype);
    if (!ok) return cb(new Error("TIPO_ARQUIVO_INVALIDO"));
    cb(null, true);
  },
});


/**
 * Função utilitária para envio de e-mail com código OTP
 */
async function enviarCodigoEmail(email, codigo) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  // ✅ Diagnóstico explícito (evita 500 "mudo")
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.error("[AUTH/enviarCodigoEmail] SMTP não configurado:", {
      SMTP_HOST: !!SMTP_HOST,
      SMTP_PORT: !!SMTP_PORT,
      SMTP_USER: !!SMTP_USER,
      SMTP_PASS: !!SMTP_PASS,
    });
    throw new Error("SMTP_NAO_CONFIGURADO");
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  try {
    await transporter.sendMail({
      from: `"Sistema Educacional" <${SMTP_USER}>`,
      to: email,
      subject: "Código de Confirmação",
      text: `Seu código de verificação é: ${codigo}`,
    });
  } catch (err) {
    console.error("[AUTH/enviarCodigoEmail] Falha ao enviar e-mail:", {
      email,
      smtpHost: SMTP_HOST,
      smtpPort: SMTP_PORT,
      message: err?.message,
    });
    throw err;
  }
}


/**
 * 1) Login – envia código de confirmação
 */
router.post("/login", async (req, res) => {
  const { emailOuCelular, senha } = req.body;
  try {
    const [[usuario]] = await pool.query(
      "SELECT * FROM usuarios WHERE email = ? OR celular = ?",
      [emailOuCelular, emailOuCelular]
    );
    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });

    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaOk) return res.status(401).json({ message: "Senha incorreta." });

    // ✅ Geração do código (string)
    const codigo = String(randomInt(100000, 999999));

    // ✅ LOG diagnóstico (mantido)
    console.log("[AUTH/login] usuario.id =", usuario.id);
    console.log("[AUTH/login] codigo =", codigo);

    // ✅ IMPORTANTE: expiração calculada no MySQL (mesmo relógio do NOW())
    const [ins] = await pool.query(
      "INSERT INTO otp_codes (usuario_id, codigo, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [usuario.id, codigo]
    );

    console.log("[AUTH/login] otp insertId =", ins?.insertId);

    // ✅ Verifica o que ficou gravado no MySQL (principal)
    const [[rowOtp]] = await pool.query(
      "SELECT id, usuario_id, codigo, expira_em, NOW() AS now_db FROM otp_codes WHERE id = ?",
      [ins?.insertId]
    );

    console.log("[AUTH/login] otp gravado no DB =", rowOtp);

    if (usuario.email) await enviarCodigoEmail(usuario.email, codigo);

    return res.json({ message: "Código enviado para confirmação.", usuarioId: usuario.id });
  } catch (err) {
    console.error("Erro no login:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 2) Confirmar Código (login) – ajustado para incluir escola_id e nome_escola no token
 */
router.post("/confirmar", async (req, res) => {
  const { usuarioId, codigo } = req.body;

  try {
    if (!usuarioId || !codigo) {
      return res.status(400).json({ message: "Usuário e código são obrigatórios." });
    }

    const [[otp]] = await pool.query(
      "SELECT id, usuario_id FROM otp_codes WHERE usuario_id = ? AND codigo = ? AND expira_em > NOW()",
      [usuarioId, codigo]
    );

    if (!otp) {
      return res.status(400).json({ message: "Código inválido ou expirado." });
    }

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [otp.id]);

    // 1) Carrega o usuário base (linha atual)
    const [[usuarioBase]] = await pool.query(
      `SELECT u.id, u.nome, u.cpf, u.email, u.celular, u.escola_id, u.perfil
       FROM usuarios u
       WHERE u.id = ?
       LIMIT 1`,
      [usuarioId]
    );

    if (!usuarioBase) {
      return res.status(404).json({ message: "Usuário não localizado para confirmação." });
    }

    // 2) Descobre todas as escolas ativas para o MESMO CPF/PERFIL (professor) com credenciais já cadastradas
    //    (no seu cenário, existem múltiplas linhas em usuarios, uma por escola)
    const [escolasVinculadas] = await pool.query(
      `
      SELECT DISTINCT
        u.escola_id AS id,
        e.nome      AS nome
      FROM usuarios u
      LEFT JOIN escolas e ON e.id = u.escola_id
      WHERE u.cpf = ?
        AND u.perfil = ?
        AND u.ativo = 1
        AND u.escola_id IS NOT NULL
        AND (u.senha_hash IS NOT NULL AND u.senha_hash <> '')
        AND (
          (u.email IS NOT NULL AND u.email <> '' AND u.email = ?)
          OR
          (u.celular IS NOT NULL AND u.celular <> '' AND u.celular = ?)
        )
      ORDER BY e.nome ASC
      `,
      [usuarioBase.cpf, usuarioBase.perfil, usuarioBase.email || "", usuarioBase.celular || ""]
    );

    // 3) Se houver mais de uma escola, NÃO emite token ainda — força escolha de contexto no frontend
    if (Array.isArray(escolasVinculadas) && escolasVinculadas.length > 1) {
      return res.json({
        multi_escola: true,
        nome: usuarioBase.nome || "Usuário",
        perfil: usuarioBase.perfil || "aluno",
        escolas: escolasVinculadas, // [{id, nome}, ...]
      });
    }

    // 4) Caso padrão: 1 escola (ou nenhuma) — emite token normalmente
    const escolaIdFinal = escolasVinculadas?.[0]?.id ?? usuarioBase.escola_id ?? null;

    const [[escolaRow]] = await pool.query(
      `SELECT nome FROM escolas WHERE id = ? LIMIT 1`,
      [escolaIdFinal]
    );

    const token = jwt.sign(
      {
        usuarioId: usuarioBase.id,
        escola_id: escolaIdFinal,
        nome_escola: escolaRow?.nome || null,
        perfil: usuarioBase.perfil || "aluno",
      },
      getJwtSecret(),
      { expiresIn: "8h" }
    );

    return res.json({
      token,
      nome: usuarioBase.nome || "Usuário",
      escola_id: escolaIdFinal,
      nome_escola: escolaRow?.nome || "Escola não definida",
      perfil: usuarioBase.perfil || "aluno",
    });
  } catch (err) {
    console.error("Erro ao confirmar código:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});

/**
 * 3) Enviar código para cadastro novo
 */
router.post("/enviar-codigo-cadastro", async (req, res) => {
  const { email, cpf, escola_id } = req.body;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ message: "E-mail inválido." });
  }

  const cpfLimpo = String(cpf || "").replace(/\D/g, "");
  if (!cpfLimpo || cpfLimpo.length !== 11) {
    return res.status(400).json({ message: "CPF inválido." });
  }

  if (!escola_id) {
    return res.status(400).json({ message: "Escola é obrigatória." });
  }

  try {
    // ✅ Localiza o usuário pré-cadastrado (fonte: usuarios já criado no pré-cadastro)
    const [[usuario]] = await pool.query(
      `
      SELECT id
      FROM usuarios
      WHERE cpf = ?
        AND escola_id = ?
      LIMIT 1
      `,
      [cpfLimpo, Number(escola_id)]
    );


    if (!usuario?.id) {
      return res.status(404).json({
        message:
          "Usuário não localizado para este CPF e escola. Procure a direção/secretaria.",
      });
    }

    // ✅ Regra multi-escola:
    // - Permite mesmo e-mail se for do MESMO CPF (mesma pessoa em outra escola)
    // - Bloqueia se o e-mail já estiver ligado a OUTRO CPF
    const [[emailEmUso]] = await pool.query(
      "SELECT id, cpf FROM usuarios WHERE email = ? LIMIT 1",
      [email]
    );

    if (emailEmUso?.id && String(emailEmUso.cpf || "") !== cpfLimpo) {
      return res.status(409).json({
        message: "Este e-mail já está em uso. Informe outro e-mail para continuar.",
      });
    }


    const codigo = String(randomInt(100000, 999999));

    // 🔁 Regra: reenviar invalida códigos anteriores (para este usuário e/ou e-mail)
    await pool.query("DELETE FROM otp_codes WHERE usuario_id = ?", [usuario.id]);
    await pool.query("DELETE FROM otp_codes WHERE email = ?", [email]);

    // ✅ Agora usuario_id NUNCA é NULL
    await pool.query(
      "INSERT INTO otp_codes (usuario_id, email, codigo, expira_em) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [usuario.id, email, codigo]
    );

    await enviarCodigoEmail(email, codigo);

    return res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao enviar código de cadastro:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});



/**
 * 4) Confirmar código para cadastro novo
 */
router.post("/confirmar-codigo-cadastro", async (req, res) => {
  const { email, codigo } = req.body;

  try {
    // ✅ Aqui já recupera usuario_id do OTP e puxa dados do pré-cadastro (professores)
    const [[row]] = await pool.query(
      `
      SELECT
        oc.id            AS otp_id,
        oc.usuario_id    AS usuario_id,
        u.cpf            AS cpf,
        u.escola_id      AS escola_id,
        p.nome           AS nome_pre_cadastrado,
        p.perfil         AS perfil_pre_cadastro
      FROM otp_codes oc
      JOIN usuarios u
        ON u.id = oc.usuario_id
      LEFT JOIN professores p
        ON p.cpf = u.cpf
       AND p.escola_id = u.escola_id
      WHERE oc.email = ?
        AND oc.codigo = ?
        AND oc.expira_em > NOW()
      LIMIT 1
      `,
      [email, codigo]
    );

    if (!row) {
      return res.status(400).json({ message: "Código inválido ou expirado." });
    }

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [row.otp_id]);

    return res.json({
      sucesso: true,
      usuario_id: row.usuario_id,
      cpf: row.cpf,
      escola_id: row.escola_id,
      nome: row.nome_pre_cadastrado || "",
      perfil: row.perfil_pre_cadastro || "professor",
    });
  } catch (err) {
    console.error("Erro ao confirmar código de cadastro:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 5) Pré-cadastros por e-mail (PÚBLICO)
 * - Retorna as escolas onde existe pré-cadastro PENDENTE para o e-mail informado.
 * - Critério de "pendente": senha_hash ainda não definida (ajustável depois).
 */
router.get("/pre-cadastros/por-email/:email", async (req, res) => {
  const email = String(req.params?.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, message: "E-mail inválido." });
  }

  try {
    const [rows] = await pool.query(
      `
      SELECT DISTINCT
        u.escola_id AS id,
        e.nome      AS nome
      FROM usuarios u
      LEFT JOIN escolas e ON e.id = u.escola_id
      WHERE u.email = ?
        AND u.perfil = 'professor'
        AND (u.senha_hash IS NULL OR u.senha_hash = '')
        AND u.escola_id IS NOT NULL
      ORDER BY e.nome ASC
      `,
      [email]
    );

    if (rows.length > 0) {
      return res.json({
        ok: true,
        preCadastroValido: true,
        escolas: rows,
        message: "Pré-cadastro localizado.",
      });
    }

    // ✅ Caso 2: e-mail existe, mas já concluiu cadastro (não é pré-cadastro pendente)
    const [[jaCadastrado]] = await pool.query(
      `
      SELECT id, perfil
      FROM usuarios
      WHERE email = ?
        AND (senha_hash IS NOT NULL AND senha_hash <> '')
      LIMIT 1
      `,
      [email]
    );

    if (jaCadastrado) {
      return res.json({
        ok: true,
        preCadastroValido: false,
        escolas: [],
        jaCadastrado: true,
        message: "Cadastro já concluído para este e-mail. Faça login.",
      });
    }

    // ✅ Caso 3: nada encontrado (nem pendente, nem cadastrado)
    return res.json({
      ok: true,
      preCadastroValido: false,
      escolas: [],
      message: "Não foi possível prosseguir. Procure a direção da escola.",
    });
  } catch (err) {
    console.error("Erro ao buscar pré-cadastros por e-mail:", err);
    return res.status(500).json({ ok: false, message: "Erro no servidor." });
  }
});

/**
 * 6) Validar pré-cadastro do professor (por CPF) — mantido
 * - Agora também retorna múltiplas escolas pendentes, se existirem.
 */
router.post("/validar-professor", async (req, res) => {
  const cpf = String(req.body?.cpf || "").trim();

  if (!cpf) {
    return res.status(400).json({ ok: false, message: "CPF é obrigatório." });
  }

  try {
    const cpfLimpo = String(cpf || "").replace(/\D/g, "");
    if (!cpfLimpo || cpfLimpo.length !== 11) {
      return res.status(400).json({ ok: false, message: "CPF inválido." });
    }

    const [rows] = await pool.query(
      `
      SELECT DISTINCT
        u.escola_id AS id,
        e.nome      AS nome,
        COALESCE(p.perfil, u.perfil) AS perfil,
        COALESCE(p.nome, u.nome)     AS nome_pre_cadastrado
      FROM usuarios u
      LEFT JOIN escolas e
        ON e.id = u.escola_id
      LEFT JOIN professores p
        ON p.cpf = u.cpf
       AND p.escola_id = u.escola_id
      WHERE u.cpf = ?
        AND u.perfil = 'professor'
        AND u.escola_id IS NOT NULL
        AND (u.senha_hash IS NULL OR u.senha_hash = '')
      ORDER BY e.nome ASC
      `,
      [cpfLimpo]
    );

    // ✅ Se encontrou pré-cadastro pendente
    if (rows.length > 0) {
      return res.json({
        ok: true,
        preCadastroValido: true,
        escolas: rows,
        jaCadastrado: false,
        message: "Pré-cadastro localizado.",
      });
    }

    // ✅ Caso 2: CPF existe, mas já concluiu cadastro (senha_hash preenchida)
    const [[jaCadastrado]] = await pool.query(
      `
      SELECT id, perfil
      FROM usuarios
      WHERE cpf = ?
        AND perfil = 'professor'
        AND (senha_hash IS NOT NULL AND senha_hash <> '')
      LIMIT 1
      `,
      [cpf]
    );

    if (jaCadastrado) {
      return res.json({
        ok: true,
        preCadastroValido: false,
        escolas: [],
        jaCadastrado: true,
        message: "Cadastro já concluído para este CPF. Faça login.",
      });
    }

    // ✅ Caso 3: nada encontrado
    return res.json({
      ok: true,
      preCadastroValido: false,
      escolas: [],
      jaCadastrado: false,
      message: "CPF não localizado no pré-cadastro. Procure a direção da escola.",
    });

  } catch (err) {
    console.error("Erro ao validar pré-cadastro:", err);
    res.status(500).json({ ok: false, message: "Erro no servidor." });
  }
});


/**
 * 6) Complementar dados do professor
 */
router.post("/complementar-professor", async (req, res) => {
  const { id, cpf, nome, data_nascimento, sexo, email, celular, escola_id, perfil } = req.body;
  const perfilFinal = perfil || "professor";

  if ((!id && !cpf) || !nome || !data_nascimento || !sexo) {
    return res.status(400).json({ message: "Campos obrigatórios." });
  }

  try {
    let escolaIdFinal = escola_id;

    if (!escola_id && cpf) {
      const [[usuarioExistente]] = await pool.query(
        "SELECT escola_id FROM usuarios WHERE cpf = ? AND perfil = ?",
        [cpf, perfilFinal]
      );
      escolaIdFinal = usuarioExistente?.escola_id || null;
    }

    // ✅ Descobre o usuarioId alvo (necessário para validar e-mail duplicado)
    let usuarioIdAlvo = id || null;

    if (!usuarioIdAlvo) {
      const cpfLimpo = String(cpf || "").replace(/\D/g, "");
      const [[u]] = await pool.query(
        "SELECT id FROM usuarios WHERE cpf = ? AND escola_id = ? AND perfil = ? LIMIT 1",
        [cpfLimpo, escolaIdFinal, perfilFinal]
      );
      usuarioIdAlvo = u?.id || null;
    }

    if (!usuarioIdAlvo) {
      return res.status(404).json({ message: "Usuário não localizado para complementar." });
    }

    // ✅ Regra multi-escola:
    // - Permite mesmo e-mail se for do MESMO CPF
    // - Bloqueia se o e-mail já estiver ligado a OUTRO CPF
    if (email && typeof email === "string" && email.includes("@")) {
      const cpfLimpoReq = String(cpf || "").replace(/\D/g, "");

      const [[emailEmUso]] = await pool.query(
        "SELECT id, cpf FROM usuarios WHERE email = ? LIMIT 1",
        [email]
      );

      if (emailEmUso?.id && String(emailEmUso.cpf || "") !== cpfLimpoReq) {
        return res.status(409).json({
          message: "Este e-mail já está em uso. Informe outro e-mail para continuar.",
        });
      }
    }

    // ✅ Regra multi-escola (CELULAR):
    // - Permite mesmo celular se for do MESMO CPF (mesma pessoa em outra escola)
    // - Bloqueia se o celular já estiver ligado a OUTRO CPF
    if (celular && typeof celular === "string") {
      const cpfLimpoReq = String(cpf || "").replace(/\D/g, "");
      const celLimpoReq = String(celular || "").replace(/\D/g, "");

      // validação básica (aceita 10 ou 11 dígitos)
      if (celLimpoReq.length < 10 || celLimpoReq.length > 11) {
        return res.status(400).json({ message: "Celular inválido." });
      }

      const [rowsCel] = await pool.query(
        "SELECT id, cpf FROM usuarios WHERE celular = ?",
        [celLimpoReq]
      );

      // ✅ Só bloqueia se existir ALGUMA linha com celular igual e CPF diferente
      const existeOutroCpf = Array.isArray(rowsCel) && rowsCel.some((r) => {
        const cpfRow = String(r?.cpf || "").replace(/\D/g, "");
        return cpfRow && cpfRow !== cpfLimpoReq;
      });

      if (existeOutroCpf) {
        return res.status(409).json({
          message: "Este celular já está em uso. Informe outro celular para continuar.",
        });
      }
    }

    // ✅ Atualiza usuários e professores

    const celularFinal = celular ? String(celular).replace(/\D/g, "") : null;

    await pool.query(
      "UPDATE usuarios SET nome = ?, email = ?, celular = ?, escola_id = ? WHERE id = ? AND perfil = ?",
      [nome, email || null, celularFinal, escolaIdFinal, usuarioIdAlvo, perfilFinal]
    );

    const cpfLimpoFinal = String(cpf || "").replace(/\D/g, "");
    await pool.query(
      "UPDATE professores SET nome = ?, data_nascimento = ?, sexo = ? WHERE cpf = ? AND escola_id = ?",
      [nome, data_nascimento, sexo, cpfLimpoFinal, escolaIdFinal]
    );

    return res.json({ sucesso: true });
  } catch (err) {
    // ✅ Fallback: se ainda ocorrer duplicidade por corrida/concorrência
    if (err?.code === "ER_DUP_ENTRY" && String(err?.sqlMessage || "").includes("usuarios.email")) {
      return res.status(409).json({
        message: "Este e-mail já está em uso. Informe outro e-mail para continuar.",
      });
    }

    console.error("Erro ao complementar dados:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 7) Cadastrar senha
 */
router.post("/cadastrar-senha", async (req, res) => {
  const { cpf, senha, perfil, email, celular } = req.body;
  const perfilFinal = perfil || "professor";

  // ✅ Validação forte (mesmas regras do front)
  const senhaValida =
    typeof senha === "string" &&
    senha.length >= 6 &&
    /[A-Za-z]/.test(senha) &&
    /\d/.test(senha) &&
    /[$#@*_]/.test(senha);

  if (!cpf || String(cpf).replace(/\D/g, "").length !== 11) {
    return res.status(400).json({ message: "CPF inválido." });
  }

  if (!senhaValida) {
    return res.status(400).json({
      message:
        "Senha fraca. Use no mínimo 6 caracteres com letras, números e pelo menos 1 destes: $#@*_",
    });
  }

  try {
    const senha_hash = await bcrypt.hash(senha, 10);

    // ✅ Fallback de segurança (CELULAR):
    // - Permite mesmo celular se for do MESMO CPF
    // - Bloqueia se o celular já estiver ligado a OUTRO CPF
    if (celular && typeof celular === "string") {
      const cpfLimpoReq = String(cpf || "").replace(/\D/g, "");
      const celLimpoReq = String(celular || "").replace(/\D/g, "");

      if (celLimpoReq.length < 10 || celLimpoReq.length > 11) {
        return res.status(400).json({ message: "Celular inválido." });
      }

      const [[celEmUso]] = await pool.query(
        "SELECT id, cpf FROM usuarios WHERE celular = ? LIMIT 1",
        [celLimpoReq]
      );

      if (celEmUso?.id && String(celEmUso.cpf || "") !== cpfLimpoReq) {
        return res.status(409).json({
          message: "Este celular já está em uso. Informe outro celular para continuar.",
        });
      }
    }

    await pool.query(
      "UPDATE usuarios SET senha_hash = ?, ativo = 1, email = COALESCE(?, email), celular = COALESCE(?, celular) WHERE cpf = ? AND perfil = ?",
      [senha_hash, email || null, celular ? String(celular).replace(/\D/g, "") : null, cpf, perfilFinal]
    );


    return res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao cadastrar senha:", err);
    return res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 8) Enviar código para usuários já cadastrados
 */
router.post("/enviar-codigo", async (req, res) => {
  const { email } = req.body;
  try {
    const [[usuario]] = await pool.query(
      "SELECT id, email FROM usuarios WHERE email=?",
      [email]
    );
    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });

    const codigo = String(randomInt(100000, 999999));

    // 🔁 Regra: reenviar invalida códigos anteriores (para este usuário)
    await pool.query("DELETE FROM otp_codes WHERE usuario_id = ?", [usuario.id]);

    // ✅ Expiração calculada no MySQL (5 minutos)
    await pool.query(
      "INSERT INTO otp_codes (usuario_id, codigo, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))",
      [usuario.id, codigo]
    );
    await enviarCodigoEmail(usuario.email, codigo);

    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao enviar código:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});

/**
 * 9) Confirmar código para usuário já existente
 */
router.post("/confirmar-cadastro", async (req, res) => {
  const { email, codigo } = req.body;
  try {
    const [[usuario]] = await pool.query(
      "SELECT id FROM usuarios WHERE email=?",
      [email]
    );
    if (!usuario) return res.status(404).json({ message: "Usuário não encontrado." });

    const [[otp]] = await pool.query(
      "SELECT * FROM otp_codes WHERE usuario_id=? AND codigo=? AND expira_em > NOW()",
      [usuario.id, codigo]
    );
    if (!otp) return res.status(400).json({ message: "Código inválido ou expirado." });

    await pool.query("DELETE FROM otp_codes WHERE id = ?", [otp.id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao confirmar código:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 2.1) Confirmar Escola (multi-escola) — emite token com escola_id correto
 */
router.post("/confirmar-escola", async (req, res) => {
  const { usuarioId, escola_id } = req.body;

  try {
    const escolaId = Number(escola_id);
    if (!usuarioId || !escolaId) {
      return res.status(400).json({ message: "usuarioId e escola_id são obrigatórios." });
    }

    const [[usuarioBase]] = await pool.query(
      `SELECT id, nome, cpf, email, celular, perfil
       FROM usuarios
       WHERE id = ?
       LIMIT 1`,
      [usuarioId]
    );

    if (!usuarioBase) {
      return res.status(404).json({ message: "Usuário não localizado." });
    }

    // Valida se o usuário realmente possui vínculo com essa escola (mesmo CPF/PERFIL e mesma credencial)
    const [[usuarioEscola]] = await pool.query(
      `
      SELECT u.id, u.escola_id, e.nome AS nome_escola
      FROM usuarios u
      LEFT JOIN escolas e ON e.id = u.escola_id
      WHERE u.cpf = ?
        AND u.perfil = ?
        AND u.ativo = 1
        AND u.escola_id = ?
        AND (u.senha_hash IS NOT NULL AND u.senha_hash <> '')
        AND (
          (u.email IS NOT NULL AND u.email <> '' AND u.email = ?)
          OR
          (u.celular IS NOT NULL AND u.celular <> '' AND u.celular = ?)
        )
      LIMIT 1
      `,
      [usuarioBase.cpf, usuarioBase.perfil, escolaId, usuarioBase.email || "", usuarioBase.celular || ""]
    );

    if (!usuarioEscola) {
      return res.status(403).json({ message: "Você não possui vínculo válido com esta escola." });
    }

    const token = jwt.sign(
      {
        usuarioId: usuarioEscola.id, // ✅ id da linha da escola escolhida
        escola_id: usuarioEscola.escola_id,
        nome_escola: usuarioEscola.nome_escola || null,
        perfil: usuarioBase.perfil || "aluno",
      },
      getJwtSecret(),
      { expiresIn: "8h" }
    );

    return res.json({
      token,
      nome: usuarioBase.nome || "Usuário",
      escola_id: usuarioEscola.escola_id,
      nome_escola: usuarioEscola.nome_escola || "Escola não definida",
      perfil: usuarioBase.perfil || "aluno",
    });
  } catch (err) {
    console.error("Erro ao confirmar escola:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
});


/**
 * 10) Upload de foto do professor (opcional)
 * - Salva arquivo em /uploads/professores
 * - Persiste o caminho em professores.foto (cpf + escola_id)
 */

router.post("/upload-foto-professor", (req, res) => {
  uploadFoto.single("foto")(req, res, async (err) => {
    try {
      // ✅ Erros do multer (tamanho/tipo/etc.)
      if (err) {
        if (err?.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ message: "Arquivo muito grande. Limite: 2MB." });
        }

        if (err?.message === "TIPO_ARQUIVO_INVALIDO") {
          return res.status(400).json({ message: "Formato inválido. Envie JPEG, PNG ou WEBP." });
        }

        console.error("Erro no multer (upload foto):", err);
        return res.status(400).json({ message: "Falha no upload da foto." });
      }

      const cpfLimpo = String(req.body?.cpf || "").replace(/\D/g, "");
      const escolaId = Number(req.body?.escola_id);

      if (!cpfLimpo || cpfLimpo.length !== 11) {
        return res.status(400).json({ message: "CPF inválido." });
      }
      if (!escolaId) {
        return res.status(400).json({ message: "Escola é obrigatória." });
      }
      if (!req.file) {
        return res.status(400).json({ message: "Arquivo não enviado." });
      }

      // Caminho relativo salvo no banco (compatível com VARCHAR/TEXT)
      const fotoPath = `/uploads/professores/${req.file.filename}`;

      await pool.query(
        "UPDATE professores SET foto = ? WHERE cpf = ? AND escola_id = ?",
        [fotoPath, cpfLimpo, escolaId]
      );

      return res.json({ sucesso: true, foto: fotoPath });
    } catch (e) {
      console.error("Erro ao fazer upload da foto:", e);
      return res.status(500).json({ message: "Erro no servidor." });
    }
  });
});


export default router;

