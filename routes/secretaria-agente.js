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

  // 1. Carregar mapeamento de disciplinas da escola em memória
  let discMap = {};
  try {
    const [disciplinas] = await pool.query(
      "SELECT id, nome, nome_oficial FROM disciplinas WHERE escola_id = ?",
      [escola_id]
    );

    for (const d of disciplinas) {
      if (d.nome_oficial) {
        discMap[d.nome_oficial.trim().toUpperCase()] = d.id;
      }
      if (d.nome) {
        discMap[d.nome.trim().toUpperCase()] = d.id;
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

  // Conexão com transação/pool para gravação
  const conn = await pool.getConnection();

  try {
    for (const file of req.files) {
      logs.push(`📂 [Agente] Lendo e mapeando arquivo: ${file.originalname} (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`);

      // Ler páginas do PDF
      const pageTexts = [];
      const render_page = async (pageData) => {
        let render_options = {
          normalizeWhitespace: true,
          disableCombineTextItems: false
        };

        const textContent = await pageData.getTextContent(render_options);
        let lastY, text = "";
        for (let item of textContent.items) {
          if (lastY === item.transform[5] || !lastY) {
            text += " " + item.str;
          } else {
            text += "\n" + item.str;
          }
          lastY = item.transform[5];
        }
        pageTexts.push({
          page: pageData.pageNumber,
          text: text
        });
        return text;
      };

      try {
        await pdf(file.buffer, { pagerender: render_page });
        pageTexts.sort((a, b) => a.page - b.page);
        logs.push(`🔍 [Agente] PDF carregado: ${pageTexts.length} páginas detectadas.`);
      } catch (pdfErr) {
        logs.push(`❌ [Agente] Erro ao processar estrutura binária de ${file.originalname}: ${pdfErr.message}`);
        totalFalhas++;
        continue;
      }

      // Processar páginas ímpares (onde estão os boletins dos estudantes)
      for (let i = 0; i < pageTexts.length; i += 2) {
        const pageNum = i + 1;
        const text = pageTexts[i].text;

        const nameMatch = text.match(/Nome do\(a\) Estudante:\s*([^\r\n]+)/);
        const reMatch = text.match(/(?:RE\s*RE\s*nº|RERE\s*nº):\s*(\d+)/i);

        if (!nameMatch || !reMatch) {
          logs.push(`⚠️ [Agente] Falha de leitura/identificação na página ${pageNum}. Pulando página.`);
          continue;
        }

        const rawName = nameMatch[1].trim();
        let studentName = rawName;
        const cleanNameMatch = rawName.match(/^([^\(]+?)(?:\s*(?:RE\s*RE\s*nº|RERE\s*nº|\s*RE\s*nº))/i);
        if (cleanNameMatch) {
          studentName = cleanNameMatch[1].trim();
        } else {
          studentName = studentName.replace(/\s+RE\s*RE\s*nº.*$/i, "").trim();
        }

        const re = parseInt(reMatch[1].trim(), 10);
        totalAlunos++;

        // Obter estudante correspondente no banco
        const [dbAlunos] = await conn.query(
          "SELECT id, estudante FROM alunos WHERE codigo = ? AND escola_id = ? AND status = 'ativo' LIMIT 1",
          [re, escola_id]
        );

        if (dbAlunos.length === 0) {
          logs.push(`❌ [Agente] ERRO: Estudante "${studentName}" (RE: ${re}) não foi encontrado ativo no banco!`);
          totalFalhas++;
          continue;
        }

        const dbA = dbAlunos[0];
        logs.push(`👤 [Agente] Importando: ${dbA.estudante} (RE: ${re} | ID Banco: ${dbA.id})`);

        // Extrair disciplinas e notas
        const lines = text.split("\n");
        let parsedGrades = 0;

        for (const line of lines) {
          const match = line.match(/^([a-zA-ZáéíóúàèìòùâêîôûãõçÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÃÕÇ/ ]+?)\s+(\d+,\d+)\s+(\d+)\s+CURSANDO/i);
          if (match) {
            const discName = match[1].trim();
            const gradeVal = parseFloat(match[2].trim().replace(",", "."));
            const absencesVal = parseInt(match[3].trim(), 10);
            
            const discId = discMap[discName.toUpperCase()];

            if (discId) {
              const absencesToInsert = faltasActive ? absencesVal : 0;

              const [resUpsert] = await conn.query(`
                INSERT INTO notas
                  (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas, data_lancamento)
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                  nota = VALUES(nota),
                  faltas = VALUES(faltas),
                  data_lancamento = NOW()
              `, [escola_id, dbA.id, anoNum, bimNum, discId, gradeVal, absencesToInsert]);

              parsedGrades++;

              if (resUpsert.affectedRows === 1) {
                totalInseridos++;
                logs.push(`  ✔ ${discName.padEnd(22)} | Nota: ${gradeVal.toFixed(1)} | Faltas: ${absencesToInsert}`);
              } else if (resUpsert.affectedRows === 2) {
                totalAtualizados++;
                logs.push(`  🔄 ${discName.padEnd(22)} | Nota: ${gradeVal.toFixed(1)} | Faltas: ${absencesToInsert} (Atualizado)`);
              }
            } else {
              logs.push(`  ⚠️ Ignorado: "${discName}" (Não possui mapeamento oficial no sistema)`);
            }
          }
        }

        if (parsedGrades === 0) {
          logs.push(`  ⚠️ Nenhuma nota correspondente pôde ser estruturada para ${dbA.estudante}.`);
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
        alunos: totalAlunos
      },
      message: "Importação concluída com sucesso."
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
