import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { 
  gerarPdfAdequacaoCurricular,
  gerarPdfAdequacaoSEEDF,
  gerarPdfProntuarioAEE
} from "./sala_recursos_pdf.js";
import {
  encryptDocumentBuffer,
  decryptDocumentBuffer,
  convertImageToPdfBuffer,
  protectPdfBufferWithPassword
} from "../utils/cryptoPdfHelper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_LAUDOS_DIR = path.join(__dirname, "../uploads/aee_laudos_seguros");

if (!fs.existsSync(UPLOAD_LAUDOS_DIR)) {
  try {
    fs.mkdirSync(UPLOAD_LAUDOS_DIR, { recursive: true });
  } catch (err) {
    console.warn("Aviso ao criar diretório de laudos seguros:", err.message);
  }
}

const uploadLaudo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

const router = express.Router();

function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ message: "Acesso negado: escola não definida no token." });
  }
  next();
}

// ─── 1. ESTATÍSTICAS DO PAINEL AEE ────────────────────────────────────────────
router.get("/stats", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = Number(req.query.ano_letivo) || anoLetivoPadrao();

    // Total de alunos com atendimento diferencial ou configurados no AEE
    const [[alunosCount]] = await pool.query(`
      SELECT COUNT(DISTINCT a.id) AS total_alunos_aee
      FROM alunos a
      INNER JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = a.escola_id AND m.ano_letivo = ?
      LEFT JOIN aee_alunos_config cfg ON cfg.aluno_id = a.id AND cfg.escola_id = a.escola_id AND cfg.ano_letivo = ?
      WHERE a.escola_id = ? AND (a.atendimento_diferencial = 1 OR cfg.id IS NOT NULL)
    `, [ano, ano, escola_id]);

    // Total de laudos registrados
    const [[laudosCount]] = await pool.query(`
      SELECT COUNT(*) AS total_laudos
      FROM aee_laudos
      WHERE escola_id = ?
    `, [escola_id]);

    // Total de adequações curriculares no ano
    const [[adeqCount]] = await pool.query(`
      SELECT COUNT(*) AS total_adequacoes
      FROM aee_adequacoes_curriculares
      WHERE escola_id = ? AND ano_letivo = ?
    `, [escola_id, ano]);

    // Total de atendimentos no mês corrente
    const [[atendCount]] = await pool.query(`
      SELECT COUNT(*) AS total_atendimentos_mes
      FROM aee_atendimentos
      WHERE escola_id = ? AND MONTH(data_atendimento) = MONTH(CURRENT_DATE()) AND YEAR(data_atendimento) = YEAR(CURRENT_DATE())
    `, [escola_id]);

    return res.json({
      ano_letivo: ano,
      total_alunos_aee: Number(alunosCount.total_alunos_aee || 0),
      total_laudos: Number(laudosCount.total_laudos || 0),
      total_adequacoes: Number(adeqCount.total_adequacoes || 0),
      total_atendimentos_mes: Number(atendCount.total_atendimentos_mes || 0),
    });
  } catch (err) {
    console.error("[sala_recursos.stats] Erro:", err);
    return res.status(500).json({ message: "Erro ao obter estatísticas da Sala de Recursos." });
  }
});

// ─── 2. LISTAR ALUNOS DA SALA DE RECURSOS / LAUDADOS ──────────────────────────
router.get("/alunos", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const {
      turma_id,
      turno,
      filtro = "",
      status_aee = "", // ativo, desligado, todos
      apenas_aee = "1",
      ano_letivo,
      limit = 150,
      offset = 0
    } = req.query;

    const ano = Number(ano_letivo) || anoLetivoPadrao();

    const where = ["a.escola_id = ?", "m.ano_letivo = ?"];
    const params = [escola_id, ano];

    if (turma_id) {
      where.push("m.turma_id = ?");
      params.push(Number(turma_id));
    }

    if (turno && turno.trim().length > 0 && turno !== "todos") {
      where.push("t.turno = ?");
      params.push(turno.trim());
    }

    if (filtro && filtro.trim().length > 0) {
      where.push("(a.estudante LIKE ? OR a.codigo LIKE ? OR t.nome LIKE ?)");
      const lk = `%${filtro.trim()}%`;
      params.push(lk, lk, lk);
    }

    if (apenas_aee === "1" || apenas_aee === "true") {
      where.push("(a.atendimento_diferencial = 1 OR cfg.id IS NOT NULL OR l.id IS NOT NULL)");
    }

    if (status_aee && status_aee !== "todos") {
      if (status_aee === "ativo") {
        where.push("(cfg.status = 'ativo' OR (cfg.status IS NULL AND (a.atendimento_diferencial = 1 OR l.id IS NOT NULL)))");
      } else if (status_aee === "desligado") {
        where.push("cfg.status = 'desligado'");
      } else if (status_aee === "pendente_config") {
        where.push("(cfg.id IS NULL AND (a.atendimento_diferencial = 1 OR l.id IS NOT NULL))");
      } else {
        where.push("cfg.status = ?");
        params.push(status_aee);
      }
    }

    const sql = `
      SELECT 
        a.id,
        a.codigo,
        a.estudante,
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
        a.sexo,
        a.atendimento_diferencial,
        a.status AS status_matricula,
        a.foto,
        t.id AS turma_id,
        t.nome AS turma_nome,
        t.turno AS turma_turno,
        cfg.id AS aee_config_id,
        cfg.tipo_atendimento,
        cfg.turno_atendimento,
        cfg.dias_semana,
        cfg.horario_atendimento,
        cfg.status AS status_aee,
        cfg.professor_aee,
        cfg.necessidades_especificas,
        (
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', al.id,
              'cid', al.cid,
              'diagnostico', al.diagnostico,
              'medico_nome', al.medico_nome,
              'medico_crm', al.medico_crm,
              'data_laudo', DATE_FORMAT(al.data_laudo, '%Y-%m-%d'),
              'arquivo_url', al.arquivo_url
            )
          )
          FROM aee_laudos al
          WHERE al.aluno_id = a.id AND al.escola_id = a.escola_id
        ) AS laudos_json,
        (
          SELECT COUNT(*)
          FROM aee_adequacoes_curriculares ac
          WHERE ac.aluno_id = a.id AND ac.escola_id = a.escola_id AND ac.ano_letivo = ?
        ) AS total_adequacoes,
        (
          SELECT COUNT(*)
          FROM aee_atendimentos aa
          WHERE aa.aluno_id = a.id AND aa.escola_id = a.escola_id
        ) AS total_atendimentos
      FROM alunos a
      INNER JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = a.escola_id
      LEFT JOIN turmas t ON t.id = m.turma_id
      LEFT JOIN aee_alunos_config cfg ON cfg.aluno_id = a.id AND cfg.escola_id = a.escola_id AND cfg.ano_letivo = m.ano_letivo
      LEFT JOIN (
        SELECT DISTINCT aluno_id, escola_id, id FROM aee_laudos
      ) l ON l.aluno_id = a.id AND l.escola_id = a.escola_id
      WHERE ${where.join(" AND ")}
      GROUP BY a.id, t.id, cfg.id
      ORDER BY a.estudante ASC
      LIMIT ? OFFSET ?
    `;

    const allParams = [ano, ...params, Number(limit), Number(offset)];
    const [rows] = await pool.query(sql, allParams);

    const alunosFormatados = rows.map((r) => {
      let laudos = [];
      try {
        if (r.laudos_json) {
          laudos = typeof r.laudos_json === "string" ? JSON.parse(r.laudos_json) : r.laudos_json;
          laudos = Array.isArray(laudos) ? laudos.filter(Boolean) : [];
        }
      } catch (_) {
        laudos = [];
      }

      return {
        ...r,
        laudos,
        atendimento_diferencial: Number(r.atendimento_diferencial) === 1,
        total_adequacoes: Number(r.total_adequacoes || 0),
        total_atendimentos: Number(r.total_atendimentos || 0),
      };
    });

    return res.json({
      alunos: alunosFormatados,
      total: alunosFormatados.length,
      ano_letivo: ano,
    });
  } catch (err) {
    console.error("[sala_recursos.alunos] Erro:", err);
    return res.status(500).json({ message: "Erro ao listar alunos da Sala de Recursos." });
  }
});

