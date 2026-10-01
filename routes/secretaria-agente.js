// apps/educa-backend/routes/secretaria-agente.js
// ============================================================================
// ROTAS REST — MÓDULO AGENTE AUTÔNOMO DA SECRETARIA (SEEDF PDF Parser)
// ============================================================================

import { Router } from "express";
import multer from "multer";
import pdf from "pdf-parse";
import pool from "../db.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Helper to ensure req.user exists and has a school ID
 */
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ ok: false, message: "Acesso negado: escola não definida." });
  }
  next();
}

/**
 * POST /api/secretaria/agente/importar-boletim
 * Ingestão real e análise de múltiplos PDFs de boletins padrão SEEDF.
 *
 * Parser v2 — Correções aplicadas:
 *   1. Normalização de encoding: pdf-parse entrega acentos corrompidos.
 *      Usamos NFD + strip de diacríticos para matching robusto.
 *   2. Multi-bimestre por linha: o EDUCADF coloca TODOS os bimestres
 *      lançados na mesma linha, ex: "ARTES 4,80 0 6,50 2 CURSANDO".
 *      O parser extrai todos os pares (nota, faltas) e persiste apenas
 *      o bimestre selecionado pelo usuário.
 *   3. PDF com 1 ou N alunos: funciona igualmente. Processa páginas
 *      ímpares em sequência (cada boletim ocupa 2 páginas no EDUCADF).
 */
