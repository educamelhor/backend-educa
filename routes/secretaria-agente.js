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

  // ── Normaliza texto removendo diacríticos para matching robusto ──────────
  // O pdf-parse pode entregar 'LÍNGUA PORTUGUESA' como 'L\uFFFDNGUA PORTUGUESA'.
  // Ao normalizar ambos os lados (PDF e banco) conseguimos fazer o match.
  const normalizeStr = (s) =>
    (s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // remove diacríticos
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();

  // 1. Carregar mapeamento de disciplinas da escola em memória
  let discMap = {};     // chave: nome exato (upper) → id
  let discMapNorm = {}; // chave: nome normalizado (sem acento, upper) → id
  try {
    const [disciplinas] = await pool.query(
      "SELECT id, nome, nome_oficial FROM disciplinas WHERE escola_id = ?",
      [escola_id]
    );

    for (const d of disciplinas) {
      // Registra pelo nome_oficial (ex: "PARTE DIVERSIFICADA II") e pelo nome amigável (ex: "Geometria")
      if (d.nome_oficial) {
        const key = d.nome_oficial.trim().toUpperCase();
        discMap[key] = d.id;
        discMapNorm[normalizeStr(d.nome_oficial)] = d.id;
      }
      if (d.nome) {
        const key = d.nome.trim().toUpperCase();
        discMap[key] = d.id;
        discMapNorm[normalizeStr(d.nome)] = d.id;
      }
    }
    logs.push(`🔗 [Agente] Carregados ${disciplinas.length} mapeamentos de disciplinas da escola.`);
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

      // ── Processar páginas ímpares (boletim do estudante) ─────────────────
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
        // Extraímos todos os pares e salvamos apenas o bimestre escolhido (bimNum).
        const lines = rawText.split("\n");
        let parsedGrades = 0;

        for (const line of lines) {
          // Só processa linhas que contenham "CURSANDO"
          if (!/CURSANDO/i.test(line)) continue;

          // Extrai o nome da disciplina: texto antes do primeiro "X,XX N"
          const discMatch = line.match(/^([A-ZÀ-ÿa-z/ ]{3,}?)\s+(\d+,\d+)\s+(\d+)/);
          if (!discMatch) continue;

          const discNameRaw = discMatch[1].trim();

          // Tenta mapear — primeiro com normalização (resistente a encoding),
          // depois pela chave direta como fallback.
          const discNameNorm = normalizeStr(discNameRaw);
          const discId = discMapNorm[discNameNorm] ?? discMap[discNameRaw.toUpperCase()];

          if (!discId) {
            logs.push(`  ⚠️ Ignorado: "${discNameRaw}" → normalizado: "${discNameNorm}" (sem mapeamento na escola)`);
            continue;
          }

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