// ─── 3. DETALHES DE UM ALUNO ESPECÍFICO (PRONTUÁRIO AEE) ──────────────────────
router.get("/alunos/:aluno_id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const alunoId = Number(req.params.aluno_id);
    const ano = Number(req.query.ano_letivo) || anoLetivoPadrao();

    const [[aluno]] = await pool.query(`
      SELECT 
        a.id,
        a.codigo,
        a.estudante,
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS data_nascimento,
        a.sexo,
        a.cpf,
        a.atendimento_diferencial,
        a.status AS status_matricula,
        a.foto,
        t.id AS turma_id,
        t.nome AS turma_nome,
        t.turno AS turma_turno,
        m.ano_letivo
      FROM alunos a
      LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = a.escola_id AND m.ano_letivo = ?
      LEFT JOIN turmas t ON t.id = m.turma_id
      WHERE a.id = ? AND a.escola_id = ?
      LIMIT 1
    `, [ano, alunoId, escola_id]);

    if (!aluno) {
      return res.status(404).json({ message: "Aluno não encontrado." });
    }

    // Configuração AEE
    const [[config]] = await pool.query(`
      SELECT *
      FROM aee_alunos_config
      WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ?
      LIMIT 1
    `, [alunoId, escola_id, ano]);

    // Laudos
    const [laudos] = await pool.query(`
      SELECT 
        id, aluno_id, escola_id, tipo_documento, titulo, cid, diagnostico,
        medico_nome, medico_crm, medico_especialidade,
        DATE_FORMAT(data_laudo, '%Y-%m-%d') AS data_laudo,
        DATE_FORMAT(data_validade, '%Y-%m-%d') AS data_validade,
        medicamentos, acompanhamento_externo, arquivo_url, arquivo_path,
        arquivo_nome_original, arquivo_mime, arquivo_tamanho, criptografado,
        observacoes, criado_em,
        CASE WHEN (arquivo_path IS NOT NULL AND arquivo_path != '') THEN 1 ELSE 0 END AS possui_arquivo
      FROM aee_laudos
      WHERE aluno_id = ? AND escola_id = ?
      ORDER BY id DESC
    `, [alunoId, escola_id]);

    // Adequações Curriculares
    const [adequacoes] = await pool.query(`
      SELECT 
        id, ano_letivo, bimestre, disciplina, professor_regente, professor_aee,
        habilidades_prioritarias, metodologias_estrategias, recursos_didaticos,
        avaliacao_adaptada, parecer_conclusivo, status, criado_em, atualizado_em
      FROM aee_adequacoes_curriculares
      WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ?
      ORDER BY bimestre ASC, disciplina ASC
    `, [alunoId, escola_id, ano]);

    // PDI
    const [[pdi]] = await pool.query(`
      SELECT *
      FROM aee_pdi
      WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ?
      LIMIT 1
    `, [alunoId, escola_id, ano]);

    // Atendimentos recentes (últimos 20)
    const [atendimentos] = await pool.query(`
      SELECT 
        id, DATE_FORMAT(data_atendimento, '%Y-%m-%d') AS data_atendimento,
        horario_inicio, horario_fim, presenca, tipo_sessao, atividades_realizadas,
        evolucao_observacoes, registrado_por, criado_em
      FROM aee_atendimentos
      WHERE aluno_id = ? AND escola_id = ?
      ORDER BY data_atendimento DESC, id DESC
      LIMIT 20
    `, [alunoId, escola_id]);

    return res.json({
      aluno,
      config: config || null,
      laudos,
      adequacoes,
      pdi: pdi || null,
      atendimentos,
    });
  } catch (err) {
    console.error("[sala_recursos.alunos.id] Erro:", err);
    return res.status(500).json({ message: "Erro ao buscar detalhes do prontuário AEE." });
  }
});