router.post("/importar-boletim", verificarEscola, upload.array("files"), async (req, res) => {
  const { escola_id } = req.user;
  const { bimestre, lancarFaltas, ano } = req.body || {};

  const bimNum = parseInt(bimestre || "1", 10);
  const anoNum = parseInt(ano || "2026", 10);
  const faltasActive = lancarFaltas === "true" || lancarFaltas === true;

  const logs = [];
  logs.push("🤖 [Agente] Inicializando pipeline autônomo...");
  logs.push(`⚙️ [Agente] Parâmetros: Ano=${anoNum} | Bimestre=${bimNum}º | Lançar Faltas=${faltasActive ? "SIM" : "NÃO"}`);

  if (!req.files || req.files.length === 0) {
    logs.push("❌ [Agente] Erro: Nenhum arquivo PDF foi enviado.");
    return res.status(400).json({ ok: false, logs, message: "Nenhum arquivo enviado." });
  }

  // ── Mapeamento canônico universal da SEEDF ──────────────────────────────
  // Usado como correspondência bilateral quando a escola ainda não definiu
  // nome_oficial manualmente no modal "Mapeamento Global de Disciplinas".
  const SEEDF_CANONICAL_ALIASES = [
    {
      canon: "PARTE DIVERSIFICADA I",
      aliases: [
        "PARTE DIVERSIFICADA I", "PRATICA DIVERSIFICADA I", "PRATICAS DIVERSIFICADAS I",
        "PRATICA DIVERSIFICADA 1", "PRATICAS DIVERSIFICADAS 1", "PARTE DIVERSIFICADA 1"
      ]
    },
    {
      canon: "PARTE DIVERSIFICADA II",
      aliases: [
        "PARTE DIVERSIFICADA II", "PRATICA DIVERSIFICADA II", "PRATICAS DIVERSIFICADAS II",
        "PRATICA DIVERSIFICADA 2", "PRATICAS DIVERSIFICADAS 2", "PARTE DIVERSIFICADA 2"
      ]
    },
    {
      canon: "PARTE DIVERSIFICADA III",
      aliases: [
        "PARTE DIVERSIFICADA III", "PRATICA DIVERSIFICADA III", "PRATICAS DIVERSIFICADAS III",
        "PRATICA DIVERSIFICADA 3", "PRATICAS DIVERSIFICADAS 3", "PARTE DIVERSIFICADA 3"
      ]
    },
    {
      canon: "LÍNGUA PORTUGUESA",
      aliases: ["LINGUA PORTUGUESA", "PORTUGUES", "PORTUGUESA", "LP", "L PORTUGUESA"]
    },
    {
      canon: "MATEMÁTICA",
      aliases: ["MATEMATICA", "MAT"]
    },
    {
      canon: "CIÊNCIAS NATURAIS",
      aliases: ["CIENCIAS NATURAIS", "CIENCIAS", "CIENCIA", "CN"]
    },
    {
      canon: "EDUCAÇÃO FÍSICA",
      aliases: ["EDUCACAO FISICA", "ED FISICA", "ED. FISICA", "EF"]
    },
    {
      canon: "HISTÓRIA",
      aliases: ["HISTORIA", "HIST"]
    },
    {
      canon: "GEOGRAFIA",
      aliases: ["GEOGRAFIA", "GEO"]
    },
    {
      canon: "ARTES",
      aliases: ["ARTES", "ARTE"]
    },
    {
      canon: "LEM/INGLÊS",
      aliases: ["LEM/INGLES", "INGLES", "LEM INGLES", "LINGUA INGLESA", "LINGUA ESTRANGEIRA INGLES", "LINGUA ESTRANGEIRA INGLESA"]
    },
    {
      canon: "LEM/ESPANHOL",
      aliases: ["LEM/ESPANHOL", "ESPANHOL", "LEM ESPANHOL", "LINGUA ESPANHOLA"]
    },
    {
      canon: "ENSINO RELIGIOSO",
      aliases: ["ENSINO RELIGIOSO", "RELIGIAO", "ER"]
    },
    {
      canon: "BIOLOGIA",
      aliases: ["BIOLOGIA", "BIO"]
    },
    {
      canon: "FÍSICA",
      aliases: ["FISICA", "FIS"]
    },
    {
      canon: "QUÍMICA",
      aliases: ["QUIMICA", "QUI"]
    },
    {
      canon: "FILOSOFIA",
      aliases: ["FILOSOFIA", "FIL"]
    },
    {
      canon: "SOCIOLOGIA",
      aliases: ["SOCIOLOGIA", "SOC"]
    }
  ];

  const norm = (s) => (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]/g, " ").replace(/\s+/g, " ").trim();

  function resolverDisciplina(discNameRaw, listaDisciplinas) {
    if (!discNameRaw) return null;
    const targetNorm = norm(discNameRaw);

    // 1. Prioridade Máxima: nome_oficial configurado pela escola no modal
    for (const d of listaDisciplinas) {
      if (d.nome_oficial && norm(d.nome_oficial) === targetNorm) {
        return d;
      }
    }

    // 2. Segunda Prioridade: nome local exato/normalizado da disciplina
    for (const d of listaDisciplinas) {
      if (d.nome && norm(d.nome) === targetNorm) {
        return d;
      }
    }

    // 3. Terceira Prioridade: Busca via grupo canônico da SEEDF
    for (const group of SEEDF_CANONICAL_ALIASES) {
      const allVariants = [norm(group.canon), ...group.aliases.map(norm)];
      if (allVariants.includes(targetNorm)) {
        for (const d of listaDisciplinas) {
          const dNomeNorm = norm(d.nome);
          const dOficNorm = norm(d.nome_oficial);
          if (allVariants.includes(dNomeNorm) || (dOficNorm && allVariants.includes(dOficNorm))) {
            return d;
          }
        }
      }
    }

    return null;
  }

  // 1. Carregar mapeamento de disciplinas da escola em memória
  let disciplinasEscola = [];
  try {
    const [rows] = await pool.query(
      "SELECT id, nome, nome_oficial FROM disciplinas WHERE escola_id = ?",
      [escola_id]
    );
    disciplinasEscola = rows;
    logs.push(`🔗 [Agente] Carregadas ${disciplinasEscola.length} disciplina(s) cadastradas para a escola.`);
  } catch (err) {
    console.error("Erro ao carregar disciplinas:", err);
    logs.push("❌ [Agente] Erro ao buscar correspondência de disciplinas no banco.");
    return res.status(500).json({ ok: false, logs, message: "Erro de banco de dados." });
  }

  let totalInseridos = 0;
  let totalAtualizados = 0;
  let totalFalhas = 0;
  let totalAlunos = 0;

  // Conexão com pool para gravação
  const conn = await pool.getConnection();

  try {
    for (const file of req.files) {
      logs.push(`📂 [Agente] Lendo e mapeando arquivo: ${file.originalname} (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`);

      // ── Leitura do PDF página a página ──────────────────────────────────
      const pageTexts = [];
      const render_page = async (pageData) => {
        const textContent = await pageData.getTextContent({
          normalizeWhitespace: true,
          disableCombineTextItems: false,
        });
        let lastY, text = "";
        for (const item of textContent.items) {
          if (lastY === item.transform[5] || !lastY) {
            text += " " + item.str;
          } else {
            text += "\n" + item.str;
          }
          lastY = item.transform[5];
        }
        pageTexts.push({ page: pageData.pageNumber, text });
        return text;
      };

      try {
        await pdf(file.buffer, { pagerender: render_page });
        pageTexts.sort((a, b) => a.page - b.page);
        logs.push(`🔍 [Agente] PDF carregado: ${pageTexts.length} página(s) detectada(s).`);
      } catch (pdfErr) {
        logs.push(`❌ [Agente] Erro ao processar estrutura binária de ${file.originalname}: ${pdfErr.message}`);
        totalFalhas++;
        continue;
      }

      // ── PASSO 1: Detecção automática da etapa no cabeçalho do PDF ───────
      const firstPageRaw = pageTexts[0]?.text || "";
      const firstPageNorm = firstPageRaw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();

      const isMedio =
        firstPageNorm.includes("BOLETIM ESCOLAR - ENSINO MEDIO") ||
        firstPageNorm.includes("ENSINO MEDIO");

      const etapaDetectada = isMedio ? "MEDIO" : "FUNDAMENTAL";
      logs.push(`🏷️ [Agente] Etapa detectada no arquivo: ${etapaDetectada === "MEDIO" ? "ENSINO MÉDIO" : "ENSINO FUNDAMENTAL"}`);

      // ── PASSO 2: Roteamento por etapa (Lógica do Fundamental 100% intacta) ─
      if (etapaDetectada === "FUNDAMENTAL") {
        // ── FLUXO ENSINO FUNDAMENTAL (100% INTACTO E VALIDADO) ────────────
        // No padrão EDUCADF cada boletim ocupa 2 páginas (ímpares = dados, pares = rodapé).
        // Um arquivo com apenas 1 aluno tem 2 páginas, portanto processa só a página 1.
        // Um arquivo com N alunos processa páginas 1, 3, 5, ... N*2-1.
        for (let i = 0; i < pageTexts.length; i += 2) {
          const pageNum = i + 1;
          const rawText = pageTexts[i].text;

          // Identifica nome e RE do estudante na página
          const nameMatch = rawText.match(/Nome do\(a\) Estudante:\s*([^\r\n]+)/);
          const reMatch   = rawText.match(/(?:RE\s*RE\s*n[ºo]?|RERE\s*n[ºo]?):\s*(\d+)/i);

          if (!nameMatch || !reMatch) {
            logs.push(`⚠️ [Agente] Página ${pageNum}: não foi possível identificar estudante (Nome/RE). Pulando.`);
            continue;
          }

          const studentName = nameMatch[1].replace(/\s+RE\s*RE\s*n[ºo]?.*$/i, "").trim();
          const re = parseInt(reMatch[1].trim(), 10);
          totalAlunos++;

          // Busca o aluno no banco pelo código (RE)
          const [dbAlunos] = await conn.query(
            "SELECT id, estudante FROM alunos WHERE codigo = ? AND escola_id = ? AND status = 'ativo' LIMIT 1",
            [re, escola_id]
          );

          if (dbAlunos.length === 0) {
            logs.push(`❌ [Agente] Estudante "${studentName}" (RE: ${re}) não encontrado como ativo no banco!`);
            totalFalhas++;
            continue;
          }

          const dbA = dbAlunos[0];
          logs.push(`👤 [Agente] Importando: ${dbA.estudante} (RE: ${re} | ID: ${dbA.id})`);

          // ── Parser de notas — multi-bimestre ───────────────────────────────
          // O EDUCADF coloca todos os bimestres lançados na mesma linha:
          //   "ARTES 4,80 0 6,50 2 CURSANDO"          → pares: [(4.80,0), (6.50,2)]
          //   "PARTE DIVERSIFICADA II 3,07 0 CURSANDO" → pares: [(3.07,0)]
          //
          // ATENÇÃO: O PDF possui dois blocos de disciplinas na mesma página.
          // O pdf-parse decodifica os títulos normalmente (sem letras dobradas):
          //   Linha 11: "ITINERÁRIO FORMATIVO - ITINERÁRIO FORMATIVO -"  ← 1º header (antes das notas reais)
          //   Linha 19: "PARTE DIVERSIFICADA II 3,07 0 2,30 1 CURSANDO" ← notas reais
          //   Linha 29: "ITINERÁRIO FORMATIVO - ITINERÁRIO FORMATIVO -"  ← 2º header
          //   Linha 37: "PARTE DIVERSIFICADA II 0,00 0 0,00 0 CURSANDO" ← zeros que corrompem
          //
          // Solução: o PDF tem duas seções de disciplinas na mesma página.
          // A linha "ITINERÁRIO FORMATIVO - ITINERÁRIO FORMATIVO -" aparece tanto
          // ANTES quanto DEPOIS das notas reais — a do INÍCIO é o header repetido,
          // a do FINAL marca o início da seção de zeros que corromperia os dados.
          //
          // Estratégia: encontrar o marcador ITINERÁRIO que vem APÓS o primeiro
          // status escolar (âncora das notas reais), e cortar ali.
          const rawNorm = rawText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
          const MARKER_NORM = "ITINERARIO FORMATIVO";

          // Âncora: posição do primeiro status escolar (início das notas reais)
          const firstAnchor = rawNorm.search(/(?:CURSANDO|APROVADO|RECUPERACAO|REPROVADO)/);

          // Encontra o marcador que aparece DEPOIS do primeiro status escolar
          let markerPos = rawNorm.indexOf(MARKER_NORM);
          while (markerPos >= 0 && markerPos <= firstAnchor) {
            markerPos = rawNorm.indexOf(MARKER_NORM, markerPos + MARKER_NORM.length);
          }
          const cutPoint = (markerPos > firstAnchor) ? markerPos : rawText.length;

          const textParaCurriculo = rawText.substring(0, cutPoint);
          logs.push(`  📐 Currículo isolado: corte em ${cutPoint}/${rawText.length} (âncora em ${firstAnchor}, ITINERÁRIO pós-notas em ${markerPos}).`);

          const lines = textParaCurriculo.split("\n");
          let parsedGrades = 0;

          // Set de salvaguarda: nunca processa o mesmo discId duas vezes por aluno.
          const discIdsProcessados = new Set();

          for (const line of lines) {
            // Processa linhas que contenham indicação de situação escolar
            if (!/(?:CURSANDO|APROVADO|REPROVADO|RECUPERAÇÃO|RECUPERACAO)/i.test(line)) continue;

            // Extrai o nome da disciplina: texto antes do primeiro par "X,XX N"
            const discMatch = line.match(/^([A-ZÀ-ÿa-z/ .'-]{2,}?)\s*(\d+,\d+)\s+(\d+)/);
            if (!discMatch) continue;

            const discNameRaw = discMatch[1].trim();

            // Resolução bilateral e inteligente da disciplina:
            // 1º nome_oficial (modal) -> 2º nome local -> 3º aliases canônicos SEEDF
            const discObj = resolverDisciplina(discNameRaw, disciplinasEscola);
            const discId = discObj ? discObj.id : null;

            if (!discId) {
              logs.push(`  ⚠️ Ignorado: "${discNameRaw}" (sem mapeamento na escola. Vincule em Secretaria > Disciplinas > Mapeamento Global)`);
              continue;
            }

            // Salvaguarda: pula se já processou esta disciplina neste aluno
            if (discIdsProcessados.has(discId)) {
              logs.push(`  ⏩ ${discNameRaw.padEnd(26)} | Duplicata ignorada (seção ITINERÁRIO).`);
              continue;
            }
            discIdsProcessados.add(discId);

            // Extrai todos os pares (nota vírgula, faltas) da linha
            const pairRegex = /(\d+,\d+)\s+(\d+)/g;
            const pairs = [];
            let m;
            while ((m = pairRegex.exec(line)) !== null) {
              pairs.push({
                nota:   parseFloat(m[1].replace(",", ".")),
                faltas: parseInt(m[2], 10),
              });
            }

            // Seleciona o par do bimestre desejado (índice 0-based)
            const bimIdx = bimNum - 1;
            if (bimIdx >= pairs.length) {
              logs.push(`  ⏭️ ${discNameRaw.padEnd(26)} | ${bimNum}º bim não lançado neste PDF.`);
              continue;
            }

            const { nota: gradeVal, faltas: absencesVal } = pairs[bimIdx];
            const absencesToInsert = faltasActive ? absencesVal : 0;

            const [resUpsert] = await conn.query(`
              INSERT INTO notas
                (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas, data_lancamento)
              VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
              ON DUPLICATE KEY UPDATE
                nota             = VALUES(nota),
                faltas           = VALUES(faltas),
                data_lancamento  = NOW()
            `, [escola_id, dbA.id, anoNum, bimNum, discId, gradeVal, absencesToInsert]);

            parsedGrades++;

            if (resUpsert.affectedRows === 1) {
              totalInseridos++;
              logs.push(`  ✔ ${discNameRaw.padEnd(26)} | ${bimNum}º Bim: ${gradeVal.toFixed(2)} | Faltas: ${absencesToInsert}`);
            } else if (resUpsert.affectedRows === 2) {
              totalAtualizados++;
              logs.push(`  🔄 ${discNameRaw.padEnd(26)} | ${bimNum}º Bim: ${gradeVal.toFixed(2)} | Faltas: ${absencesToInsert} (Atualizado)`);
            }
          }

          if (parsedGrades === 0) {
            logs.push(`  ⚠️ Nenhuma nota estruturada para ${dbA.estudante}. Verifique os logs de "Ignorado" acima.`);
          }
        }
      } else {
        // ── FLUXO ENSINO MÉDIO (Páginas 1 e 2 agregadas, FGB e Itinerários) ─
        // No Ensino Médio cada estudante ocupa 2 páginas:
        // Página 1: Formação Geral Básica (FGB) e início dos Itinerários
        // Página 2: Continuação dos Itinerários Formativos (Unidades Curriculares)
        for (let i = 0; i < pageTexts.length; i += 2) {
          const pageNum1 = i + 1;
          const pageNum2 = i + 2;
          const p1Raw = pageTexts[i]?.text || "";
          const p2Raw = pageTexts[i + 1]?.text || "";

          // Identifica nome e RE do estudante na primeira página do boletim
          const nameMatch = p1Raw.match(/Nome do\(a\) Estudante:\s*([^\r\n]+)/);
          const reMatch   = p1Raw.match(/(?:RE\s*RE\s*n[ºo]?|RERE\s*n[ºo]?):\s*(\d+)/i);

          if (!nameMatch || !reMatch) {
            logs.push(`⚠️ [Agente] Páginas ${pageNum1}/${pageNum2}: não foi possível identificar estudante (Nome/RE). Pulando.`);
            continue;
          }

          const studentName = nameMatch[1].replace(/\s+RE\s*RE\s*n[ºo]?.*$/i, "").trim();
          const re = parseInt(reMatch[1].trim(), 10);
          totalAlunos++;

          // Busca o aluno no banco pelo código (RE)
          const [dbAlunos] = await conn.query(
            "SELECT id, estudante FROM alunos WHERE codigo = ? AND escola_id = ? AND status = 'ativo' LIMIT 1",
            [re, escola_id]
          );

          if (dbAlunos.length === 0) {
            logs.push(`❌ [Agente] Estudante "${studentName}" (RE: ${re}) não encontrado como ativo no banco!`);
            totalFalhas++;
            continue;
          }

          const dbA = dbAlunos[0];
          logs.push(`👤 [Agente Médio] Importando: ${dbA.estudante} (RE: ${re} | ID: ${dbA.id})`);

          // Isolamento das tabelas de notas da página 1 e página 2 (corta antes do rodapé de assinatura)
          const p2Cut = p2Raw.search(/Data de Emissão:/i);
          const p2Curriculo = p2Cut > 0 ? p2Raw.substring(0, p2Cut) : p2Raw;

          const combinedLines = [...p1Raw.split("\n"), ...p2Curriculo.split("\n")];
          let parsedGrades = 0;

          // Reconstrução de linhas com união de quebras de linha em nomes longos de disciplinas
          let inGradesTable = false;
          const discLines = [];
          let pendingPrefix = "";

          for (let l of combinedLines) {
            l = l.trim();
            if (!l) continue;

            if (/Data de Emissão:/i.test(l)) {
              inGradesTable = false;
              continue;
            }
            if (/Situação/i.test(l)) {
              inGradesTable = true;
              pendingPrefix = "";
              continue;
            }
            if (!inGradesTable) continue;

            if (/^ITINERÁRIO FORMATIVO -/i.test(l) || /^Componentes\/Unidades/i.test(l) || /^[0-9]\.º Bimestre/i.test(l)) {
              pendingPrefix = "";
              continue;
            }
            if (/^(?:ABA|Cur\.Temp|AP|AC|CC|EP|ES|ER|EI|SE|REC|RE|RP|RF)\s+(?:ABA|Cur\.Temp|AP|AC|CC|EP|ES|ER|EI|SE|REC|RE|RP|RF)/i.test(l)) {
              continue;
            }

            const hasStatus = /(?:CURSANDO|APROVADO|REPROVADO|RECUPERAÇÃO|RECUPERACAO)/i.test(l);
            const hasGrade = /\d+,\d+|\b(?:EP|ES|ER|EI|SE)\b/.test(l);

            if (hasStatus && hasGrade) {
              const full = pendingPrefix ? (pendingPrefix + " " + l) : l;
              pendingPrefix = "";
              discLines.push(full);
            } else {
              pendingPrefix = pendingPrefix ? (pendingPrefix + " " + l) : l;
            }
          }

          // Set de salvaguarda: nunca processa o mesmo discId duas vezes por aluno
          const discIdsProcessados = new Set();

          // Mapa de conceitos formativos da SEEDF para escala decimal
          const CONCEITO_NOTA_MAP = {
            EP: 10.0, // Envolvimento Pleno
            ES: 8.0,  // Envolvimento Satisfatório
            ER: 6.0,  // Envolvimento Regular
            EI: 4.0,  // Envolvimento Insatisfatório
            SE: 0.0,  // Sem Envolvimento
          };

          for (const line of discLines) {
            // Extrai o nome da disciplina antes do primeiro número ou conceito
            const discMatch = line.match(/^([A-ZÀ-ÿa-z0-9/ .'-]{2,}?)\s+(?:\d+,\d+|\b(?:EP|ES|ER|EI|SE)\b)/);
            if (!discMatch) continue;

            const discNameRaw = discMatch[1].trim();

            const discObj = resolverDisciplina(discNameRaw, disciplinasEscola);
            const discId = discObj ? discObj.id : null;

            if (!discId) {
              logs.push(`  ⚠️ Ignorado: "${discNameRaw}" (sem mapeamento na escola. Vincule em Secretaria > Disciplinas > Mapeamento Global)`);
              continue;
            }

            if (discIdsProcessados.has(discId)) {
              logs.push(`  ⏩ ${discNameRaw.padEnd(26)} | Duplicata ignorada.`);
              continue;
            }
            discIdsProcessados.add(discId);

            // Extrai pares de nota/falta ou conceito/falta
            const pairRegex = /(\d+,\d+|\b(?:EP|ES|ER|EI|SE)\b)\s+(\d+)/g;
            const pairs = [];
            let m;
            while ((m = pairRegex.exec(line)) !== null) {
              const rawVal = m[1].toUpperCase();
              let notaNum = 0;
              if (CONCEITO_NOTA_MAP[rawVal] !== undefined) {
                notaNum = CONCEITO_NOTA_MAP[rawVal];
              } else {
                notaNum = parseFloat(rawVal.replace(",", "."));
              }
              pairs.push({
                nota: notaNum,
                faltas: parseInt(m[2], 10),
                rawNota: rawVal,
              });
            }

            // Seleciona o par do bimestre desejado (índice 0-based)
            const bimIdx = bimNum - 1;
            if (bimIdx >= pairs.length) {
              logs.push(`  ⏭️ ${discNameRaw.padEnd(26)} | ${bimNum}º bim não lançado neste PDF.`);
              continue;
            }

            const { nota: gradeVal, faltas: absencesVal, rawNota } = pairs[bimIdx];
            const absencesToInsert = faltasActive ? absencesVal : 0;

            const [resUpsert] = await conn.query(`
              INSERT INTO notas
                (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas, data_lancamento)
              VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
              ON DUPLICATE KEY UPDATE
                nota             = VALUES(nota),
                faltas           = VALUES(faltas),
                data_lancamento  = NOW()
            `, [escola_id, dbA.id, anoNum, bimNum, discId, gradeVal, absencesToInsert]);

            parsedGrades++;

            const notaDisplay = rawNota && isNaN(rawNota) ? `${rawNota} (${gradeVal.toFixed(1)})` : gradeVal.toFixed(2);
            if (resUpsert.affectedRows === 1) {
              totalInseridos++;
              logs.push(`  ✔ ${discNameRaw.padEnd(26)} | ${bimNum}º Bim: ${notaDisplay} | Faltas: ${absencesToInsert}`);
            } else if (resUpsert.affectedRows === 2) {
              totalAtualizados++;
              logs.push(`  🔄 ${discNameRaw.padEnd(26)} | ${bimNum}º Bim: ${notaDisplay} | Faltas: ${absencesToInsert} (Atualizado)`);
            }
          }

          if (parsedGrades === 0) {
            logs.push(`  ⚠️ Nenhuma nota estruturada para ${dbA.estudante}. Verifique os logs de "Ignorado" acima.`);
          }
        }
      }
    }

    logs.push("══════════════════════════════════════════════");
    logs.push("📊 RELATÓRIO FINAL DE EXECUÇÃO DO AGENTE");
    logs.push("══════════════════════════════════════════════");
    logs.push(`   Registros Inseridos   : ${totalInseridos}`);
    logs.push(`   Registros Atualizados : ${totalAtualizados}`);
    logs.push(`   Total de Falhas/Erros : ${totalFalhas}`);
    logs.push(`   Estudantes Processados: ${totalAlunos}`);
    logs.push("══════════════════════════════════════════════");
    logs.push("🎉 [Agente] Rotina de importação finalizada com sucesso!");

    return res.json({
      ok: true,
      logs,
      stats: {
        inseridos: totalInseridos,
        atualizados: totalAtualizados,
        falhas: totalFalhas,
        alunos: totalAlunos,
      },
      message: "Importação concluída com sucesso.",
    });

  } catch (globalErr) {
    console.error("Erro fatal no agente:", globalErr);
    logs.push(`❌ [Agente] Erro fatal no pipeline de importação: ${globalErr.message}`);
    return res.status(500).json({ ok: false, logs, message: "Erro fatal durante o processamento." });
  } finally {
    conn.release();
  }
});

export default router;
