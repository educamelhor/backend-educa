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

// ─── Helper — Audit trail em questoes_historico ────────────────────────────
// Não crítico: erros aqui não interrompem o fluxo principal
async function registrarHistorico(questao_id, acao, usuario_id, prova_id = null) {
  try {
    await pool.query(
      `INSERT IGNORE INTO questoes_historico
         (questao_id, usuario_id, acao, prova_id, criado_em)
       VALUES (?, ?, ?, ?, NOW())`,
      [questao_id, usuario_id || null, acao, prova_id || null]
    );
  } catch {
    // Silencioso — tabela pode não existir em ambientes legados
  }
}


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
    texto_apoio, fonte, explicacao, tags, temas,
    compartilhada = 0, status = 'ativa',
  } = req.body;

  // Gabarito por conteúdo — invariante à permutação de alternativas
  const correta_texto = resolverTextoCorreta(alternativas_json, correta);

  try {
    const [result] = await pool.query(
      `INSERT INTO questoes (
        conteudo_bruto, latex_formatado, tipo, nivel, serie, bimestre,
        disciplina, habilidade_bncc, imagem_base64, alternativas_json, correta, correta_texto,
        texto_apoio, fonte, explicacao, tags, temas, compartilhada, status,
        escola_id, professor_id, vezes_utilizada, criada_em, atualizada_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`,
      [
        conteudo_bruto  || null, latex_formatado  || null,
        tipo            || 'objetiva', nivel || 'medio',
        serie           || null, bimestre || null,
        disciplina      || null, habilidade_bncc || null,
        imagem_base64   || null, alternativas_json || null, correta || null, correta_texto,
        texto_apoio     || null, fonte || null, explicacao || null,
        tags            || '',
        temas           ? (typeof temas === 'string' ? temas : JSON.stringify(temas)) : null,
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
    texto_apoio, fonte, explicacao, tags, temas,
    compartilhada, status,
  } = req.body;

  // Gabarito por conteúdo — invariante à permutação de alternativas
  const correta_texto = resolverTextoCorreta(alternativas_json, correta);

  try {
    const [result] = await pool.query(
      `UPDATE questoes SET
        conteudo_bruto = ?, latex_formatado = ?, tipo = ?, nivel = ?,
        serie = ?, bimestre = ?, disciplina = ?, habilidade_bncc = ?,
        imagem_base64 = ?, alternativas_json = ?, correta = ?, correta_texto = ?,
        texto_apoio = ?, fonte = ?, explicacao = ?, tags = ?, temas = ?,
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
        correta_texto,
        texto_apoio       || null,
        fonte             || null,
        explicacao        || null,
        tags              || "",
        temas ? (typeof temas === 'string' ? temas : JSON.stringify(temas)) : null,
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
  const { escola_id, professor_id, perfil } = req.user;
  const hard = req.query.hard === '1';
  const isGestor = ['diretor', 'coordenador', 'admin', 'militar'].includes(perfil);

  try {
    // Verifica se a questão existe — inclui escola_id NULL (questões legadas)
    const [[questao]] = await pool.query(
      'SELECT id, professor_id FROM questoes WHERE id = ? AND (escola_id = ? OR escola_id IS NULL)',
      [id, escola_id]
    );
    if (!questao)
      return res.status(404).json({ message: 'Questão não encontrada.' });

    // RBAC: apenas o autor ou gestores (diretor/coord/admin) podem arquivar/excluir
    const isAutor = professor_id && Number(questao.professor_id) === Number(professor_id);
    if (!isAutor && !isGestor)
      return res.status(403).json({ message: 'Apenas o autor da questão pode arquivá-la ou excluí-la.' });

    let result;
    if (hard) {
      [result] = await pool.query(
        'DELETE FROM questoes WHERE id = ? AND (escola_id = ? OR escola_id IS NULL)',
        [id, escola_id]
      );
      await registrarHistorico(id, 'excluiu_definitivo', professor_id);
    } else {
      [result] = await pool.query(
        "UPDATE questoes SET status = 'arquivada', atualizada_em = NOW() WHERE id = ? AND (escola_id = ? OR escola_id IS NULL)",
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
// HELPER — Resolve o TEXTO da alternativa correta a partir de alternativas_json
// Usado para gabarito por conteúdo (invariante à permutação de alternativas)
// ─────────────────────────────────────────────────────────────────────────────
function resolverTextoCorreta(alternativas_json, correta) {
  if (!alternativas_json || !correta) return null;
  try {
    const alts =
      typeof alternativas_json === "string"
        ? JSON.parse(alternativas_json)
        : alternativas_json;
    if (!Array.isArray(alts)) return null;
    const alt = alts.find(
      (a) =>
        String(a.letra || a.letter || "").toUpperCase() ===
        String(correta).toUpperCase()
    );
    return alt ? String(alt.texto || alt.text || alt.conteudo || "").trim() || null : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10) POST /questoes/:id/publicar — Publica questão no Banco Global
//     Cria registro em questoes_banco_global e marca a questão local.
//     Qualquer escola poderá buscar e usar essa questão.
// ─────────────────────────────────────────────────────────────────────────────
export async function publicarQuestao(req, res) {
  const { id } = req.params;
  const { escola_id, professor_id } = req.user;
  try {
    // Busca a questão local
    const [[q]] = await pool.query(
      `SELECT * FROM questoes WHERE id = ? AND escola_id = ?`,
      [id, escola_id]
    );
    if (!q) return res.status(404).json({ message: "Questão não encontrada." });

    // Garante que campos obrigatórios estão preenchidos
    if (!q.conteudo_bruto?.trim()) {
      return res.status(400).json({ message: "O enunciado é obrigatório para publicar." });
    }
    if (!q.disciplina) {
      return res.status(400).json({ message: "A disciplina é obrigatória para publicar." });
    }

    // Resolve texto da alternativa correta (ponto 1 do usuário)
    const correta_texto = resolverTextoCorreta(q.alternativas_json, q.correta);

    // Evita duplicatas: verifica se já foi publicada
    if (q.publicada_globalmente && q.global_id) {
      // Atualiza a entrada existente (sync)
      await pool.query(
        `UPDATE questoes_banco_global SET
           conteudo_bruto = ?, latex_formatado = ?, tipo = ?, nivel = ?, serie = ?,
           disciplina = ?, habilidade_bncc = ?, temas = ?,
           alternativas_json = ?, correta = ?, correta_texto = ?,
           texto_apoio = ?, fonte = ?, explicacao = ?, tags = ?,
           atualizada_em = NOW()
         WHERE id = ?`,
        [
          q.conteudo_bruto, q.latex_formatado, q.tipo, q.nivel, q.serie,
          q.disciplina, q.habilidade_bncc,
          q.temas || null,
          q.alternativas_json, q.correta, correta_texto,
          q.texto_apoio, q.fonte, q.explicacao, q.tags,
          q.global_id,
        ]
      );
      const codigo = `EMQG-${String(q.global_id).padStart(5, "0")}`;
      return res.json({
        message: "Questão republicada no Banco Global com sucesso.",
        global_id: q.global_id,
        codigo,
      });
    }

    // Insere no banco global
    const [ins] = await pool.query(
      `INSERT INTO questoes_banco_global (
         conteudo_bruto, latex_formatado, tipo, nivel, serie,
         disciplina, habilidade_bncc, temas,
         alternativas_json, correta, correta_texto,
         texto_apoio, fonte, explicacao, tags,
         escola_id_origem, professor_id_origem, uso_count, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'publicada')`,
      [
        q.conteudo_bruto, q.latex_formatado || null, q.tipo || "objetiva",
        q.nivel || "medio", q.serie || null,
        q.disciplina, q.habilidade_bncc || null,
        q.temas || null,
        q.alternativas_json || null, q.correta || null, correta_texto,
        q.texto_apoio || null, q.fonte || null, q.explicacao || null,
        q.tags || null,
        escola_id, professor_id || null,
      ]
    );
    const globalId = ins.insertId;
    const codigo = `EMQG-${String(globalId).padStart(5, "0")}`;

    // Marca a questão local como publicada
    await pool.query(
      `UPDATE questoes SET
         publicada_globalmente = 1, global_id = ?, correta_texto = ?, atualizada_em = NOW()
       WHERE id = ?`,
      [globalId, correta_texto, id]
    );

    console.log(`[BancoGlobal] Questão ${id} publicada → global_id=${globalId} (${codigo})`);
    res.status(201).json({
      message: "Questão publicada no Banco Global com sucesso!",
      global_id: globalId,
      codigo,
    });
  } catch (err) {
    console.error("[publicarQuestao] Erro:", err);
    res.status(500).json({ message: "Erro ao publicar questão.", detail: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11) GET /questoes/global — Busca no Banco Global (todas as escolas)
//     Filtros: disciplina, nivel, serie, busca (texto), temas, ordenar
//     Acesso: qualquer escola autenticada
// ─────────────────────────────────────────────────────────────────────────────
export async function buscarBancoGlobal(req, res) {
  const {
    disciplina, nivel, serie, busca, tema,
    page = 1, limit = 30, ordenar = "mais_usadas",
  } = req.query;

  const conds = ["g.status = 'publicada'"];
  const params = [];

  if (disciplina) { conds.push("g.disciplina = ?");    params.push(disciplina); }
  if (nivel)      { conds.push("g.nivel = ?");         params.push(nivel); }
  if (serie)      { conds.push("g.serie = ?");         params.push(serie); }
  if (tema)       { conds.push("JSON_SEARCH(g.temas, 'one', ?) IS NOT NULL"); params.push(tema); }
  if (busca) {
    conds.push("(g.conteudo_bruto LIKE ? OR g.tags LIKE ? OR g.habilidade_bncc LIKE ?)");
    params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
  }

  const where = conds.join(" AND ");
  const ordemMap = {
    mais_usadas: "g.uso_count DESC, g.id DESC",
    recentes:    "g.publicada_em DESC",
    disciplina:  "g.disciplina ASC, g.uso_count DESC",
  };
  const orderBy = ordemMap[ordenar] || ordemMap.mais_usadas;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    const [questoes] = await pool.query(
      `SELECT
         g.id,
         CONCAT('EMQG-', LPAD(g.id, 5, '0')) AS codigo,
         g.conteudo_bruto, g.tipo, g.nivel, g.serie,
         g.disciplina, g.habilidade_bncc, g.temas,
         g.alternativas_json, g.correta, g.correta_texto,
         g.fonte, g.tags, g.uso_count,
         g.escola_id_origem, g.professor_id_origem,
         g.publicada_em
       FROM questoes_banco_global g
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM questoes_banco_global g WHERE ${where}`,
      params
    );

    res.json({
      questoes,
      pagination: {
        total, page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error("[buscarBancoGlobal] Erro:", err);
    res.status(500).json({ message: "Erro ao buscar banco global." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12) GET /questoes/global/:id — Detalhe de uma questão do banco global
// ─────────────────────────────────────────────────────────────────────────────
export async function getQuestaoGlobal(req, res) {
  const { id } = req.params;
  try {
    const [[q]] = await pool.query(
      `SELECT *, CONCAT('EMQG-', LPAD(id, 5, '0')) AS codigo
       FROM questoes_banco_global WHERE id = ? AND status = 'publicada'`,
      [id]
    );
    if (!q) return res.status(404).json({ message: "Questão não encontrada no banco global." });
    res.json(q);
  } catch (err) {
    res.status(500).json({ message: "Erro ao buscar questão." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 13) POST /questoes/global/:id/usar — Registra uso de questão global
//     - Cria entrada em questoes_uso_escola (banco da escola)
//     - Incrementa uso_count na questão global (ranking)
//     - Retorna dados completos da questão para importar na prova
// ─────────────────────────────────────────────────────────────────────────────
export async function registrarUsoGlobal(req, res) {
  const { id } = req.params;
  const { escola_id, professor_id } = req.user;
  const { contexto = "prova", contexto_id = null } = req.body;

  try {
    const [[q]] = await pool.query(
      `SELECT *, CONCAT('EMQG-', LPAD(id, 5, '0')) AS codigo
       FROM questoes_banco_global WHERE id = ? AND status = 'publicada'`,
      [id]
    );
    if (!q) return res.status(404).json({ message: "Questão não encontrada no banco global." });

    // Registra o uso
    await pool.query(
      `INSERT INTO questoes_uso_escola
         (questao_global_id, escola_id, professor_id, contexto, contexto_id)
       VALUES (?, ?, ?, ?, ?)`,
      [id, escola_id, professor_id || null, contexto, contexto_id]
    );

    // Incrementa ranking global
    await pool.query(
      `UPDATE questoes_banco_global SET uso_count = uso_count + 1 WHERE id = ?`,
      [id]
    );

    console.log(`[BancoGlobal] Questão global #${id} usada por escola=${escola_id} (${contexto})`);
    res.json({ message: "Uso registrado.", questao: q });
  } catch (err) {
    console.error("[registrarUsoGlobal] Erro:", err);
    res.status(500).json({ message: "Erro ao registrar uso." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 14) GET /questoes/global/banco-escola — Banco específico da escola
//     Retorna questões do banco global que a escola já usou (deduplicado)
// ─────────────────────────────────────────────────────────────────────────────
export async function getBancoEscola(req, res) {
  const { escola_id } = req.user;
  const { disciplina, nivel, busca, page = 1, limit = 30 } = req.query;

  const conds = ["u.escola_id = ?", "g.status = 'publicada'"];
  const params = [escola_id];

  if (disciplina) { conds.push("g.disciplina = ?"); params.push(disciplina); }
  if (nivel)      { conds.push("g.nivel = ?");      params.push(nivel); }
  if (busca) {
    conds.push("(g.conteudo_bruto LIKE ? OR g.tags LIKE ?)");
    params.push(`%${busca}%`, `%${busca}%`);
  }

  const where = conds.join(" AND ");
  const offset = (Number(page) - 1) * Number(limit);

  try {
    const [questoes] = await pool.query(
      `SELECT
         g.id,
         CONCAT('EMQG-', LPAD(g.id, 5, '0')) AS codigo,
         g.conteudo_bruto, g.tipo, g.nivel, g.serie,
         g.disciplina, g.habilidade_bncc, g.temas,
         g.alternativas_json, g.correta, g.correta_texto,
         g.fonte, g.tags, g.uso_count,
         COUNT(u.id) AS vezes_usada_escola,
         MAX(u.usado_em) AS ultimo_uso
       FROM questoes_uso_escola u
       JOIN questoes_banco_global g ON g.id = u.questao_global_id
       WHERE ${where}
       GROUP BY g.id
       ORDER BY vezes_usada_escola DESC, ultimo_uso DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(DISTINCT u.questao_global_id) AS total
       FROM questoes_uso_escola u
       JOIN questoes_banco_global g ON g.id = u.questao_global_id
       WHERE ${where}`,
      params
    );

    res.json({
      questoes,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("[getBancoEscola] Erro:", err);
    res.status(500).json({ message: "Erro ao buscar banco da escola." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 15) GET /questoes/global/stats — Estatísticas do banco global
// ─────────────────────────────────────────────────────────────────────────────
export async function statsGlobal(req, res) {
  try {
    const [[totais]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM(uso_count) AS total_usos FROM questoes_banco_global WHERE status='publicada'`
    );
    const [porDisciplina] = await pool.query(
      `SELECT disciplina, COUNT(*) AS total, SUM(uso_count) AS usos
       FROM questoes_banco_global WHERE status='publicada' AND disciplina IS NOT NULL
       GROUP BY disciplina ORDER BY total DESC LIMIT 15`
    );
    const [maisUsadas] = await pool.query(
      `SELECT id, CONCAT('EMQG-', LPAD(id, 5, '0')) AS codigo,
              conteudo_bruto, disciplina, nivel, uso_count
       FROM questoes_banco_global WHERE status='publicada' AND uso_count > 0
       ORDER BY uso_count DESC LIMIT 10`
    );
    res.json({ totais, porDisciplina, maisUsadas });
  } catch (err) {
    res.status(500).json({ message: "Erro ao buscar stats globais." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 16) DELETE /questoes/global/:id — Remove questão do Banco Global
//     - Soft delete por padrão (status = 'removida')
//     - Hard delete via ?hard=1
//     - Cópias na tabela `questoes` (escola) NÃO são afetadas
//     - Apenas o autor (professor_id_origem) ou gestor pode excluir
// ─────────────────────────────────────────────────────────────────────────────
export async function excluirQuestaoGlobal(req, res) {
  const { id } = req.params;
  const { professor_id, perfil } = req.user;
  const hard = req.query.hard === '1';
  const isGestor = ['diretor', 'coordenador', 'admin', 'militar'].includes(perfil);

  try {
    const [[q]] = await pool.query(
      'SELECT id, professor_id_origem FROM questoes_banco_global WHERE id = ? AND status = ?',
      [id, 'publicada']
    );
    if (!q) return res.status(404).json({ message: 'Questão não encontrada no banco global.' });

    // Apenas o autor original ou gestor pode remover do banco global
    const isAutor = professor_id && Number(q.professor_id_origem) === Number(professor_id);
    if (!isAutor && !isGestor)
      return res.status(403).json({ message: 'Apenas o autor da questão pode removê-la do banco global.' });

    if (hard) {
      await pool.query('DELETE FROM questoes_banco_global WHERE id = ?', [id]);
    } else {
      await pool.query(
        "UPDATE questoes_banco_global SET status = 'removida', atualizada_em = NOW() WHERE id = ?",
        [id]
      );
      // Desmarca a questão local como publicada (se existir cópia na escola do autor)
      await pool.query(
        'UPDATE questoes SET publicada_globalmente = 0, global_id = NULL WHERE global_id = ?',
        [id]
      );
    }

    res.status(204).end();
  } catch (err) {
    console.error('[excluirQuestaoGlobal] Erro:', err);
    res.status(500).json({ message: 'Erro ao remover questão do banco global.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 16) POST /questoes/extrair-imagem — Gemini Vision OCR + estruturação
export async function extrairQuestaoImagem(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "Nenhuma imagem enviada." });
    }

    const genAI = getGemini();
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
