// ============================================================================
// GABARITO LOTES — Upload em lote por turma + Correção individual
// ============================================================================
// Fluxo:
//   1) Coordenador seleciona avaliação + faz upload de pasta (N arquivos JPG)
//   2) Backend envia arquivos ao DigitalOcean Spaces + registra lote no BD
//   3) Rota /processar-qr baixa arquivo do Spaces, lê QR Code → identifica alunos
//   4) Professor vê lista de alunos, clica CORRIGIR → OMR + salva resultado
// ============================================================================

import { Router } from "express";
import QRCode from "qrcode";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import FormData from "form-data";
import fetch from "node-fetch";
import pool from "../db.js";
import { uploadFileBufferToSpaces, downloadBufferFromSpaces } from "../storage/spacesUpload.js";

const router = Router();

// ─── Diretório base do backend (relativo a este arquivo) ────────────────────
const __filename_route = fileURLToPath(import.meta.url);
const __dirname_route = path.dirname(__filename_route);
const BACKEND_ROOT = path.resolve(__dirname_route, ".."); // apps/educa-backend

console.log("[gabaritoLotes] BACKEND_ROOT =", BACKEND_ROOT);
console.log("[gabaritoLotes] Armazenamento: DigitalOcean Spaces");

// ─── Helper: resolve objectKey (Spaces) ou arquivo_path (legado disco) ───
// Registros antigos (BD): "uploads/gabaritos/1/xxxx.JPG" → path no disco (legado)
// Registros novos (BD):   "uploads/CEF04_PLAN/gabaritos/1/xxxx.JPG" → objectKey no Spaces
function isSpacesKey(arquivoPath) {
  // Se começa com http, é URL completa do Spaces
  if (arquivoPath && arquivoPath.startsWith("http")) return true;
  return false;
}

function resolveArquivoPath(arquivoPath) {
  if (path.isAbsolute(arquivoPath)) return arquivoPath;
  return path.join(BACKEND_ROOT, arquivoPath);
}

// ─── Helper: obter apelido da escola no BD ─────────────────────────────────
async function getEscolaApelido(escolaId) {
  const [[row]] = await pool.query(
    "SELECT apelido FROM escolas WHERE id = ? LIMIT 1",
    [escolaId]
  );
  return row?.apelido || `escola_${escolaId}`;
}

// ─── Configuração do Multer (memoryStorage → envia para Spaces) ─────────────
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".pdf"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB por arquivo
});

// ─── Middleware ────────────────────────────────────────────────────────────────
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ error: "Acesso negado: escola não definida." });
  }
  next();
}

// ─── POST /api/gabarito-lotes/upload ─────────────────────────────────────────
// Recebe N arquivos + avaliacao_id + turma_nome
// Cria o lote + registra cada arquivo
router.post("/upload", verificarEscola, upload.array("files", 100), async (req, res) => {
  const { escola_id } = req.user;
  const userId = req.user.id || req.user.userId;
  const { avaliacao_id, turma_nome } = req.body;

  if (!avaliacao_id || !turma_nome) {
    return res.status(400).json({ error: "avaliacao_id e turma_nome são obrigatórios." });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Nenhum arquivo enviado." });
  }

  try {
    // Verificar se avaliação existe e pertence à escola
    const [avRows] = await pool.query(
      "SELECT id FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?",
      [avaliacao_id, escola_id]
    );
    if (avRows.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    // Criar ou atualizar o lote (UPSERT)
    const [loteResult] = await pool.query(
      `INSERT INTO gabarito_lotes (avaliacao_id, escola_id, turma_nome, total_arquivos, criado_por)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         total_arquivos = total_arquivos + VALUES(total_arquivos),
         updated_at = CURRENT_TIMESTAMP`,
      [avaliacao_id, escola_id, turma_nome.trim(), req.files.length, userId]
    );
    const loteId = loteResult.insertId || loteResult.insertId;

    // Se foi UPSERT (update), precisamos pegar o ID existente
    let finalLoteId = loteId;
    if (!finalLoteId || finalLoteId === 0) {
      const [existing] = await pool.query(
        `SELECT id FROM gabarito_lotes WHERE avaliacao_id = ? AND turma_nome = ? AND escola_id = ?`,
        [avaliacao_id, turma_nome.trim(), escola_id]
      );
      finalLoteId = existing[0]?.id;
    }

    // Registrar cada arquivo — upload para DigitalOcean Spaces
    const escolaApelido = await getEscolaApelido(escola_id);
    const arquivos = [];
    for (const file of req.files) {
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
      const filename = `${Date.now()}_${base}${ext}`;
      const objectKey = `uploads/${escolaApelido}/gabaritos/${finalLoteId}/${filename}`;

      // Detectar MIME type
      const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".pdf": "application/pdf" };
      const contentType = mimeMap[ext.toLowerCase()] || "application/octet-stream";

      // Upload para Spaces
      const uploaded = await uploadFileBufferToSpaces({
        buffer: file.buffer,
        contentType,
        objectKey,
      });

      const [arqResult] = await pool.query(
        `INSERT INTO gabarito_arquivos (lote_id, escola_id, arquivo_nome, arquivo_path)
         VALUES (?, ?, ?, ?)`,
        [finalLoteId, escola_id, file.originalname, objectKey]
      );
      arquivos.push({
        id: arqResult.insertId,
        arquivo_nome: file.originalname,
        arquivo_path: objectKey,
        spaces_url: uploaded.publicUrl,
        status: "pendente",
      });
    }

    res.status(201).json({
      success: true,
      lote_id: finalLoteId,
      turma_nome: turma_nome.trim(),
      total_arquivos: req.files.length,
      arquivos,
    });
  } catch (err) {
    console.error("Erro ao criar lote:", err);
    res.status(500).json({ error: "Erro ao processar upload." });
  }
});

// ─── POST /api/gabarito-lotes/:id/processar-qr ──────────────────────────────
// Lê o QR Code de cada arquivo do lote via serviço OMR Python
// Identifica os alunos e atualiza gabarito_arquivos
router.post("/:id/processar-qr", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const loteId = req.params.id;

  try {
    // Buscar arquivos pendentes do lote
    const [arquivos] = await pool.query(
      `SELECT id, arquivo_path, arquivo_nome FROM gabarito_arquivos
       WHERE lote_id = ? AND escola_id = ? AND status = 'pendente'`,
      [loteId, escola_id]
    );

    if (arquivos.length === 0) {
      return res.json({ processados: 0, message: "Todos os arquivos já foram processados." });
    }

    const OMR_URL = process.env.OMR_URL || "http://localhost:8500";
    const resultados = [];

    // Verificar se o OMR está disponível antes de processar
    try {
      const healthResp = await fetch(`${OMR_URL}/health`, { timeout: 3000 });
      if (!healthResp.ok) throw new Error("OMR health check falhou");
    } catch (omrErr) {
      console.error(`[processar-qr] OMR indisponível em ${OMR_URL}:`, omrErr.code || omrErr.message);
      return res.status(503).json({
        error: "Serviço de correção OMR indisponível. O serviço Python (educa-omr) não está rodando.",
        detail: `OMR_URL=${OMR_URL}, erro=${omrErr.code || omrErr.message}`,
      });
    }

    for (const arq of arquivos) {
      try {
        // Baixar arquivo do Spaces (ou disco legado)
        let fileBuffer;
        try {
          if (isSpacesKey(arq.arquivo_path) || arq.arquivo_path.match(/^uploads\/[A-Z]/)) {
            console.log(`[processar-qr] arq ${arq.id}: baixando do Spaces key="${arq.arquivo_path}"`);
            const downloaded = await downloadBufferFromSpaces(arq.arquivo_path);
            fileBuffer = downloaded.buffer;
          } else {
            const filePath = resolveArquivoPath(arq.arquivo_path);
            console.log(`[processar-qr] arq ${arq.id}: lendo do disco path="${filePath}" exists=${fs.existsSync(filePath)}`);
            if (!fs.existsSync(filePath)) {
              await pool.query(
                `UPDATE gabarito_arquivos SET status = 'erro' WHERE id = ?`,
                [arq.id]
              );
              resultados.push({ id: arq.id, status: "erro", error: `Arquivo não encontrado (legado disco): ${arq.arquivo_path}` });
              continue;
            }
            fileBuffer = fs.readFileSync(filePath);
          }
        } catch (dlErr) {
          await pool.query(
            `UPDATE gabarito_arquivos SET status = 'erro' WHERE id = ?`,
            [arq.id]
          );
          resultados.push({ id: arq.id, status: "erro", error: `Erro ao obter arquivo: ${dlErr.message}` });
          continue;
        }

        // 1. Crop (alinhamento)
        const formCrop = new FormData();
        formCrop.append("file", fileBuffer, { filename: arq.arquivo_nome });

        const respCrop = await fetch(`${OMR_URL}/crop-gabarito`, {
          method: "POST",
          body: formCrop,
          headers: formCrop.getHeaders(),
        });

        if (!respCrop.ok) {
          await pool.query(
            `UPDATE gabarito_arquivos SET status = 'erro' WHERE id = ?`,
            [arq.id]
          );
          resultados.push({ id: arq.id, status: "erro", error: "Falha no crop" });
          continue;
        }

        const cropBuffer = Buffer.from(await respCrop.arrayBuffer());

        // 2. Ler bolhas + QR Code
        const formBolhas = new FormData();
        formBolhas.append("file", cropBuffer, { filename: "crop.png" });

        const respBolhas = await fetch(`${OMR_URL}/corrigir-bolhas`, {
          method: "POST",
          body: formBolhas,
          headers: formBolhas.getHeaders(),
        });

        if (!respBolhas.ok) {
          await pool.query(
            `UPDATE gabarito_arquivos SET status = 'erro' WHERE id = ?`,
            [arq.id]
          );
          resultados.push({ id: arq.id, status: "erro", error: "Falha na leitura de bolhas" });
          continue;
        }

        const bolhasData = await respBolhas.json();
        const qrData = bolhasData.qrData || null;
        const codigoAluno = qrData?.c || null;

        // Buscar nome do aluno no banco se temos o código
        let nomeAluno = null;
        let turmaId = qrData?.t || null;
        if (codigoAluno) {
          const [alunoRows] = await pool.query(
            "SELECT estudante, id FROM alunos WHERE codigo = ? AND escola_id = ?",
            [codigoAluno, escola_id]
          );
          if (alunoRows.length > 0) {
            nomeAluno = alunoRows[0].estudante;
          }
        }

        // Atualizar arquivo no BD
        await pool.query(
          `UPDATE gabarito_arquivos SET
            status = 'identificado',
            codigo_aluno = ?,
            nome_aluno = ?,
            turma_id = ?,
            qr_data = ?,
            respostas_aluno = ?
          WHERE id = ?`,
          [
            codigoAluno,
            nomeAluno,
            turmaId,
            qrData ? JSON.stringify(qrData) : null,
            bolhasData.respostas ? JSON.stringify(bolhasData.respostas) : null,
            arq.id,
          ]
        );

        resultados.push({
          id: arq.id,
          status: "identificado",
          codigo_aluno: codigoAluno,
          nome_aluno: nomeAluno,
          respostas: bolhasData.respostas,
        });
      } catch (innerErr) {
        console.error(`Erro processando arquivo ${arq.id}:`, innerErr.message);
        await pool.query(
          `UPDATE gabarito_arquivos SET status = 'erro' WHERE id = ?`,
          [arq.id]
        );
        resultados.push({ id: arq.id, status: "erro", error: innerErr.message });
      }
    }

    res.json({
      processados: resultados.length,
      identificados: resultados.filter(r => r.status === "identificado").length,
      erros: resultados.filter(r => r.status === "erro").length,
      resultados,
    });
  } catch (err) {
    console.error("Erro ao processar QR do lote:", err);
    res.status(500).json({ error: "Erro ao processar arquivos." });
  }
});