// ─── 4. SALVAR / ATUALIZAR CONFIGURAÇÃO AEE DO ALUNO ─────────────────────────
router.put("/alunos/:aluno_id/config", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const alunoId = Number(req.params.aluno_id);
    const {
      ano_letivo,
      tipo_atendimento = "Sala de Recursos Multifuncionais",
      turno_atendimento = "Contraturno",
      dias_semana = "",
      horario_atendimento = "",
      status = "ativo",
      professor_aee = "",
      necessidades_especificas = "",
      atendimento_diferencial = 1
    } = req.body;

    const ano = Number(ano_letivo) || anoLetivoPadrao();

    // Atualiza flag no aluno
    await pool.query(`
      UPDATE alunos
      SET atendimento_diferencial = ?
      WHERE id = ? AND escola_id = ?
    `, [Number(atendimento_diferencial) ? 1 : 0, alunoId, escola_id]);

    // Upsert na config
    await pool.query(`
      INSERT INTO aee_alunos_config (
        aluno_id, escola_id, ano_letivo, tipo_atendimento, turno_atendimento,
        dias_semana, horario_atendimento, status, professor_aee, necessidades_especificas
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        tipo_atendimento = VALUES(tipo_atendimento),
        turno_atendimento = VALUES(turno_atendimento),
        dias_semana = VALUES(dias_semana),
        horario_atendimento = VALUES(horario_atendimento),
        status = VALUES(status),
        professor_aee = VALUES(professor_aee),
        necessidades_especificas = VALUES(necessidades_especificas)
    `, [
      alunoId, escola_id, ano, tipo_atendimento, turno_atendimento,
      dias_semana, horario_atendimento, status, professor_aee, necessidades_especificas
    ]);

    return res.json({ ok: true, message: "Configuração do AEE salva com sucesso!" });
  } catch (err) {
    console.error("[sala_recursos.config] Erro:", err);
    return res.status(500).json({ message: "Erro ao salvar configuração do AEE." });
  }
});

