// api/controllers/questoesController.js
// EDUCA.PROVA — Controller completo com suporte a novos campos e filtros avançados

import pool from "../db.js";
import * as Questao from "../models/questaoModel.js";
import { parsePdfFile } from "../utils/pdfParser.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import multer from "multer";

// ─── Gemini Vision — instância lazy (só cria se GEMINI_API_KEY estiver definida) ──
let _gemini = null;
function getGemini() {
  if (!_gemini) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY não configurada no ambiente.");
    _gemini = new GoogleGenerativeAI(key);
  }
  return _gemini;
}

// ─── Multer — memória (sem gravar em disco) ──────────────────────────────────
export const uploadImagem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(_, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  },
}).single("imagem");


// ─── Campos completos para SELECT ───────────────────────────────────────────
const CAMPOS = `
  id, conteudo_bruto, latex_formatado, tipo, nivel, serie, bimestre,
  disciplina, habilidade_bncc, imagem_base64, alternativas_json, correta,
  texto_apoio, fonte, explicacao, tags, compartilhada, status,
  escola_id, professor_id, vezes_utilizada, criada_em, atualizada_em
`;

// ─── BUILD WHERE helper ──────────────────────────────────────────────────────
function buildWhere(escola_id, professor_id, perfil, filters = {}) {
  const conditions = [];
  const params = [];

  // ── RBAC: professor vê apenas próprias + compartilhadas; gestores vêem todas ──
  if (escola_id) {
    conditions.push('(q.escola_id = ? OR q.escola_id IS NULL)');
    params.push(escola_id);
  }
  if (perfil === 'professor' && professor_id) {
    conditions.push('(q.professor_id = ? OR q.compartilhada = 1)');
    params.push(professor_id);
  }

  const { disciplina, tipo, nivel, serie, bimestre, status, busca,
          habilidade_bncc, compartilhada, professor_id: filtProfId } = filters;

  if (disciplina)     { conditions.push('q.disciplina = ?');          params.push(disciplina); }
  if (tipo)           { conditions.push('q.tipo = ?');                 params.push(tipo); }
  if (nivel)          { conditions.push('q.nivel = ?');                params.push(nivel); }
  if (serie)          { conditions.push('q.serie = ?');                params.push(serie); }
  if (bimestre)       { conditions.push('q.bimestre = ?');             params.push(bimestre); }
  if (habilidade_bncc){ conditions.push('q.habilidade_bncc LIKE ?');   params.push(`${habilidade_bncc}%`); }
  if (compartilhada === '1') { conditions.push('q.compartilhada = 1'); }
  if (filtProfId)     { conditions.push('q.professor_id = ?');          params.push(filtProfId); }

  if (status === 'arquivada')      conditions.push("q.status = 'arquivada'");
  else if (status === 'rascunho') conditions.push("q.status = 'rascunho'");
  else if (status === 'todas')    {/* sem filtro */}
  else                            conditions.push("q.status != 'arquivada'");

  if (busca) {
    conditions.push('(q.conteudo_bruto LIKE ? OR q.tags LIKE ? OR q.habilidade_bncc LIKE ?)');
    params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
  }

  return { where: conditions.length > 0 ? conditions.join(' AND ') : '1=1', params };
}