// ─── PUT /api/gabarito-lotes/:id/vincular-professor ──────────────────────────
// Vincula um corretor (professor ou outro usuário) ao lote (turma)
// Aceita professor_id (tabela professores) — busca nome em professores
// Se o professor_id não for encontrado na tabela professores, tenta em usuarios
// BLOQUEADO se a avaliação já teve notas importadas (status = notas_importadas)
router.put("/:id/vincular-professor", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const loteId = req.params.id;
  const { professor_id } = req.body;

  if (!professor_id) {
    return res.status(400).json({ error: "professor_id é obrigatório." });
  }

  try {
    // Verificar se a avaliação vinculada já teve notas importadas
    const [[loteRow]] = await pool.query(
      `SELECT l.id, a.status AS avaliacao_status, a.id AS avaliacao_id
       FROM gabarito_lotes l
       JOIN gabarito_avaliacoes a ON a.id = l.avaliacao_id
       WHERE l.id = ? AND l.escola_id = ?`,
      [loteId, escola_id]
    );

    if (!loteRow) {
      return res.status(404).json({ error: "Lote não encontrado." });
    }

    if (loteRow.avaliacao_status === "notas_importadas") {
      return res.status(409).json({
        error: "Não é possível vincular um corretor após a importação das notas. As notas desta avaliação já foram enviadas ao diário dos professores.",
        codigo: "NOTAS_JA_IMPORTADAS",
      });
    }

    const [result] = await pool.query(
      "UPDATE gabarito_lotes SET professor_id = ? WHERE id = ? AND escola_id = ?",
      [professor_id, loteId, escola_id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Lote não encontrado." });
    }

    // Buscar nome: primeiro tenta na tabela professores, depois em usuarios
    let nome = "";
    const [profRows] = await pool.query("SELECT nome FROM professores WHERE id = ?", [professor_id]);
    if (profRows[0]?.nome) {
      nome = profRows[0].nome;
    } else {
      const [userRows] = await pool.query("SELECT nome FROM usuarios WHERE id = ?", [professor_id]);
      nome = userRows[0]?.nome || "";
    }

    res.json({ ok: true, professor_id, professor_nome: nome });
  } catch (err) {
    console.error("Erro ao vincular professor:", err);
    res.status(500).json({ error: "Erro ao vincular professor." });
  }
});

// ─── GET /api/gabarito-lotes?avaliacao_id=X ──────────────────────────────────
// Lista todos os lotes de uma avaliação (inclui professor vinculado)
router.get("/", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const { avaliacao_id } = req.query;

  try {
    let sql = `
      SELECT l.*,
        l.professor_id,
        COALESCE(p.nome, u.nome) AS professor_nome,
        (SELECT COUNT(*) FROM gabarito_arquivos a WHERE a.lote_id = l.id) as total_arquivos_real,
        (SELECT COUNT(*) FROM gabarito_arquivos a WHERE a.lote_id = l.id AND a.status = 'corrigido') as total_corrigidos_real,
        (SELECT COUNT(*) FROM gabarito_arquivos a WHERE a.lote_id = l.id AND a.status = 'identificado') as total_identificados,
        (SELECT COUNT(*) FROM gabarito_arquivos a WHERE a.lote_id = l.id AND a.status = 'erro') as total_erros,
        (SELECT COUNT(*) FROM gabarito_ajustes_manuais m
         JOIN gabarito_arquivos a2 ON a2.id = m.arquivo_id
         WHERE a2.lote_id = l.id AND m.status = 'pendente') as ajustes_pendentes
      FROM gabarito_lotes l
      LEFT JOIN professores p ON p.id = l.professor_id
      LEFT JOIN usuarios u ON u.id = l.professor_id
      WHERE l.escola_id = ?
    `;
    const params = [escola_id];

    if (avaliacao_id) {
      sql += " AND l.avaliacao_id = ?";
      params.push(avaliacao_id);
    }

    sql += " ORDER BY l.created_at DESC";
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar lotes:", err);
    res.status(500).json({ error: "Erro ao listar lotes." });
  }
});

// ─── GET /api/gabarito-lotes/:id/arquivos ────────────────────────────────────
// Lista todos os arquivos (alunos identificados) de um lote
router.get("/:id/arquivos", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const loteId = req.params.id;

  try {
    const [arquivos] = await pool.query(
      `SELECT a.id, a.arquivo_nome, a.arquivo_path, a.codigo_aluno, a.nome_aluno,
              a.turma_id, a.status, a.qr_data, a.respostas_aluno, a.acertos, a.nota,
              a.corrigido_em, a.corrigido_por,
              (SELECT COUNT(*) FROM gabarito_ajustes_manuais m WHERE m.arquivo_id = a.id AND m.status = 'pendente') as ajustes_pendentes
       FROM gabarito_arquivos a
       WHERE a.lote_id = ? AND a.escola_id = ?
       ORDER BY a.nome_aluno ASC, a.arquivo_nome ASC`,
      [loteId, escola_id]
    );

    // Parse JSON
    const parsed = arquivos.map(a => ({
      ...a,
      qr_data: safeJson(a.qr_data),
      respostas_aluno: safeJson(a.respostas_aluno),
    }));

    res.json(parsed);
  } catch (err) {
    console.error("Erro ao listar arquivos do lote:", err);
    res.status(500).json({ error: "Erro ao listar arquivos." });
  }
});

