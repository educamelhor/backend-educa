// apps/educa-backend/routes/secretaria-agente.js
// ============================================================================
// ROTAS REST — MÓDULO AGENTE AUTÔNOMO DA SECRETARIA (SEEDF PDF Parser)
// ============================================================================

import { Router } from "express";
import multer from "multer";
import pool from "../db.js";
import { resolverDisciplina, reconciliarNotasComModulacao } from "../utils/disciplinasHelper.js";
import { extrairPaginasPdf, segmentarAlunos, extrairTabelaAluno } from "../utils/boletimEducadfParser.js";

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
 * Persiste (ou remove) a célula do bimestre selecionado de UMA disciplina de UM aluno.
 *
 * Regras (o EDUCADF é a fonte oficial e prevalece):
 *  - Célula com nota        → UPSERT da nota (+ faltas, se "Lançar Faltas" estiver ligado;
 *                             desligado → faltas já existentes são PRESERVADAS).
 *  - Célula SEM nota        → a nota existente no sistema é APAGADA.
 *                             Se "Lançar Faltas" estiver ligado e o PDF tiver faltas sem nota,
 *                             e a coluna `nota` aceitar NULL, grava nota nula + faltas.
 */
async function gravarCelula(conn, { escola_id, alunoId, ano, bim, discId, cel, faltasActive, notaNullable }) {
  const temNota = cel.nota !== null;
  const temFaltas = cel.faltas !== null;

  if (!temNota) {
    // Faltas sem nota (somente quando é possível guardar nota nula)
    if (notaNullable && faltasActive && temFaltas) {
      const [r] = await conn.query(
        `INSERT INTO notas (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas, data_lancamento)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NOW())
         ON DUPLICATE KEY UPDATE nota = NULL, faltas = VALUES(faltas), data_lancamento = NOW()`,
        [escola_id, alunoId, ano, bim, discId, cel.faltas]
      );
      return { acao: r.affectedRows === 1 ? "inserido" : "atualizado", semNota: true };
    }

    let afetadas = 0;
    if (!faltasActive && notaNullable) {
      // Faltas desligado: preserva as faltas já lançadas (só zera a nota)
      const [u] = await conn.query(
        `UPDATE notas SET nota = NULL
          WHERE escola_id = ? AND aluno_id = ? AND ano = ? AND bimestre = ? AND disciplina_id = ?
            AND nota IS NOT NULL AND faltas IS NOT NULL AND faltas > 0`,
        [escola_id, alunoId, ano, bim, discId]
      );
      afetadas += u.affectedRows || 0;
      const [d] = await conn.query(
        `DELETE FROM notas
          WHERE escola_id = ? AND aluno_id = ? AND ano = ? AND bimestre = ? AND disciplina_id = ?
            AND (faltas IS NULL OR faltas = 0)`,
        [escola_id, alunoId, ano, bim, discId]
      );
      afetadas += d.affectedRows || 0;
    } else {
      const [d] = await conn.query(
        `DELETE FROM notas
          WHERE escola_id = ? AND aluno_id = ? AND ano = ? AND bimestre = ? AND disciplina_id = ?`,
        [escola_id, alunoId, ano, bim, discId]
      );
      afetadas += d.affectedRows || 0;
    }
    return { acao: afetadas > 0 ? "removido" : "vazio" };
  }

  const faltasVal = faltasActive ? (temFaltas ? cel.faltas : 0) : 0;
  const sql = faltasActive
    ? `INSERT INTO notas (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas, data_lancamento)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE nota = VALUES(nota), faltas = VALUES(faltas), data_lancamento = NOW()`
    : `INSERT INTO notas (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas, data_lancamento)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE nota = VALUES(nota), data_lancamento = NOW()`;
  const [r] = await conn.query(sql, [escola_id, alunoId, ano, bim, discId, cel.nota, faltasVal]);
  return { acao: r.affectedRows === 1 ? "inserido" : "atualizado", faltas: faltasVal };
}