// ─── 5. CRUD DE LAUDOS E DOCUMENTOS MÉDICOS COM CRIPTOGRAFIA (LGPD) ───────────
router.post("/alunos/:aluno_id/laudos", verificarEscola, uploadLaudo.single("arquivo"), async (req, res) => {
  try {
    const { escola_id } = req.user;
    const usuarioId = req.user.usuario_id || req.user.id || 0;
    const alunoId = Number(req.params.aluno_id);
    const {
      tipo_documento = "Laudo Médico",
      titulo = "",
      cid = "",
      diagnostico = "",
      medico_nome = "",
      medico_crm = "",
      medico_especialidade = "Neuropediatria",
      data_laudo = null,
      data_validade = null,
      medicamentos = "",
      acompanhamento_externo = "",
      observacoes = ""
    } = req.body;

    // Busca nome do aluno para compor cabeçalho do documento se necessário
    const [[alunoRow]] = await pool.query(
      `SELECT estudante FROM alunos WHERE id = ? AND escola_id = ? LIMIT 1`,
      [alunoId, escola_id]
    );
    const alunoNome = alunoRow?.estudante || "Estudante";

    let arquivo_path = null;
    let arquivo_nome_original = null;
    let arquivo_mime = null;
    let arquivo_tamanho = 0;
    let criptografado = 1;

    // Processa upload se arquivo foi enviado
    if (req.file && req.file.buffer) {
      let finalBufferToEncrypt = req.file.buffer;
      arquivo_nome_original = req.file.originalname;
      arquivo_mime = req.file.mimetype;
      arquivo_tamanho = req.file.size;

      // Se for imagem (JPG, PNG, WebP), converte para PDF oficial institucional A4
      if (arquivo_mime.startsWith("image/")) {
        finalBufferToEncrypt = await convertImageToPdfBuffer(req.file.buffer, {
          aluno_nome: alunoNome,
          tipo_documento,
          titulo,
          cid,
          diagnostico,
          medico_nome,
          medico_crm,
          medico_especialidade,
          data_laudo,
          data_validade
        });
        arquivo_mime = "application/pdf";
        arquivo_nome_original = req.file.originalname.replace(/\.[^/.]+$/, "") + ".pdf";
        arquivo_tamanho = finalBufferToEncrypt.length;
      }

      // Criptografa o PDF com AES-256-GCM antes de gravar no disco
      const encryptedBuffer = encryptDocumentBuffer(finalBufferToEncrypt);
      const safeFileName = `laudo_enc_${alunoId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.bin`;
      const fullDiskPath = path.join(UPLOAD_LAUDOS_DIR, safeFileName);

      fs.writeFileSync(fullDiskPath, encryptedBuffer);
      arquivo_path = safeFileName;
    }

    const [result] = await pool.query(`
      INSERT INTO aee_laudos (
        aluno_id, escola_id, tipo_documento, titulo, cid, diagnostico, medico_nome, medico_crm,
        medico_especialidade, data_laudo, data_validade, medicamentos,
        acompanhamento_externo, arquivo_path, arquivo_nome_original, arquivo_mime,
        arquivo_tamanho, criptografado, observacoes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      alunoId, escola_id, tipo_documento || "Laudo Médico", titulo || null, cid || null,
      diagnostico || null, medico_nome || null, medico_crm || null, medico_especialidade || null,
      data_laudo || null, data_validade || null, medicamentos || null, acompanhamento_externo || null,
      arquivo_path, arquivo_nome_original, arquivo_mime, arquivo_tamanho, criptografado, observacoes || null
    ]);

    const laudoId = result.insertId;

    // Registra log de auditoria LGPD
    await pool.query(`
      INSERT INTO aee_laudos_logs (laudo_id, aluno_id, usuario_id, escola_id, acao, detalhes, ip)
      VALUES (?, ?, ?, ?, 'upload_documento', ?, ?)
    `, [
      laudoId, alunoId, usuarioId, escola_id,
      `Upload de documento seguro (${tipo_documento}) criptografado com AES-256`,
      req.ip || "127.0.0.1"
    ]).catch((e) => console.warn("Log de auditoria falhou:", e.message));

    // Garante que o aluno tenha atendimento_diferencial = 1
    await pool.query(`
      UPDATE alunos SET atendimento_diferencial = 1 WHERE id = ? AND escola_id = ?
    `, [alunoId, escola_id]);

    return res.status(201).json({
      ok: true,
      id: laudoId,
      message: "Documento/Laudo cadastrado e criptografado com sucesso!"
    });
  } catch (err) {
    console.error("[sala_recursos.laudos.post] Erro:", err);
    return res.status(500).json({ message: "Erro ao cadastrar documento/laudo médico: " + err.message });
  }
});

// Atualização de Metadados / Substituição de Arquivo
router.put("/laudos/:id", verificarEscola, uploadLaudo.single("arquivo"), async (req, res) => {
  try {
    const { escola_id } = req.user;
    const usuarioId = req.user.usuario_id || req.user.id || 0;
    const laudoId = Number(req.params.id);
    const {
      tipo_documento = "Laudo Médico",
      titulo = "",
      cid = "",
      diagnostico = "",
      medico_nome = "",
      medico_crm = "",
      medico_especialidade = "Neuropediatria",
      data_laudo = null,
      data_validade = null,
      medicamentos = "",
      acompanhamento_externo = "",
      observacoes = ""
    } = req.body;

    const [[existing]] = await pool.query(
      `SELECT * FROM aee_laudos WHERE id = ? AND escola_id = ? LIMIT 1`,
      [laudoId, escola_id]
    );

    if (!existing) {
      return res.status(404).json({ message: "Laudo não encontrado." });
    }

    let arquivo_path = existing.arquivo_path;
    let arquivo_nome_original = existing.arquivo_nome_original;
    let arquivo_mime = existing.arquivo_mime;
    let arquivo_tamanho = existing.arquivo_tamanho;

    // Se enviou novo arquivo para substituir
    if (req.file && req.file.buffer) {
      let finalBufferToEncrypt = req.file.buffer;
      arquivo_nome_original = req.file.originalname;
      arquivo_mime = req.file.mimetype;
      arquivo_tamanho = req.file.size;

      const [[alunoRow]] = await pool.query(
        `SELECT estudante FROM alunos WHERE id = ? AND escola_id = ? LIMIT 1`,
        [existing.aluno_id, escola_id]
      );

      if (arquivo_mime.startsWith("image/")) {
        finalBufferToEncrypt = await convertImageToPdfBuffer(req.file.buffer, {
          aluno_nome: alunoRow?.estudante || "Estudante",
          tipo_documento,
          titulo,
          cid,
          diagnostico,
          medico_nome,
          medico_crm,
          medico_especialidade,
          data_laudo,
          data_validade
        });
        arquivo_mime = "application/pdf";
        arquivo_nome_original = req.file.originalname.replace(/\.[^/.]+$/, "") + ".pdf";
        arquivo_tamanho = finalBufferToEncrypt.length;
      }

      // Remove arquivo anterior se existir
      if (existing.arquivo_path) {
        const oldPath = path.join(UPLOAD_LAUDOS_DIR, existing.arquivo_path);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch (_) {}
        }
      }

      const encryptedBuffer = encryptDocumentBuffer(finalBufferToEncrypt);
      const safeFileName = `laudo_enc_${existing.aluno_id}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.bin`;
      const fullDiskPath = path.join(UPLOAD_LAUDOS_DIR, safeFileName);
      fs.writeFileSync(fullDiskPath, encryptedBuffer);
      arquivo_path = safeFileName;
    }

    await pool.query(`
      UPDATE aee_laudos
      SET 
        tipo_documento = ?, titulo = ?, cid = ?, diagnostico = ?, medico_nome = ?, medico_crm = ?,
        medico_especialidade = ?, data_laudo = ?, data_validade = ?,
        medicamentos = ?, acompanhamento_externo = ?, arquivo_path = ?,
        arquivo_nome_original = ?, arquivo_mime = ?, arquivo_tamanho = ?, observacoes = ?
      WHERE id = ? AND escola_id = ?
    `, [
      tipo_documento || "Laudo Médico", titulo || null, cid || null, diagnostico || null,
      medico_nome || null, medico_crm || null, medico_especialidade || null,
      data_laudo || null, data_validade || null, medicamentos || null, acompanhamento_externo || null,
      arquivo_path, arquivo_nome_original, arquivo_mime, arquivo_tamanho, observacoes || null,
      laudoId, escola_id
    ]);

    // Registra auditoria
    await pool.query(`
      INSERT INTO aee_laudos_logs (laudo_id, aluno_id, usuario_id, escola_id, acao, detalhes, ip)
      VALUES (?, ?, ?, ?, 'edicao_documento', 'Edição de metadados do documento', ?)
    `, [laudoId, existing.aluno_id, usuarioId, escola_id, req.ip || "127.0.0.1"]).catch(() => {});

    return res.json({ ok: true, message: "Documento/Laudo atualizado com sucesso!" });
  } catch (err) {
    console.error("[sala_recursos.laudos.put] Erro:", err);
    return res.status(500).json({ message: "Erro ao atualizar laudo médico." });
  }
});

// Download de PDF Protegido com a Senha do Usuário Logado (Opção 3 - Rastreabilidade LGPD)
router.post("/laudos/:id/download-protegido", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const usuarioId = req.user.usuario_id || req.user.id || 0;
    const laudoId = Number(req.params.id);
    const { senha } = req.body;

    if (!senha || typeof senha !== "string" || !senha.trim()) {
      return res.status(400).json({ ok: false, message: "A confirmação da sua senha de login é obrigatória para exportar este documento sigiloso." });
    }

    // 1. Valida senha do usuário logado contra o banco
    const [[usuario]] = await pool.query(
      `SELECT id, nome, email, senha_hash, cpf FROM usuarios WHERE id = ? LIMIT 1`,
      [Number(usuarioId)]
    );

    if (!usuario || !usuario.senha_hash) {
      return res.status(401).json({ ok: false, message: "Usuário não autenticado para download de dados sensíveis." });
    }

    const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaCorreta) {
      return res.status(401).json({ ok: false, message: "Senha incorreta. Acesso negado por segurança (LGPD)." });
    }

    // 2. Busca laudo e arquivo
    const [[laudo]] = await pool.query(
      `SELECT * FROM aee_laudos WHERE id = ? AND escola_id = ? LIMIT 1`,
      [laudoId, escola_id]
    );

    if (!laudo || !laudo.arquivo_path) {
      return res.status(404).json({ ok: false, message: "Arquivo do documento não encontrado no sistema." });
    }

    const fullDiskPath = path.join(UPLOAD_LAUDOS_DIR, laudo.arquivo_path);
    if (!fs.existsSync(fullDiskPath)) {
      return res.status(404).json({ ok: false, message: "Arquivo físico não localizado no servidor." });
    }

    // 3. Lê o arquivo criptografado do disco e descriptografa com AES-256-GCM
    const packedEncryptedBuffer = fs.readFileSync(fullDiskPath);
    const decryptedPdfBuffer = decryptDocumentBuffer(packedEncryptedBuffer);

    // 4. Aplica criptografia padrão PDF com a senha pessoal do usuário logado
    const protectedPdfBuffer = protectPdfBufferWithPassword(decryptedPdfBuffer, senha);

    // 5. Registra log de auditoria oficial LGPD
    await pool.query(`
      INSERT INTO aee_laudos_logs (laudo_id, aluno_id, usuario_id, escola_id, acao, detalhes, ip)
      VALUES (?, ?, ?, ?, 'download_pdf_protegido', ?, ?)
    `, [
      laudoId, laudo.aluno_id, usuarioId, escola_id,
      `Download de PDF protegido com a senha pessoal de ${usuario.nome}`,
      req.ip || "127.0.0.1"
    ]).catch(() => {});

    const safeTitle = (laudo.titulo || laudo.tipo_documento || "Documento_AEE")
      .replace(/[^a-zA-Z0-9_-]/g, "_");
    const downloadFileName = `Dossie_AEE_${safeTitle}_${laudo.aluno_id}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName}"`);
    res.setHeader("Content-Length", protectedPdfBuffer.length);

    return res.send(protectedPdfBuffer);
  } catch (err) {
    console.error("[sala_recursos.laudos.download_protegido] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao gerar PDF protegido: " + err.message });
  }
});