// ─── POST /api/gabarito-lotes/arquivos/:id/corrigir ──────────────────────────
// Corrige um arquivo específico (compara com gabarito oficial) e salva resultado
router.post("/arquivos/:id/corrigir", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const userId = req.user.id || req.user.userId;
  const arquivoId = req.params.id;

  try {
    // Buscar arquivo + dados do lote/avaliação
    const [arqRows] = await pool.query(
      `SELECT a.*, l.avaliacao_id
       FROM gabarito_arquivos a
       JOIN gabarito_lotes l ON l.id = a.lote_id
       WHERE a.id = ? AND a.escola_id = ?`,
      [arquivoId, escola_id]
    );
    if (arqRows.length === 0) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }

    const arq = arqRows[0];
    let respostasAluno = safeJson(arq.respostas_aluno) || [];

    // Se respostas_aluno está vazio, rodar OMR agora (crop + bolhas)
    if (respostasAluno.length === 0) {
      // Baixar arquivo do Spaces (ou disco legado)
      let fileBuffer;
      try {
        if (isSpacesKey(arq.arquivo_path) || arq.arquivo_path.match(/^uploads\/[A-Z]/)) {
          // Novo formato: objectKey no Spaces
          console.log(`[corrigir] arq ${arquivoId}: baixando do Spaces key="${arq.arquivo_path}"`);
          const downloaded = await downloadBufferFromSpaces(arq.arquivo_path);
          fileBuffer = downloaded.buffer;
        } else {
          // Legado: path no disco
          const filePath = resolveArquivoPath(arq.arquivo_path);
          console.log(`[corrigir] arq ${arquivoId}: lendo do disco path="${filePath}" exists=${fs.existsSync(filePath)}`);
          if (!fs.existsSync(filePath)) {
            return res.status(404).json({
              error: "Arquivo não encontrado. Este gabarito foi salvo antes da migração para armazenamento em nuvem e foi perdido no re-deploy. O coordenador precisa re-enviar os gabaritos.",
              detail: `arquivo_path=${arq.arquivo_path}`,
            });
          }
          fileBuffer = fs.readFileSync(filePath);
        }
      } catch (dlErr) {
        console.error(`[corrigir] Erro ao obter arquivo arq ${arquivoId}:`, dlErr.message);
        return res.status(404).json({
          error: "Erro ao obter arquivo do armazenamento. O coordenador precisa re-enviar os gabaritos.",
          detail: dlErr.message,
        });
      }

      const OMR_URL = process.env.OMR_URL || "http://localhost:8500";

      // FormData já foi importado estaticamente no topo

      // Helper: fetch com timeout usando AbortController
      function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
      }

      // Verificar se o OMR está disponível antes de prosseguir
      try {
        const healthResp = await fetchWithTimeout(`${OMR_URL}/health`, {}, 5000);
        if (!healthResp.ok) throw new Error("OMR health check falhou");
      } catch (omrErr) {
        console.error(`[corrigir] OMR indisponível em ${OMR_URL}:`, omrErr.code || omrErr.message);
        return res.status(503).json({
          error: "Serviço de leitura OMR indisponível. O gabarito não pode ser processado automaticamente no momento. Tente novamente em alguns minutos ou contate o administrador.",
          detail: `OMR_URL=${OMR_URL}, erro=${omrErr.code || omrErr.message}`,
        });
      }

      // 1. Crop (alinhamento)
      try {
        const formCrop = new FormData();
        formCrop.append("file", fileBuffer, { filename: arq.arquivo_nome });
        const respCrop = await fetchWithTimeout(`${OMR_URL}/crop-gabarito`, {
          method: "POST",
          body: formCrop,
          headers: formCrop.getHeaders(),
        }, 30000);
        if (!respCrop.ok) {
          const errBody = await respCrop.text().catch(() => "");
          console.error(`[corrigir] crop falhou: ${respCrop.status} ${errBody}`);
          return res.status(502).json({ error: `Falha no processamento da imagem pelo OMR (crop). Status: ${respCrop.status}` });
        }
        const cropBuffer = Buffer.from(await respCrop.arrayBuffer());

        // 2. Ler bolhas
        const formBolhas = new FormData();
        formBolhas.append("file", cropBuffer, { filename: "crop.png" });
        const respBolhas = await fetchWithTimeout(`${OMR_URL}/corrigir-bolhas`, {
          method: "POST",
          body: formBolhas,
          headers: formBolhas.getHeaders(),
        }, 30000);
        if (!respBolhas.ok) {
          return res.status(502).json({ error: "Falha na leitura de bolhas pelo OMR." });
        }
        const bolhasData = await respBolhas.json();
        respostasAluno = bolhasData.respostas || [];

        // 3. Extrair QR Code (identificação do aluno)
        const qrData = bolhasData.qrData || null;
        const codigoAlunoQR = qrData?.c || null;
        let nomeAlunoQR = null;
        if (codigoAlunoQR) {
          const [alunoRows] = await pool.query(
            "SELECT estudante FROM alunos WHERE codigo = ? AND escola_id = ?",
            [codigoAlunoQR, escola_id]
          );
          if (alunoRows.length > 0) nomeAlunoQR = alunoRows[0].estudante;
        }

        // Salvar respostas + identificação no arquivo para não precisar OMR de novo
        await pool.query(
          `UPDATE gabarito_arquivos SET
            respostas_aluno = ?, status = 'identificado',
            codigo_aluno = COALESCE(?, codigo_aluno),
            nome_aluno = COALESCE(?, nome_aluno),
            qr_data = COALESCE(?, qr_data)
          WHERE id = ?`,
          [
            JSON.stringify(respostasAluno),
            codigoAlunoQR,
            nomeAlunoQR,
            qrData ? JSON.stringify(qrData) : null,
            arquivoId,
          ]
        );

        // Atualizar o arq local para o restante da função usar
        if (codigoAlunoQR) arq.codigo_aluno = codigoAlunoQR;
        if (nomeAlunoQR) arq.nome_aluno = nomeAlunoQR;
      } catch (omrFetchErr) {
        // Erro de rede/conexão no OMR (DNS, timeout, connection refused, etc.)
        console.error(`[corrigir] Erro de rede ao comunicar com OMR (${OMR_URL}):`, omrFetchErr.code || omrFetchErr.message);
        return res.status(503).json({
          error: "Erro de comunicação com o serviço OMR. O serviço pode estar offline ou sobrecarregado.",
          detail: omrFetchErr.code || omrFetchErr.message,
        });
      }
    }

    // Buscar gabarito oficial da avaliação
    const [avRows] = await pool.query(
      `SELECT gabarito_oficial, num_questoes, nota_total, disciplinas_config
       FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
      [arq.avaliacao_id, escola_id]
    );
    if (avRows.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    const avaliacao = avRows[0];
    const gabOficial = safeJson(avaliacao.gabarito_oficial) || [];
    const numQuestoes = avaliacao.num_questoes || gabOficial.length;
    const notaTotal = avaliacao.nota_total || 10;
    const disciplinasConfig = safeJson(avaliacao.disciplinas_config) || [];

    // Comparar respostas — padronizar para numQuestoes
    const detalhes = [];
    for (let i = 0; i < numQuestoes; i++) {
      const resp = respostasAluno[i] || null;
      const correto = gabOficial[i] || "";
      // "N" = nulo (múltiplas marcações) → sempre errado
      const isNulo = resp === "N";
      detalhes.push({
        numero: i + 1,
        resposta: resp,
        correto,
        acertou: !isNulo && resp !== null && resp === correto,
      });
    }

    const acertos = detalhes.filter(d => d.acertou).length;
    const valorQuestao = numQuestoes > 0 ? notaTotal / numQuestoes : 0;
    const nota = parseFloat((acertos * valorQuestao).toFixed(2));

    // Acertos por disciplina
    let acertosPorDisciplina = null;
    if (disciplinasConfig.length > 0) {
      acertosPorDisciplina = disciplinasConfig.map(dc => {
        const questoesDisciplina = detalhes.filter(d => d.numero >= dc.de && d.numero <= dc.ate);
        const acertosDisciplina = questoesDisciplina.filter(d => d.acertou).length;
        return {
          nome: dc.nome,
          disciplina_id: dc.disciplina_id,
          de: dc.de,
          ate: dc.ate,
          total: questoesDisciplina.length,
          acertos: acertosDisciplina,
        };
      });
    }

    // Atualizar arquivo
    await pool.query(
      `UPDATE gabarito_arquivos SET
        status = 'corrigido', acertos = ?, nota = ?,
        corrigido_em = CURRENT_TIMESTAMP, corrigido_por = ?
      WHERE id = ?`,
      [acertos, nota, userId, arquivoId]
    );

    // Salvar em gabarito_respostas (mesmo formato da Etapa 2 tradicional)
    // Fallback: se codigo_aluno é null (QR não processado), usa "ARQ_<id>"
    const codigoAluno = arq.codigo_aluno || `ARQ_${arquivoId}`;
    const nomeAluno = arq.nome_aluno || arq.arquivo_nome || `Arquivo ${arquivoId}`;

    // Buscar turma_nome do lote
    const [loteRows] = await pool.query("SELECT turma_nome FROM gabarito_lotes WHERE id = ?", [arq.lote_id]);
    const turmaNome = loteRows[0]?.turma_nome || null;

    await pool.query(
      `INSERT INTO gabarito_respostas
        (avaliacao_id, escola_id, codigo_aluno, nome_aluno, turma_id, turma_nome,
         respostas_aluno, acertos, total_questoes, nota, acertos_por_disciplina, detalhes, origem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'omr')
       ON DUPLICATE KEY UPDATE
         nome_aluno = VALUES(nome_aluno),
         respostas_aluno = VALUES(respostas_aluno),
         acertos = VALUES(acertos),
         total_questoes = VALUES(total_questoes),
         nota = VALUES(nota),
         acertos_por_disciplina = VALUES(acertos_por_disciplina),
         detalhes = VALUES(detalhes),
         corrigido_em = CURRENT_TIMESTAMP`,
      [
        arq.avaliacao_id,
        escola_id,
        codigoAluno,
        nomeAluno,
        arq.turma_id,
        turmaNome,
        JSON.stringify(respostasAluno),
        acertos,
        numQuestoes,
        nota,
        acertosPorDisciplina ? JSON.stringify(acertosPorDisciplina) : null,
        JSON.stringify(detalhes),
      ]
    );

    // Atualizar contadores do lote
    await pool.query(
      `UPDATE gabarito_lotes SET
        total_corrigidos = (SELECT COUNT(*) FROM gabarito_arquivos WHERE lote_id = ? AND status = 'corrigido'),
        status = CASE
          WHEN (SELECT COUNT(*) FROM gabarito_arquivos WHERE lote_id = ? AND status != 'corrigido') = 0 THEN 'finalizado'
          ELSE 'em_correcao'
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [arq.lote_id, arq.lote_id, arq.lote_id]
    );

    res.json({
      success: true,
      acertos,
      totalQuestoes: numQuestoes,
      nota,
      notaTotal,
      resultado: detalhes,
      acertosPorDisciplina,
      nome_aluno: arq.nome_aluno || null,
      codigo_aluno: arq.codigo_aluno || null,
    });
  } catch (err) {
    console.error("Erro ao corrigir arquivo:", err);
    // Retornar detalhes do erro para facilitar diagnóstico no frontend
    const detail = err?.code || err?.message || "Erro desconhecido";
    res.status(500).json({ error: `Erro ao corrigir: ${detail}` });
  }
});

