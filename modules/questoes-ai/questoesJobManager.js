// modules/questoes-ai/questoesJobManager.js
// EDUCA.STUDIO AI — Motor Assíncrono de Processamento em Background + Telemetria em Tempo Real
// Inspirado na arquitetura assíncrona do Solver Urânia (Gerar Horários) e Agente EDUCA (HTTP 202 Accepted):
// - Elimina 100% dos timeouts de 30s (Axios) e 60s (Proxy/Gateway DigitalOcean/Cloudflare).
// - Persistência híbrida (RAM + MySQL `questoes_ai_jobs` / `questoes_ai_job_paginas`) segura para múltiplas instâncias.
// - Suporta execução concorrente controlada (2 páginas simultâneas por job), streaming incremental
//   de questões conforme cada página termina e parada imediata ("Parar e Usar Questões Já Extraídas").

import crypto from 'crypto';
import pool from '../../db.js';
import { extrairListaDePaginaMultimodal, extrairListaPorTextoIA } from './sheetSplitter.agent.js';
import { extrairQuestaoMultimodal } from './visionExtractor.agent.js';

const CONCORRENCIA_PAGINAS_POR_JOB = 2;
const WATCHDOG_PAGINA_TRAVADA_SEGUNDOS = 125;

function serializarContextoPagina(ultimoTextoApoio = '', contextoProximaPagina = null) {
  if (!contextoProximaPagina) return ultimoTextoApoio || null;
  return JSON.stringify({
    __env_v1: true,
    ultimo_texto_apoio: ultimoTextoApoio || '',
    contexto_proxima_pagina: contextoProximaPagina,
  });
}

function desserializarContextoPagina(raw) {
  if (!raw) return { ultimo_texto_apoio: '', contexto_proxima_pagina: null };
  const str = String(raw);
  if (str.startsWith('{"__env_v1":true')) {
    try {
      const parsed = JSON.parse(str);
      return {
        ultimo_texto_apoio: parsed.ultimo_texto_apoio || '',
        contexto_proxima_pagina: parsed.contexto_proxima_pagina || null,
      };
    } catch { /* fallback string */ }
  }
  return { ultimo_texto_apoio: str, contexto_proxima_pagina: null };
}

let _tablesReadyPromise = null;

async function ensureJobTables() {
  if (_tablesReadyPromise) return _tablesReadyPromise;
  _tablesReadyPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questoes_ai_jobs (
        job_id VARCHAR(64) NOT NULL PRIMARY KEY,
        escola_id INT NOT NULL,
        usuario_id INT DEFAULT NULL,
        modo VARCHAR(24) NOT NULL DEFAULT 'visual',
        status VARCHAR(24) NOT NULL DEFAULT 'recebendo',
        total_paginas INT NOT NULL DEFAULT 1,
        paginas_recebidas INT NOT NULL DEFAULT 0,
        paginas_concluidas INT NOT NULL DEFAULT 0,
        paginas_com_erro INT NOT NULL DEFAULT 0,
        etapa_atual VARCHAR(255) DEFAULT '',
        modelo_ativo VARCHAR(80) DEFAULT '',
        disciplina_padrao VARCHAR(80) DEFAULT '',
        serie_padrao VARCHAR(80) DEFAULT '',
        erro_msg TEXT DEFAULT NULL,
        cancelado TINYINT(1) NOT NULL DEFAULT 0,
        iniciado_em BIGINT NOT NULL,
        atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_escola_atualizado (escola_id, atualizado_em)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS questoes_ai_job_paginas (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        job_id VARCHAR(64) NOT NULL,
        ordem_lote INT NOT NULL DEFAULT 1,
        pagina_numero INT NOT NULL DEFAULT 1,
        status_pagina VARCHAR(24) NOT NULL DEFAULT 'fila',
        etapa_pagina VARCHAR(255) DEFAULT '',
        modelo_ia VARCHAR(80) DEFAULT '',
        ultimo_texto_apoio TEXT DEFAULT NULL,
        questoes_count INT NOT NULL DEFAULT 0,
        questoes_json LONGTEXT DEFAULT NULL,
        erro_pagina TEXT DEFAULT NULL,
        atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_job_ordem (job_id, ordem_lote),
        INDEX idx_job_status (job_id, status_pagina)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Limpeza silenciosa de jobs antigos (> 6 horas)
    pool.query(`
      DELETE p FROM questoes_ai_job_paginas p
      INNER JOIN questoes_ai_jobs j ON j.job_id = p.job_id
      WHERE j.atualizado_em < DATE_SUB(NOW(), INTERVAL 6 HOUR)
    `).catch(() => {});
    pool.query(`
      DELETE FROM questoes_ai_jobs WHERE atualizado_em < DATE_SUB(NOW(), INTERVAL 6 HOUR)
    `).catch(() => {});
  })().catch((err) => {
    _tablesReadyPromise = null;
    throw err;
  });
  return _tablesReadyPromise;
}