// Visualização Segura Inline (Descriptografa em memória para o Modal após validar senha)
router.post("/laudos/:id/visualizar-seguro", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const usuarioId = req.user.usuario_id || req.user.id || 0;
    const laudoId = Number(req.params.id);
    const { senha } = req.body;

    if (!senha || typeof senha !== "string" || !senha.trim()) {
      return res.status(400).json({ ok: false, message: "A confirmação da sua senha de login é obrigatória para visualizar este documento sigiloso." });
    }

    const [[usuario]] = await pool.query(
      `SELECT id, nome, senha_hash FROM usuarios WHERE id = ? LIMIT 1`,
      [Number(usuarioId)]
    );

    if (!usuario || !usuario.senha_hash) {
      return res.status(401).json({ ok: false, message: "Usuário não autenticado." });
    }

    const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaCorreta) {
      return res.status(401).json({ ok: false, message: "Senha incorreta. Acesso negado." });
    }

    const [[laudo]] = await pool.query(
      `SELECT * FROM aee_laudos WHERE id = ? AND escola_id = ? LIMIT 1`,
      [laudoId, escola_id]
    );

    if (!laudo || !laudo.arquivo_path) {
      return res.status(404).json({ ok: false, message: "Documento sem anexo digital." });
    }

    const fullDiskPath = path.join(UPLOAD_LAUDOS_DIR, laudo.arquivo_path);
    if (!fs.existsSync(fullDiskPath)) {
      return res.status(404).json({ ok: false, message: "Arquivo físico não localizado." });
    }

    const packedEncryptedBuffer = fs.readFileSync(fullDiskPath);
    const decryptedPdfBuffer = decryptDocumentBuffer(packedEncryptedBuffer);

    // Registra log de auditoria
    await pool.query(`
      INSERT INTO aee_laudos_logs (laudo_id, aluno_id, usuario_id, escola_id, acao, detalhes, ip)
      VALUES (?, ?, ?, ?, 'visualizacao_segura', ?, ?)
    `, [
      laudoId, laudo.aluno_id, usuarioId, escola_id,
      `Visualização em tela por ${usuario.nome}`,
      req.ip || "127.0.0.1"
    ]).catch(() => {});

    const base64Data = decryptedPdfBuffer.toString("base64");
    return res.json({
      ok: true,
      mime: "application/pdf",
      dataUrl: `data:application/pdf;base64,${base64Data}`,
      filename: laudo.arquivo_nome_original || "documento.pdf"
    });
  } catch (err) {
    console.error("[sala_recursos.laudos.visualizar_seguro] Erro:", err);
    return res.status(500).json({ ok: false, message: "Erro ao descriptografar documento: " + err.message });
  }
});

// Logs de Auditoria LGPD de um Laudo / Documento
router.get("/laudos/:id/logs", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const laudoId = Number(req.params.id);

    const [logs] = await pool.query(`
      SELECT 
        l.id, l.acao, l.detalhes, l.ip,
        DATE_FORMAT(l.criado_em, '%d/%m/%Y %H:%i:%s') AS criado_em,
        u.nome AS usuario_nome, u.perfil AS usuario_perfil
      FROM aee_laudos_logs l
      LEFT JOIN usuarios u ON u.id = l.usuario_id
      WHERE l.laudo_id = ? AND l.escola_id = ?
      ORDER BY l.id DESC
      LIMIT 50
    `, [laudoId, escola_id]);

    return res.json({ ok: true, logs });
  } catch (err) {
    console.error("[sala_recursos.laudos.logs] Erro:", err);
    return res.status(500).json({ message: "Erro ao buscar logs de auditoria." });
  }
});