// ─── GET /api/gabarito-lotes/arquivos/:id/imagem ─────────────────────────────
// Serve a imagem escaneada do gabarito (Spaces ou disco legado)
router.get("/arquivos/:id/imagem", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const arquivoId = req.params.id;

  try {
    const [rows] = await pool.query(
      `SELECT arquivo_path, arquivo_nome FROM gabarito_arquivos WHERE id = ? AND escola_id = ?`,
      [arquivoId, escola_id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }

    const arquivoPath = rows[0].arquivo_path;

    // ── Novo formato: objectKey no DigitalOcean Spaces ──
    if (isSpacesKey(arquivoPath) || arquivoPath.match(/^uploads\/[A-Z]/)) {
      try {
        console.log(`[imagem] arq ${arquivoId}: baixando do Spaces key="${arquivoPath}"`);
        const downloaded = await downloadBufferFromSpaces(arquivoPath);

        // Detectar content-type
        const ext = (rows[0].arquivo_nome || arquivoPath).split(".").pop().toLowerCase();
        const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", pdf: "application/pdf" };
        const contentType = downloaded.contentType || mimeMap[ext] || "application/octet-stream";

        res.set("Content-Type", contentType);
        res.set("Content-Disposition", `inline; filename="${rows[0].arquivo_nome || "gabarito"}"`);
        res.set("Cache-Control", "public, max-age=3600");
        return res.send(downloaded.buffer);
      } catch (dlErr) {
        console.error(`[imagem] Erro ao baixar do Spaces arq ${arquivoId}:`, dlErr.message);
        return res.status(404).json({ error: "Arquivo não encontrado no armazenamento em nuvem.", detail: dlErr.message });
      }
    }

    // ── Legado: arquivo no disco local ──
    const filePath = resolveArquivoPath(arquivoPath);
    console.log(`[imagem] arq ${arquivoId}: arquivo_path="${arquivoPath}" → resolved="${filePath}" exists=${fs.existsSync(filePath)}`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Arquivo não encontrado no disco. Path: ${filePath}` });
    }

    res.sendFile(filePath);
  } catch (err) {
    console.error("Erro ao servir imagem:", err);
    res.status(500).json({ error: "Erro ao carregar imagem." });
  }
});

// ─── GET /api/gabarito-lotes/:id/alunos-turma ────────────────────────────────
// Lista alunos da turma para vinculação manual (quando QR falha)
router.get("/:id/alunos-turma", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const loteId = req.params.id;

  try {
    // Buscar turma_nome do lote
    const [loteRows] = await pool.query(
      "SELECT turma_nome FROM gabarito_lotes WHERE id = ? AND escola_id = ?",
      [loteId, escola_id]
    );
    if (loteRows.length === 0) {
      return res.status(404).json({ error: "Lote não encontrado." });
    }

    const turmaNome = loteRows[0].turma_nome;

    // Buscar turma_id pelo nome (pode ser parcial, ex: "6º ANO B")
    const [turmaRows] = await pool.query(
      "SELECT id, nome FROM turmas WHERE escola_id = ? AND nome = ?",
      [escola_id, turmaNome]
    );

    if (turmaRows.length === 0) {
      // Tentar busca parcial (LIKE)
      const [turmaRowsLike] = await pool.query(
        "SELECT id, nome FROM turmas WHERE escola_id = ? AND nome LIKE ?",
        [escola_id, `%${turmaNome}%`]
      );
      if (turmaRowsLike.length === 0) {
        return res.json({ alunos: [], turma_nome: turmaNome, message: "Turma não encontrada no cadastro." });
      }
      // Usar primeiro match
      const turmaId = turmaRowsLike[0].id;
      const [alunos] = await pool.query(
        "SELECT id, estudante, codigo FROM alunos WHERE turma_id = ? AND escola_id = ? AND status = 'ativo' ORDER BY estudante ASC",
        [turmaId, escola_id]
      );
      return res.json({ alunos, turma_nome: turmaRowsLike[0].nome, turma_id: turmaId });
    }

    const turmaId = turmaRows[0].id;
    const [alunos] = await pool.query(
      "SELECT id, estudante, codigo FROM alunos WHERE turma_id = ? AND escola_id = ? AND status = 'ativo' ORDER BY estudante ASC",
      [turmaId, escola_id]
    );

    res.json({ alunos, turma_nome: turmaRows[0].nome, turma_id: turmaId });
  } catch (err) {
    console.error("Erro ao listar alunos da turma:", err);
    res.status(500).json({ error: "Erro ao buscar alunos." });
  }
});

// ─── PUT /api/gabarito-lotes/arquivos/:id/vincular-aluno ─────────────────────
// Vincula manualmente um aluno a um gabarito (quando QR Code falha)
router.put("/arquivos/:id/vincular-aluno", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const arquivoId = req.params.id;
  const { codigo_aluno, nome_aluno } = req.body;

  if (!codigo_aluno || !nome_aluno) {
    return res.status(400).json({ error: "codigo_aluno e nome_aluno são obrigatórios." });
  }

  try {
    // Buscar o arquivo
    const [arqRows] = await pool.query(
      `SELECT a.id, a.codigo_aluno AS old_codigo, a.nome_aluno AS old_nome, a.lote_id, a.status,
              l.avaliacao_id
       FROM gabarito_arquivos a
       JOIN gabarito_lotes l ON l.id = a.lote_id
       WHERE a.id = ? AND a.escola_id = ?`,
      [arquivoId, escola_id]
    );
    if (arqRows.length === 0) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }

    const arq = arqRows[0];

    // Atualizar gabarito_arquivos
    await pool.query(
      `UPDATE gabarito_arquivos SET codigo_aluno = ?, nome_aluno = ? WHERE id = ?`,
      [codigo_aluno, nome_aluno, arquivoId]
    );

    // Se já foi corrigido, atualizar gabarito_respostas também
    if (arq.status === "corrigido") {
      // O registro antigo pode estar com codigo_aluno = "ARQ_<id>" ou o nome arquivo
      const oldCodigo = arq.old_codigo || `ARQ_${arquivoId}`;
      await pool.query(
        `UPDATE gabarito_respostas
         SET codigo_aluno = ?, nome_aluno = ?
         WHERE avaliacao_id = ? AND escola_id = ? AND codigo_aluno = ?`,
        [codigo_aluno, nome_aluno, arq.avaliacao_id, escola_id, oldCodigo]
      );
    }

    console.log(`[vincular-aluno] arq ${arquivoId}: ${arq.old_nome || "(sem nome)"} → ${nome_aluno} (RE: ${codigo_aluno})`);

    res.json({ ok: true, codigo_aluno, nome_aluno });
  } catch (err) {
    console.error("Erro ao vincular aluno:", err);
    res.status(500).json({ error: "Erro ao vincular aluno." });
  }
});

// ─── DELETE /api/gabarito-lotes/:id ──────────────────────────────────────────
router.delete("/:id", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const loteId = req.params.id;

  try {
    // Buscar arquivos para deletar do disco
    const [arquivos] = await pool.query(
      "SELECT arquivo_path FROM gabarito_arquivos WHERE lote_id = ? AND escola_id = ?",
      [loteId, escola_id]
    );

    // Deletar do banco (cascade deleta arquivos)
    const [result] = await pool.query(
      "DELETE FROM gabarito_lotes WHERE id = ? AND escola_id = ?",
      [loteId, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Lote não encontrado." });
    }

    // Deletar arquivos do disco
    for (const arq of arquivos) {
      try {
        const filePath = resolveArquivoPath(arq.arquivo_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { /* ignore */ }
    }

    res.json({ ok: true, message: "Lote excluído com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir lote:", err);
    res.status(500).json({ error: "Erro ao excluir lote." });
  }
});

// ─── POST /api/gabarito-lotes/arquivos/:id/ajuste-manual ─────────────────────
// Professor solicita ajuste manual em uma questão
router.post("/arquivos/:id/ajuste-manual", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const userId = req.user.usuario_id || req.user.usuarioId;
  const arquivoId = req.params.id;
  const { questao_numero, tipo_ajuste, justificativa } = req.body;

  if (!questao_numero || !tipo_ajuste) {
    return res.status(400).json({ error: "questao_numero e tipo_ajuste são obrigatórios." });
  }
  if (!["acerto", "erro"].includes(tipo_ajuste)) {
    return res.status(400).json({ error: "tipo_ajuste deve ser 'acerto' ou 'erro'." });
  }

  try {
    // Verificar se o arquivo existe e pertence à escola
    const [arqRows] = await pool.query(
      "SELECT id FROM gabarito_arquivos WHERE id = ? AND escola_id = ?",
      [arquivoId, escola_id]
    );
    if (arqRows.length === 0) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }

    // Upsert: se já existe ajuste para esta questão, atualiza (reseta status p/ pendente)
    await pool.query(
      `INSERT INTO gabarito_ajustes_manuais
        (arquivo_id, escola_id, questao_numero, tipo_ajuste, justificativa, professor_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pendente')
       ON DUPLICATE KEY UPDATE
        tipo_ajuste = VALUES(tipo_ajuste),
        justificativa = VALUES(justificativa),
        professor_id = VALUES(professor_id),
        status = 'pendente',
        coordenador_id = NULL,
        coordenador_obs = NULL,
        decidido_em = NULL,
        created_at = CURRENT_TIMESTAMP`,
      [arquivoId, escola_id, questao_numero, tipo_ajuste, justificativa || null, userId]
    );

    // Buscar o ajuste inserido/atualizado
    const [ajuste] = await pool.query(
      "SELECT * FROM gabarito_ajustes_manuais WHERE arquivo_id = ? AND questao_numero = ?",
      [arquivoId, questao_numero]
    );

    res.json({ ok: true, ajuste: ajuste[0] });
  } catch (err) {
    console.error("Erro ao criar ajuste manual:", err);
    res.status(500).json({ error: "Erro ao salvar ajuste manual." });
  }
});

// ─── GET /api/gabarito-lotes/arquivos/:id/ajustes-manuais ────────────────────
// Lista todos os ajustes manuais de um arquivo
router.get("/arquivos/:id/ajustes-manuais", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const arquivoId = req.params.id;

  try {
    const [ajustes] = await pool.query(
      `SELECT a.*, u.nome AS professor_nome
       FROM gabarito_ajustes_manuais a
       LEFT JOIN usuarios u ON u.id = a.professor_id
       WHERE a.arquivo_id = ? AND a.escola_id = ?
       ORDER BY a.questao_numero`,
      [arquivoId, escola_id]
    );

    res.json(ajustes);
  } catch (err) {
    console.error("Erro ao listar ajustes:", err);
    res.status(500).json({ error: "Erro ao listar ajustes manuais." });
  }
});

// ─── PUT /api/gabarito-lotes/ajustes/:id/decidir ─────────────────────────────
// Coordenador aprova ou rejeita um ajuste manual e recalcula a nota
router.put("/ajustes/:id/decidir", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const userId = req.user.usuario_id || req.user.usuarioId;
  const ajusteId = req.params.id;
  const { decisao, observacao } = req.body;

  if (!["aprovado", "rejeitado"].includes(decisao)) {
    return res.status(400).json({ error: "decisao deve ser 'aprovado' ou 'rejeitado'." });
  }

  try {
    // Buscar ajuste
    const [ajRows] = await pool.query(
      "SELECT * FROM gabarito_ajustes_manuais WHERE id = ? AND escola_id = ?",
      [ajusteId, escola_id]
    );
    if (ajRows.length === 0) {
      return res.status(404).json({ error: "Ajuste não encontrado." });
    }

    const ajuste = ajRows[0];

    // Atualizar status
    await pool.query(
      `UPDATE gabarito_ajustes_manuais SET
        status = ?, coordenador_id = ?, coordenador_obs = ?, decidido_em = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [decisao, userId, observacao || null, ajusteId]
    );

    // Se aprovado (ou rejeitado com ajuste anterior aprovado), recalcular a nota do arquivo
    if (decisao === "aprovado" || decisao === "rejeitado") {
      // Buscar arquivo + avaliação
      const [arqRows] = await pool.query(
        `SELECT a.*, l.avaliacao_id
         FROM gabarito_arquivos a
         JOIN gabarito_lotes l ON l.id = a.lote_id
         WHERE a.id = ? AND a.escola_id = ?`,
        [ajuste.arquivo_id, escola_id]
      );
      if (arqRows.length > 0) {
        const arq = arqRows[0];
        const respostasAluno = safeJson(arq.respostas_aluno) || [];

        // Buscar gabarito oficial + questões canceladas
        const [avRows] = await pool.query(
          `SELECT gabarito_oficial, num_questoes, nota_total, disciplinas_config, questoes_canceladas
           FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
          [arq.avaliacao_id, escola_id]
        );
        if (avRows.length > 0) {
          const avaliacao = avRows[0];
          const gabOficial   = safeJson(avaliacao.gabarito_oficial) || [];
          const numQuestoes  = avaliacao.num_questoes || gabOficial.length;
          const notaTotal    = Number(avaliacao.nota_total) || 10;
          const canceladas   = safeJson(avaliacao.questoes_canceladas) || [];

          // Mapear questões canceladas por número
          const cancelMap = {};
          for (const c of canceladas) {
            cancelMap[c.numero] = c.modo; // "bonificar" | "desconsiderar"
          }

          // Calcular total efetivo (excluindo desconsideradas)
          const numDesconsideradas  = canceladas.filter(c => c.modo === "desconsiderar").length;
          const numQuestoesEfetivas = Math.max(1, numQuestoes - numDesconsideradas);

          // Buscar TODOS os ajustes aprovados para este arquivo
          const [todosAjustes] = await pool.query(
            `SELECT questao_numero, tipo_ajuste FROM gabarito_ajustes_manuais
             WHERE arquivo_id = ? AND status = 'aprovado'`,
            [ajuste.arquivo_id]
          );

          const ajustesMap = {};
          for (const a of todosAjustes) {
            ajustesMap[a.questao_numero] = a.tipo_ajuste;
          }

          // Recalcular detalhes considerando cancelamentos E ajustes manuais
          const detalhes = [];
          for (let i = 0; i < numQuestoes; i++) {
            const questaoNum = i + 1;
            const modoCancelada = cancelMap[questaoNum];

            // Questão desconsiderada → excluir do cálculo
            if (modoCancelada === "desconsiderar") continue;

            const resp    = respostasAluno[i] || null;
            const correto = gabOficial[i] || "";
            const isNulo  = resp === "N";
            let acertou   = !isNulo && resp !== null && resp === correto;

            // 1º prioridade: ajuste manual aprovado (professor + coordenador)
            if (ajustesMap[questaoNum] !== undefined) {
              acertou = ajustesMap[questaoNum] === "acerto";
            }
            // 2º prioridade: questão bonificada (só se não sobreescrito pelo ajuste manual)
            else if (modoCancelada === "bonificar") {
              acertou = true;
            }

            detalhes.push({
              numero: questaoNum,
              resposta: resp,
              correto,
              acertou,
              ...(modoCancelada === "bonificar" ? { cancelada: "bonificada" } : {}),
              ...(ajustesMap[questaoNum] !== undefined ? { ajuste_manual: ajustesMap[questaoNum] } : {}),
            });
          }

          const acertos      = detalhes.filter(d => d.acertou).length;
          const valorQuestao = numQuestoesEfetivas > 0 ? notaTotal / numQuestoesEfetivas : 0;
          const nota         = parseFloat((acertos * valorQuestao).toFixed(2));

          // Recalcular por disciplina (excluindo desconsideradas)
          const disciplinasConfig = safeJson(avaliacao.disciplinas_config) || [];
          let acertosPorDisciplina = null;
          if (disciplinasConfig.length > 0) {
            acertosPorDisciplina = disciplinasConfig.map(dc => {
              // Filtrar questões efetivas desta disciplina (excluir desconsideradas)
              const questoesDisciplina = detalhes.filter(d => d.numero >= dc.de && d.numero <= dc.ate);
              const acertosDisciplina  = questoesDisciplina.filter(d => d.acertou).length;
              return {
                nome: dc.nome,
                disciplina_id: dc.disciplina_id,
                de: dc.de, ate: dc.ate,
                total: questoesDisciplina.length,
                acertos: acertosDisciplina,
              };
            });
          }

          // Atualizar gabarito_arquivos
          await pool.query(
            `UPDATE gabarito_arquivos SET acertos = ?, nota = ? WHERE id = ?`,
            [acertos, nota, ajuste.arquivo_id]
          );

          // Atualizar gabarito_respostas (inclui total_questoes que reflete questões efetivas)
          const codigoAluno = arq.codigo_aluno || `ARQ_${ajuste.arquivo_id}`;
          const [upd] = await pool.query(
            `UPDATE gabarito_respostas SET
              acertos = ?, total_questoes = ?, nota = ?,
              detalhes = ?, acertos_por_disciplina = ?
             WHERE avaliacao_id = ? AND escola_id = ? AND codigo_aluno = ?`,
            [
              acertos, numQuestoesEfetivas, nota,
              JSON.stringify(detalhes),
              acertosPorDisciplina ? JSON.stringify(acertosPorDisciplina) : null,
              arq.avaliacao_id, escola_id, codigoAluno,
            ]
          );

          const linhasAfetadas = upd.affectedRows || 0;
          console.log(
            `[ajuste/decidir] Ajuste #${ajusteId} ${decisao}: arquivo ${ajuste.arquivo_id} ` +
            `aluno ${codigoAluno} → ${acertos}/${numQuestoesEfetivas} acertos, nota ${nota}. ` +
            `gabarito_respostas: ${linhasAfetadas} linha(s) atualizada(s).`
          );

          return res.json({
            ok: true, decisao, ajuste_id: ajusteId,
            recalculado: true,
            acertos,
            total_questoes: numQuestoesEfetivas,
            nota,
            notaTotal,
            gabarito_respostas_atualizadas: linhasAfetadas,
          });
        }
      }
    }

    res.json({ ok: true, decisao, ajuste_id: ajusteId, recalculado: false });
  } catch (err) {
    console.error("Erro ao decidir ajuste:", err);
    res.status(500).json({ error: "Erro ao processar decisão." });
  }
});