/**
 * POST /api/secretaria/agente/importar-boletim
 * Ingestão real e análise de múltiplos PDFs de boletins padrão SEEDF.
 *
 * Parser v3 — LEITURA POR COORDENADAS (utils/boletimEducadfParser.js):
 *   1. Cada número é atribuído ao bimestre pela sua POSIÇÃO horizontal no PDF
 *      (âncoras: cabeçalhos "M/C/N" e "Faltas"). Célula vazia fica vazia.
 *      Antes, os "pares nota/falta" eram pegos por índice e, quando o 1º
 *      bimestre estava vazio, a nota do 2º era gravada como 1º (e vice-versa).
 *   2. Estudantes são segmentados pelo cabeçalho "Nome do(a) Estudante:"
 *      (não depende de "2 páginas por aluno").
 *   3. Linhas com anomalia (valor fora de coluna, tipo incompatível, célula
 *      duplicada, nota fora de 0–10) NÃO são importadas e são avisadas no log.
 *   4. Bimestre vazio no PDF → nota existente no sistema é removida (EDUCADF prevalece).
 *   5. "Lançar Faltas" desligado → faltas já existentes são preservadas.
 *   6. Fundamental: só a tabela principal (blocos seguintes repetem "zeros").
 *      Médio: todas as tabelas (FGB + Itinerários), com conceitos EP/ES/ER/EI/SE.
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

  if (![1, 2, 3, 4].includes(bimNum)) {
    logs.push(`❌ [Agente] Bimestre inválido: ${bimestre}.`);
    return res.status(400).json({ ok: false, logs, message: "Bimestre inválido." });
  }

  if (!req.files || req.files.length === 0) {
    logs.push("❌ [Agente] Erro: Nenhum arquivo PDF foi enviado.");
    return res.status(400).json({ ok: false, logs, message: "Nenhum arquivo enviado." });
  }

  // 1. Carregar mapeamento de disciplinas da escola em memória
  let disciplinasEscola = [];
  try {
    const [rows] = await pool.query(
      "SELECT id, nome, nome_oficial, abreviatura FROM disciplinas WHERE escola_id = ?",
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
  let totalRemovidos = 0;
  let totalNaoImportados = 0;
  let totalFalhas = 0;
  let totalAlunos = 0;

  // Conexão com pool para gravação
  const conn = await pool.getConnection();

  // Cache de disciplinas por turma para priorizar correspondência com a modulação da turma
  const turmaDisciplinasMap = new Map();

  try {
    // A coluna `nota` aceita NULL? (define como tratar "faltas sem nota")
    let notaNullable = false;
    try {
      const [colRows] = await conn.query(
        `SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notas' AND COLUMN_NAME = 'nota' LIMIT 1`
      );
      notaNullable = colRows?.[0]?.n === "YES";
    } catch { /* assume NOT NULL */ }

    for (const file of req.files) {
      logs.push(`📂 [Agente] Lendo e mapeando arquivo: ${file.originalname} (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`);

      // ── Leitura do PDF com coordenadas (X/Y de cada texto) ───────────────
      let paginas;
      try {
        paginas = await extrairPaginasPdf(file.buffer);
      } catch (pdfErr) {
        logs.push(`❌ [Agente] Erro ao processar estrutura binária de ${file.originalname}: ${pdfErr.message}`);
        totalFalhas++;
        continue;
      }

      const alunosPdf = segmentarAlunos(paginas);
      logs.push(`🔍 [Agente] PDF carregado: ${paginas.length} página(s), ${alunosPdf.length} estudante(s) detectado(s).`);
      if (alunosPdf.length === 0) {
        logs.push("❌ [Agente] Nenhum boletim de estudante reconhecido neste arquivo (cabeçalho \"Nome do(a) Estudante:\" ausente).");
        totalFalhas++;
        continue;
      }

      const etapaArquivo = alunosPdf[0].etapa;
      logs.push(`🏷️ [Agente] Etapa detectada no arquivo: ${etapaArquivo === "MEDIO" ? "ENSINO MÉDIO" : "ENSINO FUNDAMENTAL"}`);
      logs.push("📐 [Agente] Leitura por posição das colunas: cada nota é atribuída ao bimestre pela coluna em que está no PDF.");

      for (const al of alunosPdf) {
        // Identificação do estudante
        if (!al.nome || !al.re) {
          logs.push(`⚠️ [Agente] Página ${al.paginaInicial}: não foi possível identificar estudante (Nome/RE). Pulando.`);
          continue;
        }
        if (al.anoLetivo && al.anoLetivo !== anoNum) {
          logs.push(`⚠️ [Agente] ${al.nome} (RE: ${al.re}): ano letivo do boletim (${al.anoLetivo}) difere do ano da importação (${anoNum}). Não importado.`);
          totalFalhas++;
          continue;
        }
        totalAlunos++;

        // Busca o aluno no banco pelo código (RE) com sua turma no ano letivo
        const [dbAlunos] = await conn.query(`
          SELECT a.id, a.estudante, COALESCE(m.turma_id, a.turma_id) AS turma_id
          FROM alunos a
          LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.ano_letivo = ? AND m.escola_id = ? AND m.status = 'ativo'
          WHERE a.codigo = ? AND a.escola_id = ? AND (a.status = 'ativo' OR a.status IS NULL)
          LIMIT 1
        `, [anoNum, escola_id, al.re, escola_id]);

        if (dbAlunos.length === 0) {
          logs.push(`❌ [Agente] Estudante "${al.nome}" (RE: ${al.re}) não encontrado como ativo no banco!`);
          totalFalhas++;
          continue;
        }

        const dbA = dbAlunos[0];
        logs.push(`👤 [Agente${al.etapa === "MEDIO" ? " Médio" : ""}] Importando: ${dbA.estudante} (RE: ${al.re} | ID: ${dbA.id}${dbA.turma_id ? ` | Turma: ${dbA.turma_id}` : ""})`);

        // Carrega disciplinas da modulação da turma do aluno, se houver
        let disciplinasTurma = [];
        if (dbA.turma_id) {
          if (!turmaDisciplinasMap.has(dbA.turma_id)) {
            const [turmaDiscs] = await conn.query(`
              SELECT DISTINCT d.id, d.nome, d.nome_oficial, d.abreviatura
              FROM modulacao m
              JOIN disciplinas d ON d.id = m.disciplina_id
              WHERE m.turma_id = ? AND m.escola_id = ?
            `, [dbA.turma_id, escola_id]);
            turmaDisciplinasMap.set(dbA.turma_id, turmaDiscs);
          }
          disciplinasTurma = turmaDisciplinasMap.get(dbA.turma_id);
        }

        // ── Leitura da tabela por coordenadas ──────────────────────────────
        const tabela = extrairTabelaAluno(al);
        if (tabela.erros.length > 0) {
          logs.push(`❌ [Agente] Layout do boletim de ${dbA.estudante} não reconhecido: ${tabela.erros.join(" | ")} Nenhuma alteração foi feita para este aluno.`);
          totalFalhas++;
          continue;
        }

        // Fundamental: só a tabela principal (as seguintes repetem disciplinas com "0,00").
        // Médio: FGB + todos os Itinerários/Unidades Curriculares.
        const linhas = al.etapa === "MEDIO" ? tabela.linhas : tabela.linhas.filter((l) => l.secao === 0);

        // Salvaguarda: nunca processa o mesmo discId duas vezes por aluno.
        const discIdsProcessados = new Set();
        let processadas = 0;

        for (const linha of linhas) {
          const discNameRaw = linha.nomeRaw;
          const rotulo = (discNameRaw || "(sem nome)").padEnd(26);

          // Linha com anomalia estrutural: NÃO importar e avisar
          if (linha.invalida) {
            logs.push(`  ⚠️ ${rotulo} | Não importado (leitura duvidosa): ${linha.anomalias.join("; ")}`);
            totalNaoImportados++;
            continue;
          }

          // Resolução da disciplina:
          // 1º Prioridade: Modulação da turma do aluno (correspondência exata com a turma)
          // 2º Prioridade: Catálogo global de disciplinas da escola
          let discObj = null;
          if (disciplinasTurma && disciplinasTurma.length > 0) {
            discObj = resolverDisciplina(discNameRaw, disciplinasTurma);
          }
          if (!discObj) {
            discObj = resolverDisciplina(discNameRaw, disciplinasEscola);
          }
          const discId = discObj ? discObj.id : null;

          if (!discId) {
            logs.push(`  ⚠️ Ignorado: "${discNameRaw}" (sem mapeamento na escola. Vincule em Secretaria > Disciplinas > Mapeamento Global)`);
            continue;
          }

          if (discIdsProcessados.has(discId)) {
            logs.push(`  ⏩ ${rotulo} | Duplicata ignorada.`);
            continue;
          }
          discIdsProcessados.add(discId);
          processadas++;

          if (linha.avisos && linha.avisos.length > 0) {
            logs.push(`  ℹ️ ${rotulo} | Atenção: ${linha.avisos.join("; ")}`);
          }

          // Célula do bimestre selecionado — vazia continua vazia
          const cel = linha.bim[bimNum];
          const r = await gravarCelula(conn, {
            escola_id,
            alunoId: dbA.id,
            ano: anoNum,
            bim: bimNum,
            discId,
            cel,
            faltasActive,
            notaNullable,
          });

          const notaDisplay = cel.nota === null
            ? "—"
            : (/^[A-Z]{2}$/.test(cel.notaRaw || "") ? `${cel.notaRaw} (${cel.nota.toFixed(1)})` : cel.nota.toFixed(2));

          const faltasLog = faltasActive ? (r.faltas ?? cel.faltas ?? 0) : "preservadas";
          if (r.acao === "inserido") {
            totalInseridos++;
            logs.push(`  ✔ ${rotulo} | ${bimNum}º Bim: ${notaDisplay} | Faltas: ${faltasLog}`);
          } else if (r.acao === "atualizado") {
            totalAtualizados++;
            logs.push(`  🔄 ${rotulo} | ${bimNum}º Bim: ${notaDisplay} | Faltas: ${faltasLog} (Atualizado)`);
          } else if (r.acao === "removido") {
            totalRemovidos++;
            logs.push(`  🗑️ ${rotulo} | ${bimNum}º Bim vazio no EDUCADF — nota existente removida do sistema.`);
          } else {
            logs.push(`  ⏭️ ${rotulo} | ${bimNum}º bim não lançado neste PDF.`);
          }
        }

        if (processadas === 0) {
          logs.push(`  ⚠️ Nenhuma disciplina processada para ${dbA.estudante}. Verifique os logs de "Ignorado" acima.`);
        }
      }
    }

    // ── Reconciliação automática pós-importação ────────────────────────
    try {
      const reconciliadas = await reconciliarNotasComModulacao(conn, escola_id);
      if (reconciliadas > 0) {
        logs.push(`🔄 [Agente] ${reconciliadas} nota(s) reconciliada(s) automaticamente com a modulação da turma.`);
      }
    } catch (recErr) {
      console.error("Erro na reconciliação pós-importação:", recErr);
    }

    logs.push("══════════════════════════════════════════════");
    logs.push("📊 RELATÓRIO FINAL DE EXECUÇÃO DO AGENTE");
    logs.push("══════════════════════════════════════════════");
    logs.push(`   Registros Inseridos   : ${totalInseridos}`);
    logs.push(`   Registros Atualizados : ${totalAtualizados}`);
    logs.push(`   Notas Removidas (vazio no EDUCADF): ${totalRemovidos}`);
    logs.push(`   Linhas Não Importadas (leitura duvidosa): ${totalNaoImportados}`);
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
        removidos: totalRemovidos,
        naoImportados: totalNaoImportados,
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