// Exclusão de Laudo / Documento
router.delete("/laudos/:id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const usuarioId = req.user.usuario_id || req.user.id || 0;
    const laudoId = Number(req.params.id);

    const [[laudo]] = await pool.query(
      `SELECT * FROM aee_laudos WHERE id = ? AND escola_id = ? LIMIT 1`,
      [laudoId, escola_id]
    );

    if (laudo && laudo.arquivo_path) {
      const fullDiskPath = path.join(UPLOAD_LAUDOS_DIR, laudo.arquivo_path);
      if (fs.existsSync(fullDiskPath)) {
        try { fs.unlinkSync(fullDiskPath); } catch (_) {}
      }
    }

    await pool.query(`
      DELETE FROM aee_laudos WHERE id = ? AND escola_id = ?
    `, [laudoId, escola_id]);

    if (laudo) {
      await pool.query(`
        INSERT INTO aee_laudos_logs (laudo_id, aluno_id, usuario_id, escola_id, acao, detalhes, ip)
        VALUES (?, ?, ?, ?, 'exclusao_documento', 'Documento removido da base', ?)
      `, [laudoId, laudo.aluno_id, usuarioId, escola_id, req.ip || "127.0.0.1"]).catch(() => {});
    }

    return res.json({ ok: true, message: "Documento/Laudo removido com sucesso." });
  } catch (err) {
    console.error("[sala_recursos.laudos.delete] Erro:", err);
    return res.status(500).json({ message: "Erro ao remover laudo." });
  }
});

// ─── 6. CRUD DE ADEQUAÇÕES CURRICULARES ─────────────────────────────────────────
router.get("/adequacoes", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { aluno_id, ano_letivo, bimestre, disciplina, turma_id } = req.query;

    const where = ["ac.escola_id = ?"];
    const params = [escola_id];

    if (aluno_id) {
      where.push("ac.aluno_id = ?");
      params.push(Number(aluno_id));
    }

    if (ano_letivo) {
      where.push("ac.ano_letivo = ?");
      params.push(Number(ano_letivo));
    }

    if (bimestre) {
      where.push("ac.bimestre = ?");
      params.push(bimestre);
    }

    if (disciplina) {
      where.push("ac.disciplina = ?");
      params.push(disciplina);
    }

    if (turma_id) {
      where.push("m.turma_id = ?");
      params.push(Number(turma_id));
    }

    const [rows] = await pool.query(`
      SELECT 
        ac.*,
        a.estudante AS aluno_nome,
        a.codigo AS aluno_codigo,
        a.foto AS aluno_foto,
        t.nome AS turma_nome,
        t.turno AS turma_turno
      FROM aee_adequacoes_curriculares ac
      INNER JOIN alunos a ON a.id = ac.aluno_id
      LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = ac.escola_id AND m.ano_letivo = ac.ano_letivo
      LEFT JOIN turmas t ON t.id = m.turma_id
      WHERE ${where.join(" AND ")}
      ORDER BY ac.ano_letivo DESC, ac.bimestre ASC, a.estudante ASC
    `, params);

    return res.json({ adequacoes: rows, total: rows.length });
  } catch (err) {
    console.error("[sala_recursos.adequacoes.get] Erro:", err);
    return res.status(500).json({ message: "Erro ao listar adequações curriculares." });
  }
});

router.get("/adequacoes/:id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const id = Number(req.params.id);

    const [[row]] = await pool.query(`
      SELECT 
        ac.*,
        a.estudante AS aluno_nome,
        a.codigo AS aluno_codigo,
        DATE_FORMAT(a.data_nascimento, '%Y-%m-%d') AS aluno_nascimento,
        t.nome AS turma_nome,
        t.turno AS turma_turno
      FROM aee_adequacoes_curriculares ac
      INNER JOIN alunos a ON a.id = ac.aluno_id
      LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = ac.escola_id AND m.ano_letivo = ac.ano_letivo
      LEFT JOIN turmas t ON t.id = m.turma_id
      WHERE ac.id = ? AND ac.escola_id = ?
      LIMIT 1
    `, [id, escola_id]);

    if (!row) {
      return res.status(404).json({ message: "Adequação curricular não encontrada." });
    }

    return res.json(row);
  } catch (err) {
    console.error("[sala_recursos.adequacoes.id] Erro:", err);
    return res.status(500).json({ message: "Erro ao obter adequação curricular." });
  }
});