// ─── Helpers ─────────────────────────────────────────────────────────────────
function safeJson(val) {
  if (!val) return null;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return null; }
}

// ─── GET /api/gabarito-lotes/corretores-disponiveis ──────────────────────────
// Lista TODOS os usuários da escola elegíveis para corrigir gabaritos.
// Inclui: qualquer usuário do contexto pedagógico:
//   professores, coordenadores, vice-diretores, diretores, supervisores, apoio
// Exclui perfis não-pedagógicos: secretaria, militar, comandante
// Retorna lista unificada com id, nome, perfil, foto
router.get("/corretores-disponiveis", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;

  // Helper: converte path relativo (/uploads/...) em URL pública do Spaces
  // Em produção, o disco local é efêmero (redeploy limpa tudo)
  const spacesUrl = (fotoPath) => {
    if (!fotoPath) return "";
    if (fotoPath.startsWith("http")) return fotoPath; // já é URL completa
    const bucket = process.env.DO_SPACES_BUCKET || "educa-melhor-uploads";
    const region = process.env.DO_SPACES_REGION || "nyc3";
    const key = fotoPath.replace(/^\/+/, ""); // remove "/" inicial
    return `https://${bucket}.${region}.digitaloceanspaces.com/${key}`;
  };

  try {
    // 1) Professores ativos (tabela professores)
    //    Agrupados por CPF para evitar duplicatas (um professor pode ter múltiplos
    //    registros por disciplina/turno). Usa MIN(p.id) como ID canônico.
    //    Retorna disciplinas concatenadas para exibição no modal.
    const [profs] = await pool.query(
      `SELECT
         MIN(p.id) AS id,
         p.nome,
         COALESCE(MIN(p.foto), MIN(u.foto)) AS foto,
         'professor' AS perfil,
         'ativo' AS status,
         GROUP_CONCAT(DISTINCT d.nome ORDER BY d.nome SEPARATOR ', ') AS disciplina_nome,
         MIN(p.turno) AS turno
       FROM professores p
       LEFT JOIN usuarios u
         ON REPLACE(REPLACE(u.cpf, '.', ''), '-', '') = REPLACE(REPLACE(p.cpf, '.', ''), '-', '')
         AND u.escola_id = p.escola_id
       LEFT JOIN disciplinas d ON d.id = p.disciplina_id
       WHERE p.escola_id = ? AND p.status = 'ativo'
       GROUP BY REPLACE(REPLACE(p.cpf, '.', ''), '-', ''), p.nome
       ORDER BY p.nome`,
      [escola_id]
    );

    // 2) Outros usuários pedagógicos elegíveis (tabela usuarios)
    //    Pedagogicos: diretor, vice_diretor, coordenador, supervisor, apoio
    //    NÃO incluir: secretaria, militar, comandante
    //    NÃO incluir 'professor' aqui — já vem da tabela professores (acima)
    const perfisElegiveis = ['diretor', 'vice_diretor', 'coordenador', 'supervisor', 'apoio'];
    const [usuarios] = await pool.query(
      `SELECT u.id AS usuario_id, u.nome, u.perfil, u.foto
       FROM usuarios u
       WHERE u.escola_id = ?
         AND u.ativo = 1
         AND u.perfil IN (${perfisElegiveis.map(() => '?').join(',')})
       ORDER BY u.nome`,
      [escola_id, ...perfisElegiveis]
    );

    // 3) Combinar: professores com "id" (para vincular ao lote) + outros com "usuario_id"
    //    O frontend usa professor.id para vincular-professor. Para outros usuários,
    //    verificamos se eles também têm registro na tabela professores (mesmo CPF).
    const resultado = [];

    // Adicionar professores da tabela professores (já deduplicados via GROUP BY)
    const nomesAdicionados = new Set();
    for (const p of profs) {
      resultado.push({
        id: p.id,
        nome: p.nome,
        foto: spacesUrl(p.foto),
        perfil: "professor",
        status: p.status,
        disciplina_nome: p.disciplina_nome || null,
        turno: p.turno || null,
      });
      nomesAdicionados.add((p.nome || "").toUpperCase().trim());
    }

    // Adicionar outros usuários (evitar duplicatas — se o usuário já está como professor)
    for (const u of usuarios) {
      const nomeUpper = (u.nome || "").toUpperCase().trim();
      if (nomesAdicionados.has(nomeUpper)) continue; // evitar duplicata
      // Tentar encontrar um professor_id correspondente (mesmo CPF)
      const [profMatch] = await pool.query(
        `SELECT p.id FROM professores p
         JOIN usuarios u2 ON REPLACE(REPLACE(u2.cpf, '.', ''), '-', '') = REPLACE(REPLACE(p.cpf, '.', ''), '-', '')
         WHERE u2.id = ? AND p.escola_id = ? AND p.status = 'ativo'
         LIMIT 1`,
        [u.usuario_id, escola_id]
      );
      resultado.push({
        id: profMatch[0]?.id || null, // professor_id (se existe na tabela professores)
        usuario_id: u.usuario_id,
        nome: u.nome,
        foto: spacesUrl(u.foto),
        perfil: u.perfil,
        status: "ativo",
        disciplina_nome: null,
        turno: null,
      });
      nomesAdicionados.add(nomeUpper);
    }

    // Ordenar por nome
    resultado.sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));

    res.json(resultado);
  } catch (err) {
    console.error("Erro ao listar corretores disponíveis:", err);
    res.status(500).json({ error: "Erro ao listar corretores disponíveis." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDUCA-SCAN — Endpoints para o app mobile do professor
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/gabarito-lotes/scan-mobile/preview ────────────────────────────
// Etapa 1 do fluxo de 2 etapas:
// Recebe foto bruta do app, alinha via OMR (/crop-gabarito) e devolve
// a imagem alinhada como base64 para o professor confirmar antes de ler bolhas.
// NÃO faz leitura de bolhas. NÃO persiste nada.
router.post("/scan-mobile/preview", verificarEscola, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Nenhuma imagem enviada (campo 'file')." });
  }

  try {
    const OMR_URL = process.env.OMR_URL || "http://localhost:8500";

    // Health check rápido
    try {
      const hResp = await fetch(`${OMR_URL}/health`, { signal: AbortSignal.timeout(5000) });
      if (!hResp.ok) throw new Error("OMR health check falhou");
    } catch (omrErr) {
      console.error(`[scan-preview] OMR indisponível em ${OMR_URL}:`, omrErr.code || omrErr.message);
      return res.status(503).json({ error: "Serviço OMR indisponível. Tente novamente em alguns minutos." });
    }

    // Enviar para /crop-gabarito (só alinhamento)
    const formCrop = new FormData();
    formCrop.append("file", req.file.buffer, { filename: "gabarito_preview.jpg" });

    const respCrop = await fetch(`${OMR_URL}/crop-gabarito`, {
      method: "POST",
      body: formCrop,
      headers: formCrop.getHeaders(),
      signal: AbortSignal.timeout(30000),
    });

    if (!respCrop.ok) {
      const errText = await respCrop.text().catch(() => "");
      console.error(`[scan-preview] crop falhou: ${respCrop.status} ${errText}`);
      return res.status(422).json({
        error: "Não foi possível alinhar o gabarito. Certifique-se de que os 4 cantos estejam visíveis na foto.",
        detail: errText,
      });
    }

    // Converte a imagem PNG alinhada em base64
    const cropBuffer = Buffer.from(await respCrop.arrayBuffer());
    const base64 = cropBuffer.toString("base64");

    console.log(`[scan-preview] OK — imagem alinhada ${cropBuffer.length} bytes → base64 ${base64.length} chars`);

    return res.json({
      ok: true,
      alignedImage: `data:image/png;base64,${base64}`,
    });
  } catch (err) {
    console.error("[scan-preview] Erro:", err);
    res.status(500).json({ error: err?.message || "Erro interno ao processar preview." });
  }
});

// ─── POST /api/gabarito-lotes/scan-mobile/detect-corners ─────────────────────
// Proxy rápido para feedback em tempo real: envia foto de probe para o OMR
// e retorna quais cantos têm marcadores detectados.
// Chamado ~1x/segundo pelo app mobile enquanto professor posiciona o gabarito.
router.post("/scan-mobile/detect-corners", verificarEscola, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.json({ TL: false, TR: false, BL: false, BR: false, detected: 0 });
  }

  try {
    const OMR_URL = process.env.OMR_URL || "http://localhost:8500";

    const formCorners = new FormData();
    formCorners.append("file", req.file.buffer, { filename: "probe.jpg" });

    const respCorners = await fetch(`${OMR_URL}/detect-corners`, {
      method: "POST",
      body: formCorners,
      headers: formCorners.getHeaders(),
      signal: AbortSignal.timeout(8000),
    });

    if (!respCorners.ok) {
      return res.json({ TL: false, TR: false, BL: false, BR: false, detected: 0 });
    }

    const data = await respCorners.json();
    return res.json(data);
  } catch (err) {
    // Erros silenciosos — o app ignora e tenta novamente no próximo ciclo
    return res.json({ TL: false, TR: false, BL: false, BR: false, detected: 0 });
  }
});