// ─────────────────────────────────────────────────────────────────────────────
// 1) GET /questoes — Lista questões com filtros opcionais e paginação
// ─────────────────────────────────────────────────────────────────────────────
export async function listarQuestoes(req, res) {
  const { escola_id, professor_id, perfil } = req.user;
  const { page = 1, limit = 50, ordenar, ...filters } = req.query;

  try {
    const { where, params } = buildWhere(escola_id, professor_id, perfil, filters);
    const offset = (Number(page) - 1) * Number(limit);

    // Ordem dinâmica
    const ordemMap = {
      recentes:      'q.id DESC',
      mais_usadas:   'q.vezes_utilizada DESC, q.id DESC',
      mais_antigas:  'q.id ASC',
      disciplina:    'q.disciplina ASC, q.id DESC',
    };
    const orderBy = ordemMap[ordenar] || 'q.id DESC';

    const [questoes] = await pool.query(
      `SELECT ${CAMPOS} FROM questoes q WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM questoes q WHERE ${where}`,
      params
    );

    res.json({ questoes, pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) } });
  } catch (err) {
    console.error('Erro ao listar questões:', err);
    res.status(500).json({ message: 'Erro no servidor.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) GET /questoes/stats — Estatísticas do banco
// ─────────────────────────────────────────────────────────────────────────────
export async function statsQuestoes(req, res) {
  const { escola_id } = req.user;
  try {
    const [[totais]] = await pool.query(
      `SELECT COUNT(*) AS total,
        SUM(status = 'ativa') AS ativas,
        SUM(status = 'rascunho') AS rascunhos,
        SUM(status = 'arquivada') AS arquivadas,
        SUM(compartilhada = 1) AS compartilhadas
       FROM questoes WHERE escola_id = ?`,
      [escola_id]
    );
    const [porNivel] = await pool.query(
      `SELECT nivel, COUNT(*) AS total FROM questoes
       WHERE escola_id = ? AND status = 'ativa' GROUP BY nivel`,
      [escola_id]
    );
    const [porDisciplina] = await pool.query(
      `SELECT disciplina, COUNT(*) AS total FROM questoes
       WHERE escola_id = ? AND status = 'ativa' AND disciplina IS NOT NULL
       GROUP BY disciplina ORDER BY total DESC LIMIT 10`,
      [escola_id]
    );
    const [porTipo] = await pool.query(
      `SELECT tipo, COUNT(*) AS total FROM questoes
       WHERE escola_id = ? AND status = 'ativa' GROUP BY tipo`,
      [escola_id]
    );
    const [maisUsadas] = await pool.query(
      `SELECT id, conteudo_bruto, disciplina, nivel, tipo, vezes_utilizada
       FROM questoes
       WHERE escola_id = ? AND status = 'ativa' AND vezes_utilizada > 0
       ORDER BY vezes_utilizada DESC LIMIT 10`,
      [escola_id]
    );
    const [recentes] = await pool.query(
      `SELECT id, conteudo_bruto, disciplina, nivel, tipo, criada_em
       FROM questoes WHERE escola_id = ? AND status = 'ativa'
       ORDER BY criada_em DESC LIMIT 5`,
      [escola_id]
    );
    res.json({ totais, porNivel, porDisciplina, porTipo, maisUsadas, recentes });
  } catch (err) {
    console.error('Erro ao buscar stats:', err);
    res.status(500).json({ message: 'Erro no servidor.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) GET /questoes/:id
// ─────────────────────────────────────────────────────────────────────────────
export async function obterQuestao(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  try {
    const [[questao]] = await pool.query(
      `SELECT ${CAMPOS} FROM questoes q WHERE q.id = ? AND q.escola_id = ?`,
      [id, escola_id]
    );
    if (!questao) return res.status(404).json({ message: "Questão não encontrada." });
    res.json(questao);
  } catch (err) {
    console.error("Erro ao obter questão:", err);
    res.status(500).json({ message: "Erro no servidor." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) POST /questoes — Cria nova questão
// ─────────────────────────────────────────────────────────────────────────────
export async function criarQuestao(req, res) {
  const { escola_id, professor_id: uid } = req.user;
  const {
    conteudo_bruto, latex_formatado, tipo, nivel,
    serie, bimestre, disciplina, habilidade_bncc,
    imagem_base64, alternativas_json, correta,
    texto_apoio, fonte, explicacao, tags,
    compartilhada = 0, status = 'ativa', ano,
  } = req.body;

  try {
    const [result] = await pool.query(
      `INSERT INTO questoes (
        conteudo_bruto, latex_formatado, tipo, nivel, serie, bimestre,
        disciplina, habilidade_bncc, imagem_base64, alternativas_json, correta,
        texto_apoio, fonte, explicacao, tags, compartilhada, status,
        escola_id, professor_id, vezes_utilizada, criada_em, atualizada_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`,
      [
        conteudo_bruto  || null, latex_formatado  || null,
        tipo            || 'objetiva', nivel || 'medio',
        serie           || null, bimestre || null,
        disciplina      || null, habilidade_bncc || null,
        imagem_base64   || null, alternativas_json || null, correta || null,
        texto_apoio     || null, fonte || null, explicacao || null,
        tags            || '',
        compartilhada ? 1 : 0,
        ['rascunho','ativa','arquivada'].includes(status) ? status : 'ativa',
        escola_id, uid || null,
      ]
    );
    const qid = result.insertId;
    await registrarHistorico(qid, 'criou', uid);
    res.status(201).json({ id: qid, message: 'Questão criada com sucesso.' });
  } catch (err) {
    console.error('Erro ao criar questão:', err);
    res.status(500).json({ message: 'Erro ao salvar questão.', detail: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) PUT /questoes/:id — Atualiza questão
// ─────────────────────────────────────────────────────────────────────────────
export async function atualizarQuestao(req, res) {
  const { id } = req.params;
  const { escola_id } = req.user;
  const {
    conteudo_bruto, latex_formatado, tipo, nivel,
    serie, bimestre, disciplina, habilidade_bncc,
    imagem_base64, alternativas_json, correta,
    texto_apoio, fonte, explicacao, tags,
    compartilhada, status,
  } = req.body;

  try {
    const [result] = await pool.query(
      `UPDATE questoes SET
        conteudo_bruto = ?, latex_formatado = ?, tipo = ?, nivel = ?,
        serie = ?, bimestre = ?, disciplina = ?, habilidade_bncc = ?,
        imagem_base64 = ?, alternativas_json = ?, correta = ?,
        texto_apoio = ?, fonte = ?, explicacao = ?, tags = ?,
        compartilhada = ?, status = ?, atualizada_em = NOW()
       WHERE id = ? AND escola_id = ?`,
      [
        conteudo_bruto    || null,
        latex_formatado   || null,
        tipo              || "objetiva",
        nivel             || "medio",
        serie             || null,
        bimestre          || null,
        disciplina        || null,
        habilidade_bncc   || null,
        imagem_base64     || null,
        alternativas_json || null,
        correta           || null,
        texto_apoio       || null,
        fonte             || null,
        explicacao        || null,
        tags              || "",
        compartilhada ? 1 : 0,
        ["rascunho","ativa","arquivada"].includes(status) ? status : "ativa",
        id, escola_id,
      ]
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Questão não encontrada ou não pertence à sua escola." });

    res.json({ message: "Questão atualizada com sucesso." });
  } catch (err) {
    console.error("Erro ao atualizar questão:", err);
    res.status(500).json({ message: "Erro ao atualizar questão.", detail: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) DELETE /questoes/:id — Soft delete → arquiva (ou hard delete via ?hard=1)
// ─────────────────────────────────────────────────────────────────────────────
export async function excluirQuestao(req, res) {
  const { id } = req.params;
  const { escola_id, professor_id } = req.user;
  const hard = req.query.hard === '1';
  try {
    let result;
    if (hard) {
      [result] = await pool.query('DELETE FROM questoes WHERE id = ? AND escola_id = ?', [id, escola_id]);
    } else {
      [result] = await pool.query(
        "UPDATE questoes SET status = 'arquivada', atualizada_em = NOW() WHERE id = ? AND escola_id = ?",
        [id, escola_id]
      );
      await registrarHistorico(id, 'arquivou', professor_id);
    }
    if (result.affectedRows === 0)
      return res.status(404).json({ message: 'Questão não encontrada.' });
    res.status(204).end();
  } catch (err) {
    console.error('Erro ao excluir questão:', err);
    res.status(500).json({ message: 'Erro ao excluir questão.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 7) POST /questoes/:id/duplicar
// ─────────────────────────────────────────────────────────────────────────
export async function duplicarQuestao(req, res) {
  const { id } = req.params;
  const { escola_id, professor_id } = req.user;
  try {
    const [[orig]] = await pool.query(
      `SELECT * FROM questoes WHERE id = ? AND (escola_id = ? OR compartilhada = 1)`,
      [id, escola_id]
    );
    if (!orig) return res.status(404).json({ message: 'Questão não encontrada.' });

    const [r] = await pool.query(
      `INSERT INTO questoes (
        conteudo_bruto, latex_formatado, tipo, nivel, serie, bimestre,
        disciplina, habilidade_bncc, imagem_base64, alternativas_json, correta,
        texto_apoio, fonte, explicacao, tags, compartilhada, status,
        escola_id, professor_id, vezes_utilizada, criada_em, atualizada_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'rascunho', ?, ?, 0, NOW(), NOW())`,
      [
        `[CÓPIA] ${orig.conteudo_bruto || ''}`,
        orig.latex_formatado, orig.tipo, orig.nivel, orig.serie, orig.bimestre,
        orig.disciplina, orig.habilidade_bncc, orig.imagem_base64,
        orig.alternativas_json, orig.correta,
        orig.texto_apoio, orig.fonte, orig.explicacao, orig.tags,
        escola_id, professor_id || null,
      ]
    );
    await registrarHistorico(r.insertId, 'duplicou', professor_id);
    res.status(201).json({ id: r.insertId, message: 'Questão duplicada com sucesso.' });
  } catch (err) {
    console.error('duplicarQuestao:', err);
    res.status(500).json({ message: 'Erro ao duplicar.', detail: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 8) GET /questoes/:id/historico — auditoria
// ─────────────────────────────────────────────────────────────────────────
export async function historicoQuestao(req, res) {
  const { id } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT h.*, p.titulo AS prova_titulo
       FROM questoes_historico h
       LEFT JOIN provas p ON p.id = h.prova_id
       WHERE h.questao_id = ?
       ORDER BY h.criado_em DESC LIMIT 50`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Erro ao buscar histórico.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7) POST /questoes/por-texto — Parsing de texto/PDF (mantido do legado)
// ─────────────────────────────────────────────────────────────────────────────
export async function criarQuestoesPorTexto(req, res) {
  const { escola_id } = req.user;
  try {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ error: "Campo 'texto' é obrigatório" });

    const blocos = texto.split("\n\n").map(b => b.trim()).filter(b => b);
    const criadas = [];

    for (const bloco of blocos) {
      const linhas = bloco.split("\n").map(l => l.trim()).filter(l => l);
      let enunciado = linhas[0];
      let disciplina = null;

      const metaMatch = enunciado.match(/^\[(.+?)\]/);
      if (metaMatch) {
        const [disc] = metaMatch[1].split(/[-–]/).map(s => s.trim());
        disciplina = disc;
        enunciado = enunciado.replace(/^\[.+?\]\s*/, "");
      }

      const alternativasArray = linhas
        .slice(1)
        .filter(l => /^\([A-Z]\)/.test(l))
        .map(l => ({ letra: l.match(/^\(([A-Z])\)/)[1], texto: l.replace(/^\([A-Z]\)\s*/, "") }));

      const alternativas_json = JSON.stringify(alternativasArray);
      const latex_formatado = `\\begin{question}\n\\textbf{${enunciado}}\n\n` +
        alternativasArray.map(({ letra, texto }) => `(${letra}) ${texto}`).join("\n") +
        "\n\\end{question}";

      const dados = { conteudo_bruto: bloco, latex_formatado, disciplina, alternativas_json, escola_id };
      const insertId = await Questao.criarQuestao(dados);
      criadas.push({ id: insertId, enunciado, disciplina, alternativas: alternativasArray });
    }

    return res.status(201).json({ total: criadas.length, questoes: criadas });
  } catch (err) {
    console.error("Erro em criarQuestoesPorTexto:", err);
    return res.status(500).json({ error: "Falha ao criar questões a partir do texto" });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 9) POST /questoes/extrair-imagem — Gemini Vision OCR + estruturação
//    Recebe: multipart/form-data { imagem: File }
//    Retorna: { enunciado, fonte, alternativas: [{letra, texto}], gabarito, confianca }
// ─────────────────────────────────────────────────────────────────────────────
export async function extrairQuestaoImagem(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "Nenhuma imagem enviada." });
    }

    const genAI = getGemini();
    const model = genAI.getGenerativeModel(
      { model: "gemini-1.5-flash" },
      { apiVersion: "v1" }   // v0.24 usa v1beta por padrão; gemini-1.5-flash requer v1
    );

    // Converte buffer para formato inline que a API Gemini aceita
    const imagePart = {
      inlineData: {
        data: req.file.buffer.toString("base64"),
        mimeType: req.file.mimetype,
      },
    };

    const prompt = `Você é um assistente especializado em extrair questões educacionais de imagens.

Analise a imagem e extraia a questão presente nela. Retorne APENAS um JSON válido, sem markdown, sem explicações, no formato exato abaixo:

{
  "enunciado": "texto completo do enunciado/pergunta",
  "fonte": "instituição ou prova de origem (ex: ENEM 2022, ISE Sta. Cecília-SP), deixe vazio se não houver",
  "alternativas": [
    { "letra": "A", "texto": "texto da alternativa A" },
    { "letra": "B", "texto": "texto da alternativa B" },
    { "letra": "C", "texto": "texto da alternativa C" },
    { "letra": "D", "texto": "texto da alternativa D" },
    { "letra": "E", "texto": "texto da alternativa E" }
  ],
  "gabarito": "letra da alternativa correta, ou null se não identificada",
  "tipo": "objetiva",
  "confianca": "alta|media|baixa"
}

Regras:
- Inclua apenas as alternativas presentes na imagem (pode ser 2, 3, 4 ou 5)
- Use letras maiúsculas: A, B, C, D, E
- Se a alternativa usar a) b) c) minúsculo, converta para A, B, C maiúsculo
- Preserve o texto exato, incluindo formatações como colchetes, fórmulas simples, etc.
- Se houver número da questão no início (ex: "03. (ISE...)", NÃO inclua no enunciado
- O gabarito geralmente é indicado por marcação, grifo ou asterisco na imagem. Se não houver, retorne null.
- confianca: "alta" se o texto está claro, "media" se parcialmente legível, "baixa" se muito ruim`;

    const result = await model.generateContent([prompt, imagePart]);
    const rawText = result.response.text().trim();

    // Remove blocos de código markdown se o modelo os incluir
    const jsonText = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let dados;
    try {
      dados = JSON.parse(jsonText);
    } catch {
      console.error("[extrairQuestaoImagem] Gemini retornou texto não-JSON:", rawText);
      return res.status(422).json({
        ok: false,
        message: "O modelo não conseguiu estruturar a questão. Tente com uma imagem mais nítida.",
        raw: rawText,
      });
    }

    // Normaliza letras maiúsculas e garante estrutura
    if (Array.isArray(dados.alternativas)) {
      dados.alternativas = dados.alternativas.map((a) => ({
        letra: String(a.letra || "").toUpperCase(),
        texto: String(a.texto || "").trim(),
      }));
    }
    if (dados.gabarito) {
      dados.gabarito = String(dados.gabarito).toUpperCase().trim();
    }

    console.log(
      `[extrairQuestaoImagem] OK — ${dados.alternativas?.length || 0} alternativas` +
      ` | gabarito: ${dados.gabarito || "N/A"} | confiança: ${dados.confianca}`
    );

    return res.json({ ok: true, ...dados });
  } catch (err) {
    console.error("[extrairQuestaoImagem] Erro:", err.message);

    if (err.message?.includes("GEMINI_API_KEY")) {
      return res.status(503).json({ ok: false, message: err.message });
    }
    return res.status(500).json({
      ok: false,
      message: "Erro ao processar imagem com Gemini.",
      detail: err.message,
    });
  }
}