router.post("/adequacoes", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const usuarioId = req.user.id || null;
    const {
      id,
      aluno_id,
      ano_letivo,
      bimestre,
      disciplina,
      disciplina_id,
      professor_regente,
      professor_aee,
      habilidades_prioritarias,
      metodologias_estrategias,
      recursos_didaticos,
      avaliacao_adaptada,
      parecer_conclusivo,
      status = "concluido"
    } = req.body;

    if (!aluno_id || !bimestre || !disciplina) {
      return res.status(400).json({ message: "Aluno, bimestre e disciplina são campos obrigatórios." });
    }

    const ano = Number(ano_letivo) || anoLetivoPadrao();

    // Verifica se já existe por ID ou pela chave única (aluno_id, escola_id, ano_letivo, bimestre, disciplina)
    let targetId = id ? Number(id) : null;
    if (!targetId) {
      const [[existing]] = await pool.query(`
        SELECT id FROM aee_adequacoes_curriculares
        WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ? AND bimestre = ? AND disciplina = ?
        LIMIT 1
      `, [Number(aluno_id), escola_id, ano, bimestre, disciplina]);
      if (existing) targetId = existing.id;
    }

    if (targetId) {
      await pool.query(`
        UPDATE aee_adequacoes_curriculares
        SET 
          disciplina_id = ?,
          professor_regente = ?,
          professor_aee = ?,
          habilidades_prioritarias = ?,
          metodologias_estrategias = ?,
          recursos_didaticos = ?,
          avaliacao_adaptada = ?,
          parecer_conclusivo = ?,
          status = ?
        WHERE id = ? AND escola_id = ?
      `, [
        disciplina_id ? Number(disciplina_id) : null,
        professor_regente || null,
        professor_aee || null,
        habilidades_prioritarias || null,
        metodologias_estrategias || null,
        recursos_didaticos || null,
        avaliacao_adaptada || null,
        parecer_conclusivo || null,
        status || "concluido",
        targetId,
        escola_id
      ]);

      return res.json({ ok: true, id: targetId, message: "Adequação curricular atualizada com sucesso!" });
    }

    const [result] = await pool.query(`
      INSERT INTO aee_adequacoes_curriculares (
        aluno_id, escola_id, ano_letivo, bimestre, disciplina, disciplina_id,
        professor_regente, professor_aee, habilidades_prioritarias,
        metodologias_estrategias, recursos_didaticos, avaliacao_adaptada,
        parecer_conclusivo, status, criado_por
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      Number(aluno_id), escola_id, ano, bimestre, disciplina,
      disciplina_id ? Number(disciplina_id) : null, professor_regente || null,
      professor_aee || null, habilidades_prioritarias || null,
      metodologias_estrategias || null, recursos_didaticos || null,
      avaliacao_adaptada || null, parecer_conclusivo || null, status, usuarioId
    ]);

    return res.status(201).json({
      ok: true,
      id: result.insertId,
      message: "Adequação curricular registrada com sucesso!"
    });
  } catch (err) {
    console.error("[sala_recursos.adequacoes.post] Erro:", err);
    return res.status(500).json({ message: "Erro ao salvar adequação curricular." });
  }
});

router.put("/adequacoes/:id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const id = Number(req.params.id);
    const {
      bimestre,
      disciplina,
      disciplina_id,
      professor_regente,
      professor_aee,
      habilidades_prioritarias,
      metodologias_estrategias,
      recursos_didaticos,
      avaliacao_adaptada,
      parecer_conclusivo,
      status
    } = req.body;

    await pool.query(`
      UPDATE aee_adequacoes_curriculares
      SET 
        bimestre = ?, disciplina = ?, disciplina_id = ?, professor_regente = ?,
        professor_aee = ?, habilidades_prioritarias = ?, metodologias_estrategias = ?,
        recursos_didaticos = ?, avaliacao_adaptada = ?, parecer_conclusivo = ?, status = ?
      WHERE id = ? AND escola_id = ?
    `, [
      bimestre, disciplina, disciplina_id ? Number(disciplina_id) : null,
      professor_regente || null, professor_aee || null, habilidades_prioritarias || null,
      metodologias_estrategias || null, recursos_didaticos || null,
      avaliacao_adaptada || null, parecer_conclusivo || null, status || "concluido",
      id, escola_id
    ]);

    return res.json({ ok: true, message: "Adequação curricular atualizada com sucesso!" });
  } catch (err) {
    console.error("[sala_recursos.adequacoes.put] Erro:", err);
    return res.status(500).json({ message: "Erro ao atualizar adequação curricular." });
  }
});

router.delete("/adequacoes/:id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const id = Number(req.params.id);

    await pool.query(`
      DELETE FROM aee_adequacoes_curriculares WHERE id = ? AND escola_id = ?
    `, [id, escola_id]);

    return res.json({ ok: true, message: "Adequação curricular removida com sucesso." });
  } catch (err) {
    console.error("[sala_recursos.adequacoes.delete] Erro:", err);
    return res.status(500).json({ message: "Erro ao remover adequação curricular." });
  }
});

// ─── 7. GERAÇÃO DE PDF DA ADEQUAÇÃO CURRICULAR ────────────────────────────────
router.get("/adequacoes/:id/pdf", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const id = Number(req.params.id);

    const pdfBuffer = await gerarPdfAdequacaoCurricular(id, escola_id);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Adequacao_Curricular_${id}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error("[sala_recursos.adequacoes.pdf] Erro:", err);
    return res.status(500).json({ message: "Erro ao gerar PDF da adequação curricular: " + err.message });
  }
});

// ─── 7.1 GERAÇÃO DE PDF PADRÃO SEEDF (FICHA OFICIAL / EM BRANCO OU PREENCHIDA) ──
router.get("/pdf/adequacao-seedf", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const {
      aluno_id,
      adequacao_id,
      ano_letivo,
      bimestre,
      disciplina,
      professor_regente,
      em_branco
    } = req.query;

    const isEmBranco = em_branco === "1" || em_branco === "true";

    const pdfBuffer = await gerarPdfAdequacaoSEEDF({
      escolaId: escola_id,
      alunoId: aluno_id ? Number(aluno_id) : null,
      adequacaoId: adequacao_id ? Number(adequacao_id) : null,
      anoLetivo: Number(ano_letivo) || anoLetivoPadrao(),
      bimestre: bimestre || "",
      disciplina: disciplina || "",
      professorRegente: professor_regente || "",
      emBranco: isEmBranco,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="Adequacao_SEEDF_${isEmBranco ? "Modelo_Em_Branco" : (aluno_id || "Geral")}.pdf"`
    );
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error("[sala_recursos.pdf.adequacao-seedf] Erro:", err);
    return res.status(500).json({ message: "Erro ao gerar PDF da ficha SEEDF: " + err.message });
  }
});

// ─── 7.2 GERAÇÃO DE PDF DE PRONTUÁRIO INTEGRADO AEE ──────────────────────────
router.get("/pdf/prontuario/:aluno_id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const alunoId = Number(req.params.aluno_id);
    const ano = Number(req.query.ano_letivo) || anoLetivoPadrao();

    const pdfBuffer = await gerarPdfProntuarioAEE(alunoId, escola_id, ano);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Prontuario_AEE_Aluno_${alunoId}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error("[sala_recursos.pdf.prontuario] Erro:", err);
    return res.status(500).json({ message: "Erro ao gerar Prontuário AEE: " + err.message });
  }
});