// Filas locais de buffers de imagem p/ execução em background sem bloquear HTTP
// Map<jobId, { running: number, tasks: Array<...>, canceladoLocal: boolean }>
const _localWorkerQueues = new Map();

function getOrCreateLocalQueue(jobId) {
  if (!_localWorkerQueues.has(jobId)) {
    _localWorkerQueues.set(jobId, { running: 0, tasks: [], canceladoLocal: false });
  }
  return _localWorkerQueues.get(jobId);
}

async function isJobCancelado(jobId) {
  const q = _localWorkerQueues.get(jobId);
  if (q?.canceladoLocal) return true;
  try {
    const [[row]] = await pool.query(
      'SELECT cancelado, status FROM questoes_ai_jobs WHERE job_id = ? LIMIT 1',
      [jobId]
    );
    if (!row || row.cancelado === 1 || row.status === 'cancelado') {
      if (q) q.canceladoLocal = true;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

async function recomputarStatusConsolidadoJob(jobId) {
  const [[job]] = await pool.query(
    'SELECT total_paginas, paginas_recebidas, cancelado, status FROM questoes_ai_jobs WHERE job_id = ? LIMIT 1',
    [jobId]
  );
  if (!job) return;

  const [pags] = await pool.query(
    `SELECT status_pagina, questoes_count, erro_pagina, modelo_ia
       FROM questoes_ai_job_paginas
      WHERE job_id = ?
      ORDER BY ordem_lote ASC`,
    [jobId]
  );

  const concluidas = pags.filter((p) => p.status_pagina === 'concluida').length;
  const erros = pags.filter((p) => p.status_pagina === 'erro').length;
  const finalizadas = concluidas + erros;
  const totalQuestoes = pags.reduce((acc, p) => acc + (Number(p.questoes_count) || 0), 0);
  const ultimoModelo = [...pags].reverse().find((p) => p.modelo_ia)?.modelo_ia || '';

  if (job.cancelado === 1 || job.status === 'cancelado') {
    await pool.query(
      `UPDATE questoes_ai_jobs
          SET paginas_concluidas = ?, paginas_com_erro = ?, modelo_ativo = COALESCE(NULLIF(?, ''), modelo_ativo),
              status = 'cancelado',
              etapa_atual = ?
        WHERE job_id = ?`,
      [
        concluidas,
        erros,
        ultimoModelo,
        `Interrompido pelo usuário · ${totalQuestoes} questão(ões) preservada(s).`,
        jobId,
      ]
    );
    _localWorkerQueues.delete(jobId);
    return;
  }

  if (finalizadas >= job.total_paginas && job.paginas_recebidas >= job.total_paginas) {
    if (concluidas === 0 && erros > 0) {
      const primeiroErro = pags.find((p) => p.erro_pagina)?.erro_pagina || 'Falha ao processar páginas no Agente Multimodal.';
      await pool.query(
        `UPDATE questoes_ai_jobs
            SET paginas_concluidas = ?, paginas_com_erro = ?, status = 'erro',
                erro_msg = ?, etapa_atual = 'Falha no processamento.'
          WHERE job_id = ?`,
        [concluidas, erros, primeiroErro, jobId]
      );
    } else {
      await pool.query(
        `UPDATE questoes_ai_jobs
            SET paginas_concluidas = ?, paginas_com_erro = ?,
                modelo_ativo = COALESCE(NULLIF(?, ''), modelo_ativo),
                status = 'concluido',
                etapa_atual = ?
          WHERE job_id = ?`,
        [
          concluidas,
          erros,
          ultimoModelo,
          `Concluído! ${totalQuestoes} questão(ões) individualizada(s) em ${concluidas} página(s).`,
          jobId,
        ]
      );
    }
    _localWorkerQueues.delete(jobId);
  } else {
    await pool.query(
      `UPDATE questoes_ai_jobs
          SET paginas_concluidas = ?, paginas_com_erro = ?,
              modelo_ativo = COALESCE(NULLIF(?, ''), modelo_ativo)
        WHERE job_id = ?`,
      [concluidas, erros, ultimoModelo, jobId]
    );
  }
}

/**
 * Drena a fila local de páginas do job em background (até CONCORRENCIA_PAGINAS_POR_JOB em paralelo).
 */
function dispararWorkersLocais(jobId) {
  const q = _localWorkerQueues.get(jobId);
  if (!q || q.canceladoLocal) return;

  while (q.running < CONCORRENCIA_PAGINAS_POR_JOB && q.tasks.length > 0) {
    const task = q.tasks.shift();
    q.running++;

    setImmediate(async () => {
      try {
        if (await isJobCancelado(jobId)) return;

        await pool.query(
          `UPDATE questoes_ai_job_paginas
              SET status_pagina = 'processando', etapa_pagina = ?
            WHERE job_id = ? AND ordem_lote = ?`,
          [`Página ${task.paginaNumero}: Iniciando leitura multimodal...`, jobId, task.ordemLote]
        );
        await pool.query(
          `UPDATE questoes_ai_jobs
              SET status = 'processando', etapa_atual = ?
            WHERE job_id = ? AND status != 'cancelado'`,
          [`Analisando Página ${task.paginaNumero} (${task.ordemLote} de ${task.totalPaginas})...`, jobId]
        );

        // Tenta recuperar ultimo_texto_apoio da página imediatamente anterior, se já tiver concluído
        let textoAnterior = '';
        if (task.ordemLote > 1) {
          try {
            const [[prevRow]] = await pool.query(
              `SELECT ultimo_texto_apoio FROM questoes_ai_job_paginas
                WHERE job_id = ? AND ordem_lote = ? LIMIT 1`,
              [jobId, task.ordemLote - 1]
            );
            textoAnterior = desserializarContextoPagina(prevRow?.ultimo_texto_apoio).ultimo_texto_apoio;
          } catch { /* ignore */ }
        }

        const resultado = await extrairListaDePaginaMultimodal(task.buffer, task.mimeType, {
          disciplinaSugerida: task.disciplina,
          serieSugerida: task.serie,
          paginaNumero: task.paginaNumero,
          ultimoTextoApoio: textoAnterior,
          onProgress: (msg) => {
            pool.query(
              `UPDATE questoes_ai_jobs SET etapa_atual = ? WHERE job_id = ? AND status = 'processando'`,
              [msg, jobId]
            ).catch(() => {});
            pool.query(
              `UPDATE questoes_ai_job_paginas SET etapa_pagina = ? WHERE job_id = ? AND ordem_lote = ?`,
              [msg, jobId, task.ordemLote]
            ).catch(() => {});
          },
        });

        // Libera referência ao buffer da página imediatamente para GC
        task.buffer = null;

        if (await isJobCancelado(jobId)) return;

        const questoesArr = Array.isArray(resultado.questoes) ? resultado.questoes : [];
        await pool.query(
          `UPDATE questoes_ai_job_paginas
              SET status_pagina = 'concluida',
                  etapa_pagina = 'Concluída',
                  modelo_ia = ?,
                  ultimo_texto_apoio = ?,
                  questoes_count = ?,
                  questoes_json = ?
            WHERE job_id = ? AND ordem_lote = ?`,
          [
            resultado.modelo_ia || '',
            serializarContextoPagina(resultado.ultimo_texto_apoio, resultado.contexto_proxima_pagina),
            questoesArr.length,
            JSON.stringify(questoesArr),
            jobId,
            task.ordemLote,
          ]
        );
      } catch (err) {
        task.buffer = null;
        console.error(`[questoesJobManager] Erro na página ${task.paginaNumero} do job ${jobId}:`, err?.message);
        const msgErro = err?.detail ? `${err.message} (${err.detail})` : (err?.message || 'Falha ao processar página.');
        await pool.query(
          `UPDATE questoes_ai_job_paginas
              SET status_pagina = 'erro', etapa_pagina = 'Erro', erro_pagina = ?
            WHERE job_id = ? AND ordem_lote = ?`,
          [msgErro.slice(0, 1000), jobId, task.ordemLote]
        ).catch(() => {});
      } finally {
        q.running = Math.max(0, q.running - 1);
        await recomputarStatusConsolidadoJob(jobId).catch((e) =>
          console.warn('[questoesJobManager] recomputarStatusConsolidadoJob:', e?.message)
        );
        dispararWorkersLocais(jobId);
      }
    });
  }
}

/**
 * 1) Cria um novo Job Assíncrono (visual para páginas PDF/fotos, ou texto imediato).
 */
export async function criarJobExtracaoLista({
  escolaId,
  usuarioId = null,
  modo = 'visual',
  totalPaginas = 1,
  disciplina = '',
  serie = '',
  texto = '',
}) {
  await ensureJobTables();

  const jobId = `qjob_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
  const totalNorm = Math.max(1, Math.min(20, Number(totalPaginas) || 1));
  const statusInicial = modo === 'texto' ? 'processando' : 'recebendo';
  const etapaInicial = modo === 'texto'
    ? 'Iniciando análise da lista em texto com IA...'
    : `Preparando recebimento de ${totalNorm} página(s)...`;

  await pool.query(
    `INSERT INTO questoes_ai_jobs (
       job_id, escola_id, usuario_id, modo, status, total_paginas,
       paginas_recebidas, paginas_concluidas, etapa_atual,
       disciplina_padrao, serie_padrao, iniciado_em, atualizado_em
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NOW())`,
    [
      jobId,
      Number(escolaId),
      usuarioId ? Number(usuarioId) : null,
      modo === 'texto' ? 'texto' : 'visual',
      statusInicial,
      modo === 'texto' ? 1 : totalNorm,
      modo === 'texto' ? 1 : 0,
      etapaInicial,
      String(disciplina || '').trim(),
      String(serie || '').trim(),
      Date.now(),
    ]
  );

  if (modo === 'texto') {
    await pool.query(
      `INSERT INTO questoes_ai_job_paginas (job_id, ordem_lote, pagina_numero, status_pagina, etapa_pagina)
       VALUES (?, 1, 1, 'processando', 'Individualizando texto bruto...')`,
      [jobId]
    );

    setImmediate(async () => {
      try {
        const resTexto = await extrairListaPorTextoIA(texto, {
          disciplinaSugerida: String(disciplina || '').trim(),
          serieSugerida: String(serie || '').trim(),
          onProgress: (msg) => {
            pool.query(
              `UPDATE questoes_ai_jobs SET etapa_atual = ? WHERE job_id = ? AND status = 'processando'`,
              [msg, jobId]
            ).catch(() => {});
          },
        });
        const questoesArr = Array.isArray(resTexto.questoes) ? resTexto.questoes : [];
        await pool.query(
          `UPDATE questoes_ai_job_paginas
              SET status_pagina = 'concluida', modelo_ia = ?, questoes_count = ?, questoes_json = ?
            WHERE job_id = ? AND ordem_lote = 1`,
          [resTexto.modelo_ia || '', questoesArr.length, JSON.stringify(questoesArr), jobId]
        );
      } catch (err) {
        const msgErro = err?.detail ? `${err.message} (${err.detail})` : (err?.message || 'Erro ao processar texto.');
        await pool.query(
          `UPDATE questoes_ai_job_paginas
              SET status_pagina = 'erro', erro_pagina = ?
            WHERE job_id = ? AND ordem_lote = 1`,
          [msgErro.slice(0, 1000), jobId]
        ).catch(() => {});
      } finally {
        await recomputarStatusConsolidadoJob(jobId).catch(() => {});
      }
    });
  }

  return { jobId, status: statusInicial };
}

/**
 * 2) Enfileira 1 página de imagem em um Job Visual existente e responde imediatamente (202 Accepted).
 */
export async function enfileirarPaginaNoJob({
  jobId,
  escolaId,
  fileBuffer,
  mimeType,
  paginaNumero = 1,
  ordemLote = 1,
}) {
  await ensureJobTables();

  const [[job]] = await pool.query(
    `SELECT job_id, escola_id, total_paginas, disciplina_padrao, serie_padrao, cancelado, status
       FROM questoes_ai_jobs
      WHERE job_id = ? AND escola_id = ?
      LIMIT 1`,
    [jobId, Number(escolaId)]
  );

  if (!job) {
    const err = new Error('Sessão de importação não encontrada.');
    err.httpStatus = 404;
    throw err;
  }
  if (job.cancelado === 1 || job.status === 'cancelado') {
    return { jobId, aceita: false, status: 'cancelado' };
  }

  const ordemNorm = Math.max(1, Number(ordemLote) || 1);
  const pagNorm = Math.max(1, Number(paginaNumero) || ordemNorm);

  await pool.query(
    `INSERT INTO questoes_ai_job_paginas (job_id, ordem_lote, pagina_numero, status_pagina, etapa_pagina)
     VALUES (?, ?, ?, 'fila', 'Aguardando na fila de visão...')
     ON DUPLICATE KEY UPDATE pagina_numero = VALUES(pagina_numero)`,
    [jobId, ordemNorm, pagNorm]
  );

  const [[{ recebidas }]] = await pool.query(
    'SELECT COUNT(*) AS recebidas FROM questoes_ai_job_paginas WHERE job_id = ?',
    [jobId]
  );

  await pool.query(
    `UPDATE questoes_ai_jobs
        SET paginas_recebidas = ?,
            status = CASE WHEN status = 'recebendo' THEN 'processando' ELSE status END
      WHERE job_id = ?`,
    [Number(recebidas) || 1, jobId]
  );

  const q = getOrCreateLocalQueue(jobId);
  q.tasks.push({
    ordemLote: ordemNorm,
    paginaNumero: pagNorm,
    totalPaginas: job.total_paginas,
    disciplina: job.disciplina_padrao || '',
    serie: job.serie_padrao || '',
    buffer: fileBuffer,
    mimeType: mimeType || 'image/jpeg',
  });

  dispararWorkersLocais(jobId);

  return { jobId, aceita: true, pagina_numero: pagNorm, ordem_lote: ordemNorm };
}

/**
 * 3) Cria e dispara um Job Assíncrono para Clonagem de 1 Print Único (`ImagemParaQuestaoModal`),
 *    evitando também qualquer timeout de 30s em prints complexos de 2 colunas.
 */
export async function criarJobPrintUnico({ escolaId, usuarioId = null, fileBuffer, mimeType }) {
  await ensureJobTables();

  const jobId = `qsingle_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
  await pool.query(
    `INSERT INTO questoes_ai_jobs (
       job_id, escola_id, usuario_id, modo, status, total_paginas,
       paginas_recebidas, paginas_concluidas, etapa_atual, iniciado_em, atualizado_em
     ) VALUES (?, ?, ?, 'print_unico', 'processando', 1, 1, 0, 'Analisando print e isolando figuras em alta definição...', ?, NOW())`,
    [jobId, Number(escolaId), usuarioId ? Number(usuarioId) : null, Date.now()]
  );

  await pool.query(
    `INSERT INTO questoes_ai_job_paginas (job_id, ordem_lote, pagina_numero, status_pagina, etapa_pagina)
     VALUES (?, 1, 1, 'processando', 'Clonando questão com Visão Computacional...')`,
    [jobId]
  );

  setImmediate(async () => {
    try {
      const dados = await extrairQuestaoMultimodal(fileBuffer, mimeType);
      await pool.query(
        `UPDATE questoes_ai_job_paginas
            SET status_pagina = 'concluida', modelo_ia = ?, questoes_count = 1, questoes_json = ?
          WHERE job_id = ? AND ordem_lote = 1`,
        [dados.modelo_ia || '', JSON.stringify([dados]), jobId]
      );
      await pool.query(
        `UPDATE questoes_ai_jobs
            SET paginas_concluidas = 1, modelo_ativo = ?, status = 'concluido', etapa_atual = 'Questão clonada com sucesso!'
          WHERE job_id = ?`,
        [dados.modelo_ia || '', jobId]
      );
    } catch (err) {
      const msgErro = err?.detail ? `${err.message} (${err.detail})` : (err?.message || 'Erro ao processar imagem.');
      await pool.query(
        `UPDATE questoes_ai_job_paginas SET status_pagina = 'erro', erro_pagina = ? WHERE job_id = ? AND ordem_lote = 1`,
        [msgErro.slice(0, 1000), jobId]
      ).catch(() => {});
      await pool.query(
        `UPDATE questoes_ai_jobs SET paginas_com_erro = 1, status = 'erro', erro_msg = ?, etapa_atual = 'Erro no processamento.' WHERE job_id = ?`,
        [msgErro.slice(0, 1000), jobId]
      ).catch(() => {});
    }
  });

  return { jobId, status: 'processando' };
}

/**
 * 4) Consulta ultrarrápida (< 30ms) de Telemetria + Questões já extraídas.
 */
export async function consultarStatusJob({ jobId, escolaId }) {
  await ensureJobTables();

  // Watchdog anti-travamento: se alguma página ficou órfã em 'processando' por > 125s (ex: queda de socket/container),
  // destrava automaticamente para que o job consolide e entregue todas as páginas concluídas sem prender o professor.
  const [updStuck] = await pool.query(
    `UPDATE questoes_ai_job_paginas p
     INNER JOIN questoes_ai_jobs j ON j.job_id = p.job_id
        SET p.status_pagina = 'erro',
            p.etapa_pagina = 'Tempo limite atingido',
            p.erro_pagina = 'Tempo limite excedido na leitura desta página. As demais páginas foram preservadas.'
      WHERE p.job_id = ? AND j.escola_id = ?
        AND p.status_pagina = 'processando'
        AND TIMESTAMPDIFF(SECOND, p.atualizado_em, NOW()) > ?`,
    [jobId, Number(escolaId), WATCHDOG_PAGINA_TRAVADA_SEGUNDOS]
  );
  if (updStuck?.affectedRows > 0) {
    await recomputarStatusConsolidadoJob(jobId).catch(() => {});
  }

  const [[job]] = await pool.query(
    `SELECT job_id, modo, status, total_paginas, paginas_recebidas, paginas_concluidas,
            paginas_com_erro, etapa_atual, modelo_ativo, erro_msg, cancelado, iniciado_em
       FROM questoes_ai_jobs
      WHERE job_id = ? AND escola_id = ?
      LIMIT 1`,
    [jobId, Number(escolaId)]
  );

  if (!job) {
    const err = new Error('Job não encontrado.');
    err.httpStatus = 404;
    throw err;
  }

  const [paginasRows] = await pool.query(
    `SELECT ordem_lote, pagina_numero, status_pagina, etapa_pagina, modelo_ia,
            ultimo_texto_apoio, questoes_count, questoes_json, erro_pagina
       FROM questoes_ai_job_paginas
      WHERE job_id = ?
      ORDER BY ordem_lote ASC`,
    [jobId]
  );

  const todasQuestoes = [];
  const avisos = [];
  const paginasDetalhe = [];
  let carryOverDaPaginaAnterior = null;

  for (const r of paginasRows) {
    paginasDetalhe.push({
      ordem: r.ordem_lote,
      pagina_numero: r.pagina_numero,
      status: r.status_pagina,
      etapa: r.etapa_pagina || '',
      questoes_count: r.questoes_count || 0,
      erro: r.erro_pagina || null,
    });

    if (r.status_pagina === 'concluida' && r.questoes_json) {
      try {
        const arr = JSON.parse(r.questoes_json);
        if (Array.isArray(arr)) {
          // Vincula figura/texto de chamada de fim da página anterior (ex: Pág 5 rodapé -> Q18 no topo da Pág 6)
          if (carryOverDaPaginaAnterior && arr.length > 0) {
            const primeira = { ...arr[0] };
            if (carryOverDaPaginaAnterior.texto) {
              primeira.texto_apoio = [carryOverDaPaginaAnterior.texto, primeira.texto_apoio]
                .filter(Boolean)
                .join('\n\n')
                .trim();
            }
            if (carryOverDaPaginaAnterior.midia && !primeira.midia) {
              primeira.midia = carryOverDaPaginaAnterior.midia;
              primeira.imagem_url = carryOverDaPaginaAnterior.midia.url || null;
            }
            arr[0] = primeira;
          }
          todasQuestoes.push(...arr);
        }
      } catch { /* ignore */ }
      carryOverDaPaginaAnterior = desserializarContextoPagina(r.ultimo_texto_apoio).contexto_proxima_pagina;
    } else {
      carryOverDaPaginaAnterior = null;
    }

    if (r.status_pagina === 'erro' && r.erro_pagina) {
      avisos.push(`Página ${r.pagina_numero}: ${r.erro_pagina}`);
    }
  }

  return {
    ok: true,
    jobId: job.job_id,
    modo: job.modo,
    status: job.status,
    elapsed_ms: Math.max(0, Date.now() - Number(job.iniciado_em || Date.now())),
    total_paginas: job.total_paginas,
    paginas_recebidas: job.paginas_recebidas,
    paginas_concluidas: job.paginas_concluidas,
    paginas_com_erro: job.paginas_com_erro,
    etapa_atual: job.etapa_atual || '',
    modelo_ativo: job.modelo_ativo || '',
    erro_msg: job.erro_msg || null,
    avisos,
    paginas: paginasDetalhe,
    total_questoes: todasQuestoes.length,
    questoes: todasQuestoes,
  };
}

/**
 * 5) Cancela o Job preservando todas as questões já extraídas ("Parar e Usar").
 */
export async function cancelarJobExtracao({ jobId, escolaId }) {
  await ensureJobTables();

  const q = _localWorkerQueues.get(jobId);
  if (q) {
    q.canceladoLocal = true;
    q.tasks = [];
  }

  await pool.query(
    `UPDATE questoes_ai_jobs
        SET cancelado = 1, status = 'cancelado',
            etapa_atual = 'Parado pelo professor · Preservando questões já extraídas...'
      WHERE job_id = ? AND escola_id = ?`,
    [jobId, Number(escolaId)]
  );

  await recomputarStatusConsolidadoJob(jobId).catch(() => {});
  return consultarStatusJob({ jobId, escolaId });
}