// ─── POST /api/gabarito-lotes/scan-mobile ────────────────────────────────────
// Proxy OMR para o app mobile: recebe foto, crop, lê bolhas, compara gabarito
// Retorna resultado completo (respostas, acertos, nota, confiança)
router.post("/scan-mobile", verificarEscola, upload.single("file"), async (req, res) => {
  const { escola_id } = req.user;
  const { avaliacao_id, lote_id, arquivo_id } = req.body;

  if (!avaliacao_id) {
    return res.status(400).json({ error: "avaliacao_id é obrigatório." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "Nenhuma imagem enviada (campo 'file')." });
  }

  try {
    const OMR_URL = process.env.OMR_URL || "http://localhost:8500";

    // 1. Health check
    try {
      const hResp = await fetch(`${OMR_URL}/health`, { timeout: 5000 });
      if (!hResp.ok) throw new Error("OMR health check falhou");
    } catch (omrErr) {
      console.error(`[scan-mobile] OMR indisponível em ${OMR_URL}:`, omrErr.code || omrErr.message);
      return res.status(503).json({ error: "Serviço OMR indisponível. Tente novamente em alguns minutos." });
    }

    // 2. Crop (alinhamento)
    const formCrop = new FormData();
    formCrop.append("file", req.file.buffer, { filename: "gabarito_scan.jpg" });

    const respCrop = await fetch(`${OMR_URL}/crop-gabarito`, {
      method: "POST",
      body: formCrop,
      headers: formCrop.getHeaders(),
    });

    if (!respCrop.ok) {
      const errText = await respCrop.text().catch(() => "");
      console.error(`[scan-mobile] crop falhou: ${respCrop.status} ${errText}`);
      return res.status(422).json({
        error: "Não foi possível alinhar o gabarito. Certifique-se de que os 4 cantos estejam visíveis na foto.",
      });
    }

    const cropBuffer = Buffer.from(await respCrop.arrayBuffer());

    // 3. Ler bolhas
    const formBolhas = new FormData();
    formBolhas.append("file", cropBuffer, { filename: "crop.png" });

    const respBolhas = await fetch(`${OMR_URL}/corrigir-bolhas`, {
      method: "POST",
      body: formBolhas,
      headers: formBolhas.getHeaders(),
    });

    if (!respBolhas.ok) {
      return res.status(422).json({ error: "Falha na leitura das bolhas. Tente novamente com melhor iluminação." });
    }

    const bolhasData = await respBolhas.json();
    const respostasAluno = bolhasData.respostas || [];
    const qrData = bolhasData.qrData || null;
    const avisos = bolhasData.avisos || [];

    // Log de diagnóstico OMR para depuração remota
    if (bolhasData._debug) {
      console.log(`[scan-mobile] OMR _debug:`, JSON.stringify(bolhasData._debug));
    }

    // 4. Identificar aluno via QR Code
    let codigoAluno = qrData?.c || null;
    let nomeAluno = null;
    let turmaId = qrData?.t || null;
    if (codigoAluno) {
      const [alunoRows] = await pool.query(
        "SELECT estudante FROM alunos WHERE codigo = ? AND escola_id = ?",
        [codigoAluno, escola_id]
      );
      if (alunoRows.length > 0) nomeAluno = alunoRows[0].estudante;
    }

    // 5. Buscar gabarito oficial
    const [avRows] = await pool.query(
      `SELECT gabarito_oficial, num_questoes, nota_total, disciplinas_config
       FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
      [avaliacao_id, escola_id]
    );
    if (avRows.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    const av = avRows[0];
    const gabOficial = safeJson(av.gabarito_oficial) || [];
    const numQuestoes = av.num_questoes || gabOficial.length;
    const notaTotal = Number(av.nota_total) || 10;

    // 6. Comparar respostas
    let acertos = 0;
    for (let i = 0; i < numQuestoes; i++) {
      const resp = respostasAluno[i] || "";
      const correto = gabOficial[i] || "";
      if (resp && resp !== "N" && resp === correto) acertos++;
    }

    const valorQuestao = numQuestoes > 0 ? notaTotal / numQuestoes : 0;
    const nota = parseFloat((acertos * valorQuestao).toFixed(2));

    // 7. Confiança: usar o valor calculado pelo OMR (n_det/nQ) — mais preciso
    // que recalcular com base em avisos
    const confianca = typeof bolhasData.confianca === 'number'
      ? bolhasData.confianca
      : Math.min(100, Math.max(0, 100 - (avisos.length / Math.max(1, numQuestoes)) * 100));

    console.log(`[scan-mobile] avaliacao=${avaliacao_id} aluno=${codigoAluno || '?'} acertos=${acertos}/${numQuestoes} nota=${nota} confianca=${confianca.toFixed(1)}%`);

    const respPayload = {
      respostas: respostasAluno,
      gabaritoOficial: gabOficial,
      qrData,
      nomeAluno: nomeAluno || null,
      codigoAluno: codigoAluno || null,
      turmaId,
      nota,
      notaTotal,
      acertos,
      totalQuestoes: numQuestoes,
      avisos,
      confianca: parseFloat(confianca.toFixed(1)),
      arquivoId: arquivo_id ? Number(arquivo_id) : null,
      loteId: lote_id ? Number(lote_id) : null,
    };

    // Passar imagem de debug do OMR (mostra onde cada bolha foi amostrada)
    // Útil para diagnóstico de alinhamento durante desenvolvimento
    if (bolhasData.debugImage) {
      respPayload.debugImage = bolhasData.debugImage;
    }

    res.json(respPayload);
  } catch (err) {
    console.error("[scan-mobile] Erro:", err);
    res.status(500).json({ error: err?.message || "Erro interno ao processar scan." });
  }
});

// ─── POST /api/gabarito-lotes/scan-mobile/confirmar ──────────────────────────
// Professor confirma o resultado do scan — persiste no BD
router.post("/scan-mobile/confirmar", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const userId = req.user.id || req.user.userId || req.user.usuario_id;
  const { avaliacao_id, arquivo_id, lote_id, respostas, codigo_aluno, nome_aluno } = req.body;

  if (!avaliacao_id || !respostas || !Array.isArray(respostas)) {
    return res.status(400).json({ error: "avaliacao_id e respostas[] são obrigatórios." });
  }

  try {
    // Buscar avaliação
    const [avRows] = await pool.query(
      `SELECT gabarito_oficial, num_questoes, nota_total, disciplinas_config
       FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
      [avaliacao_id, escola_id]
    );
    if (avRows.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    const av = avRows[0];
    const gabOficial = safeJson(av.gabarito_oficial) || [];
    const numQuestoes = av.num_questoes || gabOficial.length;
    const notaTotal = Number(av.nota_total) || 10;

    // Comparar
    const detalhes = [];
    let acertos = 0;
    for (let i = 0; i < numQuestoes; i++) {
      const resp = respostas[i] || "";
      const correto = gabOficial[i] || "";
      const acertou = resp && resp !== "N" && resp === correto;
      if (acertou) acertos++;
      detalhes.push({ numero: i + 1, resposta: resp, correto, acertou });
    }

    const valorQuestao = numQuestoes > 0 ? notaTotal / numQuestoes : 0;
    const nota = parseFloat((acertos * valorQuestao).toFixed(2));

    // Acertos por disciplina
    const discConfig = safeJson(av.disciplinas_config) || [];
    let acertosPorDisciplina = null;
    if (discConfig.length > 0) {
      acertosPorDisciplina = discConfig.map(dc => {
        const qDisc = detalhes.filter(d => d.numero >= dc.de && d.numero <= dc.ate);
        return { nome: dc.nome, disciplina_id: dc.disciplina_id, de: dc.de, ate: dc.ate, total: qDisc.length, acertos: qDisc.filter(d => d.acertou).length };
      });
    }

    const codigoFinal = codigo_aluno || `SCAN_${Date.now()}`;
    const nomeFinal = nome_aluno || `Scan Mobile ${new Date().toLocaleString("pt-BR")}`;

    // Salvar em gabarito_respostas (UPSERT)
    await pool.query(
      `INSERT INTO gabarito_respostas
        (avaliacao_id, escola_id, codigo_aluno, nome_aluno, respostas_aluno,
         acertos, total_questoes, nota, acertos_por_disciplina, detalhes, origem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scan_mobile')
       ON DUPLICATE KEY UPDATE
         nome_aluno = VALUES(nome_aluno),
         respostas_aluno = VALUES(respostas_aluno),
         acertos = VALUES(acertos),
         total_questoes = VALUES(total_questoes),
         nota = VALUES(nota),
         acertos_por_disciplina = VALUES(acertos_por_disciplina),
         detalhes = VALUES(detalhes),
         corrigido_em = CURRENT_TIMESTAMP`,
      [
        avaliacao_id, escola_id, codigoFinal, nomeFinal,
        JSON.stringify(respostas), acertos, numQuestoes, nota,
        acertosPorDisciplina ? JSON.stringify(acertosPorDisciplina) : null,
        JSON.stringify(detalhes),
      ]
    );

    // Se temos arquivo_id, atualizar o status dele também
    if (arquivo_id) {
      await pool.query(
        `UPDATE gabarito_arquivos SET
          status = 'corrigido', acertos = ?, nota = ?,
          respostas_aluno = ?,
          corrigido_em = CURRENT_TIMESTAMP, corrigido_por = ?
        WHERE id = ? AND escola_id = ?`,
        [acertos, nota, JSON.stringify(respostas), userId, arquivo_id, escola_id]
      );
    }

    // Se temos lote_id, atualizar contadores
    if (lote_id) {
      await pool.query(
        `UPDATE gabarito_lotes SET
          total_corrigidos = (SELECT COUNT(*) FROM gabarito_arquivos WHERE lote_id = ? AND status = 'corrigido'),
          status = CASE
            WHEN (SELECT COUNT(*) FROM gabarito_arquivos WHERE lote_id = ? AND status != 'corrigido') = 0 THEN 'finalizado'
            ELSE 'em_correcao'
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [lote_id, lote_id, lote_id]
      );
    }

    console.log(`[scan-mobile/confirmar] avaliacao=${avaliacao_id} aluno=${codigoFinal} nota=${nota} by user=${userId}`);

    res.json({ ok: true, nota, acertos, totalQuestoes: numQuestoes, notaTotal });
  } catch (err) {
    console.error("[scan-mobile/confirmar] Erro:", err);
    res.status(500).json({ error: "Erro ao salvar resultado do scan." });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// EDUCA SCAN — FLUXO DE SESSÃO DE CAPTURA (sem OMR imediato)
// ═════════════════════════════════════════════════════════════════════════════

// ─── GET /api/gabarito-lotes/scan-mobile/sessao-info ─────────────────────────
// Chamado ao escanear o QR da CAPA DA PROVA (inicio da sessão).
// Decodificado: { tipo:"prova", avaliacao_id, turma_id, escola_id }
// Retorna: nome da avaliação, turma, N alunos, loteId (cria se não existir)
router.get("/scan-mobile/sessao-info", async (req, res) => {
  const { avaliacao_id, turma_id } = req.query;
  const { escola_id } = req.user;

  if (!avaliacao_id || !turma_id) {
    return res.status(400).json({ error: "avaliacao_id e turma_id são obrigatórios." });
  }

  try {
    // 1. Buscar avaliação
    const [avRows] = await pool.query(
      `SELECT id, titulo, num_questoes, num_alternativas, nota_total
       FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
      [avaliacao_id, escola_id]
    );
    if (avRows.length === 0) {
      return res.status(404).json({ error: "Avaliação não encontrada." });
    }

    // 2. Buscar turma
    const [turmaRows] = await pool.query(
      `SELECT id, nome FROM turmas WHERE id = ? AND escola_id = ?`,
      [turma_id, escola_id]
    );
    if (turmaRows.length === 0) {
      return res.status(404).json({ error: "Turma não encontrada." });
    }

    const av = avRows[0];
    const turma = turmaRows[0];

    // 3. Buscar ou criar lote para essa avaliação+turma
    let [loteRows] = await pool.query(
      `SELECT id, status FROM gabarito_lotes
       WHERE avaliacao_id = ? AND turma_id = ? AND escola_id = ?
       LIMIT 1`,
      [avaliacao_id, turma_id, escola_id]
    );

    let loteId;
    if (loteRows.length === 0) {
      // Cria lote automaticamente ao iniciar sessão
      const [ins] = await pool.query(
        `INSERT INTO gabarito_lotes
           (avaliacao_id, escola_id, turma_nome, turma_id, status)
         VALUES (?, ?, ?, ?, 'pendente')
         ON DUPLICATE KEY UPDATE turma_id = VALUES(turma_id), updated_at = NOW()`,
        [avaliacao_id, escola_id, turma.nome, turma_id]
      );
      loteId = ins.insertId || ins.insertId;

      // Re-buscar se foi duplicate key (update)
      if (!loteId) {
        const [relook] = await pool.query(
          `SELECT id FROM gabarito_lotes
           WHERE avaliacao_id = ? AND turma_id = ? AND escola_id = ? LIMIT 1`,
          [avaliacao_id, turma_id, escola_id]
        );
        loteId = relook[0]?.id;
      }
    } else {
      loteId = loteRows[0].id;
    }

    // 4. Progresso da sessão
    const [[prog]] = await pool.query(
      `SELECT
         COUNT(*) as total,
         SUM(status IN ('identificado','corrigido')) as capturados,
         SUM(status = 'ausente') as ausentes,
         SUM(status = 'pendente') as pendentes
       FROM gabarito_arquivos WHERE lote_id = ?`,
      [loteId]
    );

    console.log(`[sessao-info] av=${avaliacao_id} turma=${turma_id} lote=${loteId}`);

    res.json({
      avaliacaoId: av.id,
      titulo: av.titulo,
      numQuestoes: av.num_questoes,
      numAlternativas: av.num_alternativas,
      notaTotal: av.nota_total,
      turmaId: turma.id,
      turmaNome: turma.nome,
      loteId,
      progresso: {
        total:      Number(prog?.total      || 0),
        capturados: Number(prog?.capturados || 0),
        ausentes:   Number(prog?.ausentes   || 0),
        pendentes:  Number(prog?.pendentes  || 0),
      },
    });
  } catch (err) {
    console.error("[sessao-info] Erro:", err);
    res.status(500).json({ error: err?.message || "Erro ao buscar informações da sessão." });
  }
});

// ─── GET /api/gabarito-lotes/scan-mobile/aluno-by-codigo ───────────────────────────
// Chamado ao escanear o QR do GABARITO DO ALUNO.
// Busca aluno pelo código, retorna dados e arquivo_id do lote.
router.get("/scan-mobile/aluno-by-codigo", async (req, res) => {
  const { codigo, avaliacao_id, lote_id } = req.query;
  const { escola_id } = req.user;

  if (!codigo) {
    return res.status(400).json({ error: "codigo é obrigatório." });
  }

  try {
    // 1. Buscar aluno
    const [alunoRows] = await pool.query(
      `SELECT a.id, a.estudante AS nome, a.codigo, a.foto, a.escola_id,
              t.nome AS turma,
              e.apelido AS escola_apelido
       FROM alunos a
       LEFT JOIN turmas t ON a.turma_id = t.id
       LEFT JOIN escolas e ON a.escola_id = e.id
       WHERE a.codigo = ? AND a.escola_id = ?
       LIMIT 1`,
      [codigo, school_id || escola_id] // Fallback in case of variable name differences
    ).catch(() => {
      // Fallback in case school_id or school_apelido query fails
      return pool.query(
        `SELECT a.id, a.estudante AS nome, a.codigo, a.foto, a.escola_id,
                t.nome AS turma
         FROM alunos a
         LEFT JOIN turmas t ON a.turma_id = t.id
         WHERE a.codigo = ? AND a.escola_id = ?
         LIMIT 1`,
        [codigo, escola_id]
      );
    });

    if (alunoRows.length === 0) {
      return res.status(404).json({ error: "Aluno não encontrado com esse código." });
    }
    const aluno = alunoRows[0];

    // 2. Buscar arquivo no lote (se lote_id fornecido)
    let arquivoId = null;
    let jaCapturado = false;
    let statusAtual = null;

    if (lote_id) {
      const [arqRows] = await pool.query(
        `SELECT id, status FROM gabarito_arquivos
         WHERE lote_id = ? AND codigo_aluno = ?
         LIMIT 1`,
        [lote_id, codigo]
      );
      if (arqRows.length > 0) {
        arquivoId  = arqRows[0].id;
        statusAtual = arqRows[0].status;
        jaCapturado = !['pendente'].includes(arqRows[0].status);
      }
    }

    // 3. Progresso da sessão
    let sessionProgress = { total: 0, capturados: 0, ausentes: 0 };
    if (lote_id) {
      const [[prog]] = await pool.query(
        `SELECT
           COUNT(*) as total,
           SUM(status IN ('identificado','corrigido')) as capturados,
           SUM(status = 'ausente') as ausentes
         FROM gabarito_arquivos WHERE lote_id = ?`,
        [lote_id]
      );
      sessionProgress = {
        total:      Number(prog?.total      || 0),
        capturados: Number(prog?.capturados || 0),
        ausentes:   Number(prog?.ausentes   || 0),
      };
    }

    // 4. Formata a foto do estudante de forma dinâmica
    let fotoUrl = null;
    if (aluno.foto) {
      if (aluno.foto.startsWith("http")) {
        fotoUrl = aluno.foto;
      } else {
        const SPACES_BASE = process.env.SPACES_PUBLIC_BASE || "https://educa-melhor-uploads.nyc3.cdn.digitaloceanspaces.com/";
        const s = String(aluno.foto).trim();
        let objectKey = null;
        const idx = s.indexOf("/uploads/");
        if (idx >= 0) objectKey = s.slice(idx + 1);
        else if (s.startsWith("/uploads/")) objectKey = s.slice(1);
        else if (s.startsWith("uploads/")) objectKey = s;

        if (objectKey) {
          fotoUrl = `${SPACES_BASE}${objectKey}`;
        }
      }
    }

    console.log(`[aluno-by-codigo] codigo=${codigo} aluno=${aluno.nome} arquivo=${arquivoId} foto=${fotoUrl}`);

    res.json({
      alunoId:   aluno.id,
      nome:      aluno.nome,
      re:        aluno.codigo, // Mapeia o RE de forma correta (aluno.codigo)
      codigo:    aluno.codigo,
      turma:     aluno.turma,
      fotoUrl,                // Foto do estudante resolvida
      arquivoId,
      jaCapturado,
      statusAtual,
      sessionProgress,
    });
  } catch (err) {
    console.error("[aluno-by-codigo] Erro:", err);
    res.status(500).json({ error: err?.message || "Erro ao buscar aluno." });
  }
});

// ─── GET /api/gabarito-lotes/scan-mobile/lote-imagens ───────────────────────────────
// Carrega (UMA VEZ por sessão) o mapa de alunos que já têm imagem no BD.
// Usado pelo EDUCA-SCAN para não re-capturar quem já foi digitalizado via portal.
router.get("/scan-mobile/lote-imagens", async (req, res) => {
  const { lote_id } = req.query;
  const { escola_id } = req.user;
  if (!lote_id) return res.status(400).json({ error: "lote_id é obrigatório" });
  try {
    const [rows] = await pool.query(
      `SELECT codigo_aluno, id AS arquivoId, status,
              (arquivo_path IS NOT NULL AND arquivo_path != '') AS temImagem,
              (respostas_aluno IS NOT NULL) AS temRespostas
       FROM gabarito_arquivos WHERE lote_id = ? AND escola_id = ?`,
      [lote_id, escola_id]
    );
    const imagens = {};
    for (const r of rows) {
      imagens[r.codigo_aluno] = {
        arquivoId:    r.arquivoId,
        status:       r.status,
        temImagem:    !!r.temImagem,
        temRespostas: !!r.temRespostas,
      };
    }
    res.json({ imagens });
  } catch (err) {
    console.error("[lote-imagens]", err);
    res.status(500).json({ error: err?.message || "Erro ao carregar imagens" });
  }
});

// ─── POST /api/gabarito-lotes/scan-mobile/ler-imagem-existente ──────────────────
// Retorna bolhas já lidas (DB) ou roda OMR na imagem do portal.
router.post("/scan-mobile/ler-imagem-existente", async (req, res) => {
  const { arquivo_id } = req.body;
  const { escola_id }  = req.user;
  if (!arquivo_id) return res.status(400).json({ error: "arquivo_id é obrigatório" });
  try {
    const [[arq]] = await pool.query(
      `SELECT id, arquivo_path, respostas_aluno FROM gabarito_arquivos
       WHERE id = ? AND escola_id = ?`,
      [arquivo_id, escola_id]
    );
    if (!arq) return res.status(404).json({ error: "Arquivo não encontrado" });

    // Caminho rápido: já tem respostas
    if (arq.respostas_aluno) {
      const respostas = JSON.parse(arq.respostas_aluno);
      const nDet = respostas.filter(r => r && r !== 'N').length;
      const conf = Math.round(nDet / Math.max(1, respostas.length) * 100);
      return res.json({
        arquivoId: arq.id, source: 'db_respostas',
        omrResult: { respostas, totalQuestoes: respostas.length,
                     totalAlternativas: 4, confianca: conf, avisos: [] },
      });
    }

    // Caminho OMR: baixar imagem do Spaces e processar
    if (!arq.arquivo_path) return res.status(400).json({ error: "Sem imagem associada" });

    const imgResp = await fetch(arq.arquivo_path, { signal: AbortSignal.timeout(15000) });
    if (!imgResp.ok) throw new Error(`Download falhou: ${imgResp.status}`);
    const imgBuf  = Buffer.from(await imgResp.arrayBuffer());

    const FormDataNode = require('form-data');
    const formBolhas   = new FormDataNode();
    formBolhas.append("file", imgBuf, { filename: "gabarito.jpg", contentType: "image/jpeg" });

    const respBolhas = await fetch(`${OMR_URL}/corrigir-bolhas`, {
      method: "POST", body: formBolhas,
      headers: formBolhas.getHeaders(),
      signal: AbortSignal.timeout(30000),
    });
    if (!respBolhas.ok) {
      const e = await respBolhas.text().catch(() => "");
      return res.status(502).json({ error: `OMR falhou: ${e.slice(0,200)}` });
    }

    const bd = await respBolhas.json();
    const omrResult = {
      respostas: bd.respostas || [], totalQuestoes: bd.totalQuestoes || 0,
      totalAlternativas: bd.totalAlternativas || 4,
      confianca: bd.confianca || 0, avisos: bd.avisos || [],
    };
    if (omrResult.respostas.length > 0) {
      pool.query(`UPDATE gabarito_arquivos SET respostas_aluno = ? WHERE id = ?`,
        [JSON.stringify(omrResult.respostas), arquivo_id]).catch(() => {});
    }
    console.log(`[ler-imagem-existente] arqId=${arquivo_id} conf=${omrResult.confianca}%`);
    res.json({ arquivoId: arq.id, omrResult, source: 'omr' });
  } catch (err) {
    console.error("[ler-imagem-existente]", err);
    res.status(500).json({ error: err?.message || "Erro ao ler imagem" });
  }
});

// ─── POST /api/gabarito-lotes/scan-mobile/save-image ─────────────────────────
// Salva a imagem alinhada do gabarito no Spaces SEM executar OMR.
// Atualiza gabarito_arquivos: arquivo_path + status='identificado' + capturado_em
router.post("/scan-mobile/save-image", upload.single("file"), async (req, res) => {
  const { escola_id, escola_apelido } = req.user;
  const { avaliacao_id, lote_id, codigo_aluno, arquivo_id } = req.body;

  if (!req.file)      return res.status(400).json({ error: "Imagem não enviada (campo 'file')." });
  if (!avaliacao_id)  return res.status(400).json({ error: "avaliacao_id é obrigatório." });
  if (!codigo_aluno)  return res.status(400).json({ error: "codigo_aluno é obrigatório." });

  try {
    const OMR_URL = process.env.OMR_URL || "http://localhost:8500";

    // 1. Tentar alinhar via OMR — com fallback para imagem original do app
    // SE o OMR falhar (marcadores não detectados), usa o recorte client-side:
    // o app já remove o fundo e enquadra o gabarito, então é preferível a um erro.
    let alignedBuffer = req.file.buffer;  // fallback: recorte client-side
    let alignmentMethod = "client_crop";

    try {
      const formCrop = new FormData();
      formCrop.append("file", req.file.buffer, { filename: "gabarito.jpg" });

      const respCrop = await fetch(`${OMR_URL}/crop-gabarito`, {
        method: "POST",
        body: formCrop,
        headers: formCrop.getHeaders(),
        signal: AbortSignal.timeout(25000),
      });

      if (respCrop.ok) {
        alignedBuffer    = Buffer.from(await respCrop.arrayBuffer());
        alignmentMethod  = "omr_perspective";
        console.log(`[save-image] OMR alignment OK — ${alignedBuffer.length} bytes`);
      } else {
        const errText = await respCrop.text().catch(() => "");
        console.warn(`[save-image] OMR crop falhou (${respCrop.status}) → usando client crop: ${errText.slice(0, 120)}`);
      }
    } catch (cropErr) {
      console.warn(`[save-image] OMR crop erro → usando client crop: ${cropErr.message}`);
    }

    // 2. Upload para DigitalOcean Spaces
    const apelido = escola_apelido || `escola_${escola_id}`;
    const loteFolder = lote_id || avaliacao_id;
    const objectKey = `uploads/${apelido}/gabaritos/${loteFolder}/${codigo_aluno}_${Date.now()}.jpg`;

    await uploadFileBufferToSpaces({
      buffer: alignedBuffer,
      contentType: "image/jpeg",
      objectKey,
    });

    const DO_BUCKET = process.env.DO_SPACES_BUCKET;
    const DO_REGION = process.env.DO_SPACES_REGION || "nyc3";
    const imagemUrl = `https://${DO_BUCKET}.${DO_REGION}.digitaloceanspaces.com/${objectKey}`;

    // 3. Atualizar ou criar gabarito_arquivo
    let arqId = arquivo_id ? Number(arquivo_id) : null;

    if (arqId) {
      // Atualizar arquivo existente
      await pool.query(
        `UPDATE gabarito_arquivos SET
           arquivo_path = ?, codigo_aluno = ?,
           status = 'identificado', capturado_em = NOW()
         WHERE id = ? AND escola_id = ?`,
        [imagemUrl, codigo_aluno, arqId, escola_id]
      );
    } else if (lote_id) {
      // Buscar arquivo por codigo_aluno no lote
      const [existente] = await pool.query(
        `SELECT id FROM gabarito_arquivos
         WHERE lote_id = ? AND codigo_aluno = ?
         LIMIT 1`,
        [lote_id, codigo_aluno]
      );

      if (existente.length > 0) {
        arqId = existente[0].id;
        await pool.query(
          `UPDATE gabarito_arquivos SET
             arquivo_path = ?, status = 'identificado', capturado_em = NOW()
           WHERE id = ?`,
          [imagemUrl, arqId]
        );
      } else {
        // Criar novo arquivo no lote
        const [ins] = await pool.query(
          `INSERT INTO gabarito_arquivos
             (lote_id, escola_id, arquivo_nome, arquivo_path, codigo_aluno, status, capturado_em)
           VALUES (?, ?, ?, ?, ?, 'identificado', NOW())`,
          [lote_id, escola_id, `${codigo_aluno}.jpg`, imagemUrl, codigo_aluno]
        );
        arqId = ins.insertId;

        // Incrementar total_arquivos do lote
        await pool.query(
          `UPDATE gabarito_lotes SET
             total_arquivos = total_arquivos + 1, updated_at = NOW()
           WHERE id = ?`,
          [lote_id]
        );
      }
    }

    // 4. Progresso atualizado
    let sessionProgress = { total: 0, capturados: 0, ausentes: 0, pendentes: 0 };
    if (lote_id) {
      const [[prog]] = await pool.query(
        `SELECT
           COUNT(*) as total,
           SUM(status IN ('identificado','corrigido')) as capturados,
           SUM(status = 'ausente') as ausentes,
           SUM(status = 'pendente') as pendentes
         FROM gabarito_arquivos WHERE lote_id = ?`,
        [lote_id]
      );
      sessionProgress = {
        total:      Number(prog?.total      || 0),
        capturados: Number(prog?.capturados || 0),
        ausentes:   Number(prog?.ausentes   || 0),
        pendentes:  Number(prog?.pendentes  || 0),
      };
    }

    // 5. Leitura de bolhas na imagem alinhada (best-effort — não bloqueia o save)
    let omrResult = null;
    try {
      const formBolhas = new FormData();
      formBolhas.append("file", alignedBuffer, { filename: "aligned.png" });

      const respBolhas = await fetch(`${OMR_URL}/corrigir-bolhas`, {
        method: "POST",
        body: formBolhas,
        headers: formBolhas.getHeaders(),
        signal: AbortSignal.timeout(25000),
      });

      if (respBolhas.ok) {
        const bd = await respBolhas.json();
        omrResult = {
          respostas:         bd.respostas         || [],
          totalQuestoes:     bd.totalQuestoes     || 0,
          totalAlternativas: bd.totalAlternativas || 4,
          confianca:         bd.confianca         || 0,
          avisos:            bd.avisos            || [],
        };
        console.log(`[save-image] OMR bolhas OK — confianca=${omrResult.confianca}% method=${alignmentMethod}`);

        // Persistir leitura inicial no BD (best-effort)
        if (arqId && omrResult.respostas.length > 0) {
          pool.query(
            `UPDATE gabarito_arquivos SET respostas_aluno = ? WHERE id = ?`,
            [JSON.stringify(omrResult.respostas), arqId]
          ).catch(e => console.warn(`[save-image] respostas_aluno não salvo: ${e.message}`));
        }
      } else {
        const be = await respBolhas.text().catch(() => "");
        console.warn(`[save-image] OMR bolhas status=${respBolhas.status}: ${be.slice(0, 120)}`);
      }
    } catch (omrErr) {
      console.warn("[save-image] OMR bolhas falhou (não fatal):", omrErr.message);
    }

    console.log(`[save-image] codigo=${codigo_aluno} arqId=${arqId} url=${objectKey} align=${alignmentMethod}`);

    res.json({
      success:   true,
      arquivoId: arqId,
      imagemUrl,
      sessionProgress,
      omrResult,
      alignmentMethod,
    });
  } catch (err) {
    console.error("[save-image] Erro:", err);
    res.status(500).json({ error: err?.message || "Erro ao salvar imagem do gabarito." });
  }
});

// ─── POST /api/gabarito-lotes/scan-mobile/confirmar-leitura ───────────────────────────
// Salva as respostas finais (OMR + correções manuais do professor) no BD.
// Chamado ao confirmar a tela de leitura no EDUCA-SCAN.
router.post("/scan-mobile/confirmar-leitura", async (req, res) => {
  const { arquivo_id, respostas, origem } = req.body;
  const { escola_id } = req.user;

  if (!arquivo_id || !Array.isArray(respostas)) {
    return res.status(400).json({ error: "arquivo_id e respostas são obrigatórios" });
  }

  try {
    const [result] = await pool.query(
      `UPDATE gabarito_arquivos
         SET respostas_aluno = ?,
             status          = CASE WHEN status = 'pendente' THEN 'identificado' ELSE status END,
             updated_at      = NOW()
       WHERE id = ? AND escola_id = ?`,
      [JSON.stringify(respostas), arquivo_id, escola_id]
    );

    if (result.affectedRows === 0) {
      console.warn(`[confirmar-leitura] arqId=${arquivo_id} não encontrado para escola_id=${escola_id}`);
    }

    console.log(`[confirmar-leitura] arqId=${arquivo_id} origem=${origem || 'omr'} n=${respostas.length}`);
    res.json({ success: true, affectedRows: result.affectedRows });
  } catch (err) {
    console.error("[confirmar-leitura] Erro:", err);
    res.status(500).json({ error: err?.message || "Erro ao confirmar leitura" });
  }
});

// ─── PATCH /api/gabarito-lotes/arquivos/:id/ausente ─────────────────────────────
// Marca aluno como ausente (ou desfaz voltando para 'pendente')
router.patch("/arquivos/:id/ausente", async (req, res) => {
  const { id } = req.params;
  const { desfazer } = req.body;   // true = restaurar para 'pendente'
  const { escola_id } = req.user;

  try {
    const novoStatus = desfazer ? "pendente" : "ausente";

    const [result] = await pool.query(
      `UPDATE gabarito_arquivos SET status = ?, updated_at = NOW()
       WHERE id = ? AND escola_id = ?`,
      [novoStatus, id, escola_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }

    // Buscar lote_id para retornar progresso
    const [[arq]] = await pool.query(
      `SELECT lote_id FROM gabarito_arquivos WHERE id = ?`, [id]
    );

    let sessionProgress = null;
    if (arq?.lote_id) {
      const [[prog]] = await pool.query(
        `SELECT
           COUNT(*) as total,
           SUM(status IN ('identificado','corrigido')) as capturados,
           SUM(status = 'ausente') as ausentes,
           SUM(status = 'pendente') as pendentes
         FROM gabarito_arquivos WHERE lote_id = ?`,
        [arq.lote_id]
      );
      sessionProgress = {
        total:      Number(prog?.total      || 0),
        capturados: Number(prog?.capturados || 0),
        ausentes:   Number(prog?.ausentes   || 0),
        pendentes:  Number(prog?.pendentes  || 0),
      };
    }

    console.log(`[ausente] arqId=${id} status=${novoStatus}`);
    res.json({ ok: true, status: novoStatus, sessionProgress });
  } catch (err) {
    console.error("[ausente] Erro:", err);
    res.status(500).json({ error: err?.message || "Erro ao atualizar status." });
  }
});

// ─── GET /api/gabarito-lotes/scan-mobile/sessao-qr ───────────────────────────
// Gera um QR Code PNG para a capa da prova — identificação de sessão.
// O professor escaneia este QR com o app para iniciar a sessão.
// Query: avaliacao_id, turma_id
router.get("/scan-mobile/sessao-qr", async (req, res) => {
  const { avaliacao_id, turma_id } = req.query;
  const { escola_id } = req.user;

  if (!avaliacao_id || !turma_id) {
    return res.status(400).json({ error: "avaliacao_id e turma_id são obrigatórios." });
  }

  try {
    const payload = JSON.stringify({
      tipo: "prova",
      avaliacao_id: Number(avaliacao_id),
      turma_id:     Number(turma_id),
      escola_id:    Number(escola_id),
    });

    const qrPng = await QRCode.toBuffer(payload, {
      type:           "png",
      width:          300,
      margin:         2,
      color:          { dark: "#000000", light: "#FFFFFF" },
      errorCorrectionLevel: "M",
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");  // 24h cache
    res.send(qrPng);

    console.log(`[sessao-qr] gerado para av=${avaliacao_id} turma=${turma_id}`);
  } catch (err) {
    console.error("[sessao-qr] Erro:", err);
    res.status(500).json({ error: "Erro ao gerar QR da sessão." });
  }
});

export default router;