// ─── 8. PDI (PLANO DE DESENVOLVIMENTO INDIVIDUAL) ─────────────────────────────
router.get("/pdi/:aluno_id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const alunoId = Number(req.params.aluno_id);
    const ano = Number(req.query.ano_letivo) || anoLetivoPadrao();

    const [[pdi]] = await pool.query(`
      SELECT * FROM aee_pdi WHERE aluno_id = ? AND escola_id = ? AND ano_letivo = ? LIMIT 1
    `, [alunoId, escola_id, ano]);

    return res.json({ pdi: pdi || null });
  } catch (err) {
    console.error("[sala_recursos.pdi.get] Erro:", err);
    return res.status(500).json({ message: "Erro ao obter PDI do aluno." });
  }
});

router.post("/pdi/:aluno_id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const alunoId = Number(req.params.aluno_id);
    const {
      ano_letivo,
      diagnostico_pedagogico,
      objetivos_gerais,
      cronograma_atendimento,
      acoes_escola,
      acoes_familia,
      recursos_acessibilidade,
      status = "ativo"
    } = req.body;

    const ano = Number(ano_letivo) || anoLetivoPadrao();

    await pool.query(`
      INSERT INTO aee_pdi (
        aluno_id, escola_id, ano_letivo, diagnostico_pedagogico, objetivos_gerais,
        cronograma_atendimento, acoes_escola, acoes_familia, recursos_acessibilidade, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        diagnostico_pedagogico = VALUES(diagnostico_pedagogico),
        objetivos_gerais = VALUES(objetivos_gerais),
        cronograma_atendimento = VALUES(cronograma_atendimento),
        acoes_escola = VALUES(acoes_escola),
        acoes_familia = VALUES(acoes_familia),
        recursos_acessibilidade = VALUES(recursos_acessibilidade),
        status = VALUES(status)
    `, [
      alunoId, escola_id, ano, diagnostico_pedagogico || null,
      objetivos_gerais || null, cronograma_atendimento || null,
      acoes_escola || null, acoes_familia || null,
      recursos_acessibilidade || null, status
    ]);

    return res.json({ ok: true, message: "PDI salvo com sucesso!" });
  } catch (err) {
    console.error("[sala_recursos.pdi.post] Erro:", err);
    return res.status(500).json({ message: "Erro ao salvar PDI do aluno." });
  }
});

// ─── 9. ATENDIMENTOS / DIÁRIO DE SESSÕES ─────────────────────────────────────
router.get("/atendimentos", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const { aluno_id, data_inicio, data_fim, limit = 100 } = req.query;

    const where = ["aa.escola_id = ?"];
    const params = [escola_id];

    if (aluno_id) {
      where.push("aa.aluno_id = ?");
      params.push(Number(aluno_id));
    }

    if (data_inicio) {
      where.push("aa.data_atendimento >= ?");
      params.push(data_inicio);
    }

    if (data_fim) {
      where.push("aa.data_atendimento <= ?");
      params.push(data_fim);
    }

    const [rows] = await pool.query(`
      SELECT 
        aa.id,
        aa.aluno_id,
        a.estudante AS aluno_nome,
        a.codigo AS aluno_codigo,
        t.nome AS turma_nome,
        DATE_FORMAT(aa.data_atendimento, '%Y-%m-%d') AS data_atendimento,
        aa.horario_inicio,
        aa.horario_fim,
        aa.presenca,
        aa.tipo_sessao,
        aa.atividades_realizadas,
        aa.evolucao_observacoes,
        aa.registrado_por,
        aa.criado_em
      FROM aee_atendimentos aa
      INNER JOIN alunos a ON a.id = aa.aluno_id
      LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.escola_id = aa.escola_id
      LEFT JOIN turmas t ON t.id = m.turma_id
      WHERE ${where.join(" AND ")}
      GROUP BY aa.id
      ORDER BY aa.data_atendimento DESC, aa.id DESC
      LIMIT ?
    `, [...params, Number(limit)]);

    return res.json({ atendimentos: rows, total: rows.length });
  } catch (err) {
    console.error("[sala_recursos.atendimentos.get] Erro:", err);
    return res.status(500).json({ message: "Erro ao listar atendimentos da Sala de Recursos." });
  }
});

router.post("/atendimentos", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const {
      aluno_id,
      data_atendimento,
      horario_inicio,
      horario_fim,
      presenca = 1,
      tipo_sessao = "Individual",
      atividades_realizadas,
      evolucao_observacoes,
      registrado_por
    } = req.body;

    if (!aluno_id || !data_atendimento) {
      return res.status(400).json({ message: "Aluno e data do atendimento são obrigatórios." });
    }

    const [result] = await pool.query(`
      INSERT INTO aee_atendimentos (
        aluno_id, escola_id, data_atendimento, horario_inicio, horario_fim,
        presenca, tipo_sessao, atividades_realizadas, evolucao_observacoes, registrado_por
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      Number(aluno_id), escola_id, data_atendimento, horario_inicio || null,
      horario_fim || null, Number(presenca) ? 1 : 0, tipo_sessao || "Individual",
      atividades_realizadas || null, evolucao_observacoes || null, registrado_por || null
    ]);

    return res.status(201).json({ ok: true, id: result.insertId, message: "Atendimento registrado com sucesso!" });
  } catch (err) {
    console.error("[sala_recursos.atendimentos.post] Erro:", err);
    return res.status(500).json({ message: "Erro ao registrar atendimento." });
  }
});

router.delete("/atendimentos/:id", verificarEscola, async (req, res) => {
  try {
    const { escola_id } = req.user;
    const id = Number(req.params.id);

    await pool.query(`DELETE FROM aee_atendimentos WHERE id = ? AND escola_id = ?`, [id, escola_id]);

    return res.json({ ok: true, message: "Registro de atendimento removido com sucesso." });
  } catch (err) {
    console.error("[sala_recursos.atendimentos.delete] Erro:", err);
    return res.status(500).json({ message: "Erro ao remover atendimento." });
  }
});

export default router;
