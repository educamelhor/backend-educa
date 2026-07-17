// routes/agente-planos.js
// ============================================================================
// POST /api/agente-planos/:id/exportar-estrutura
// POST /api/agente-planos/:id/exportar-notas
// ============================================================================
// Mudanças v2 (robustez):
//  - Lock de concorrência: agente_executando_desde (auto-cleared on finish)
//  - 202 Accepted imediato + execução Playwright em background (fire-and-forget)
//  - Re-exportação permitida (sem bloqueio permanente)
//  - Tentativa 3 (sem filtro de bimestre) removida do educadf.pap.js
//  - Lock stale (>15min) é ignorado automaticamente
// ============================================================================

import express from 'express';
import { decrypt } from '../modules/agente/agente.crypt.js';
import { EducaDFBrowser } from '../modules/agente/educadf/educadf.browser.js';
import { exportarPAPEducaDF, exportarNotasEducaDF } from '../modules/agente/educadf/educadf.pap.js';

const router = express.Router();

const LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutos — lock stale é ignorado

// ── Helpers ──────────────────────────────────────────────────────────────────
function getUserId(req) {
  return Number(req?.user?.id ?? req?.user?.usuario_id ?? req?.user?.usuarioId ?? 0);
}

function getEscolaId(req) {
  return Number(req?.user?.escola_id ?? 0);
}

// ── Busca credenciais EDUCADF do usuário logado ───────────────────────────────
async function buscarCredenciais(db, escolaId, usuarioId) {
  let rows;
  try {
    [rows] = await db.query(
      `SELECT educadf_login, educadf_senha_enc, educadf_senha_iv, educadf_senha_tag, perfil_id
       FROM agente_credenciais
       WHERE escola_id = ? AND usuario_id = ? AND ativo = 1
       ORDER BY updated_at DESC LIMIT 1`,
      [escolaId, usuarioId]
    );
  } catch {
    // fallback schema antigo (professor_id)
    [rows] = await db.query(
      `SELECT educadf_login, educadf_senha_enc, educadf_senha_iv, educadf_senha_tag, perfil_id
       FROM agente_credenciais
       WHERE escola_id = ? AND professor_id = ? AND ativo = 1
       ORDER BY updated_at DESC LIMIT 1`,
      [escolaId, usuarioId]
    );
  }
  return rows?.[0] || null;
}

// ── Verifica e limpa lock stale ───────────────────────────────────────────────
function lockAtivo(plano) {
  if (!plano.agente_executando_desde) return false;
  const age = Date.now() - new Date(plano.agente_executando_desde).getTime();
  return age < LOCK_TTL_MS;
}

async function setLock(db, planoId) {
  await db.query(
    'UPDATE planos_avaliacao SET agente_executando_desde = NOW() WHERE id = ?',
    [planoId]
  ).catch(err => console.warn('[agente-planos] setLock:', err.message));
}

async function clearLock(db, planoId) {
  await db.query(
    'UPDATE planos_avaliacao SET agente_executando_desde = NULL WHERE id = ?',
    [planoId]
  ).catch(err => console.warn('[agente-planos] clearLock:', err.message));
}

// ── Busca nome do professor dono do plano ─────────────────────────────────────
async function buscarNomeProfessor(db, planoId, fallbackUsuarioId) {
  try {
    const [[prof]] = await db.query(
      `SELECT u.nome FROM usuarios u
       JOIN planos_avaliacao p ON p.usuario_id = u.id
       WHERE p.id = ? LIMIT 1`,
      [planoId]
    );
    if (prof?.nome) return prof.nome;
  } catch {}
  try {
    const [[u]] = await db.query('SELECT nome FROM usuarios WHERE id = ? LIMIT 1', [fallbackUsuarioId]);
    return u?.nome || '';
  } catch {}
  return '';
}

const PERFIL_MAP = { 1: 'professor', 2: 'secretario', 3: 'diretor' };

// ============================================================================
// POST /api/agente-planos/:id/exportar-estrutura
// ============================================================================
router.post('/:id/exportar-estrutura', async (req, res) => {
  const db        = req.db;            // pool ref — válido após res.json()
  const planoId   = Number(req.params.id);
  const escolaId  = getEscolaId(req);
  const usuarioId = getUserId(req);

  try {
    if (!planoId || !escolaId || !usuarioId)
      return res.status(400).json({ ok: false, error: 'Parâmetros inválidos.' });

    // ── 1. Busca plano ───────────────────────────────────────────────────────
    const [[plano]] = await db.query(
      'SELECT * FROM planos_avaliacao WHERE id = ? AND escola_id = ?',
      [planoId, escolaId]
    );
    if (!plano) return res.status(404).json({ ok: false, error: 'Plano não encontrado.' });

    if (plano.status !== 'APROVADO' && plano.status !== 'ENVIADO') {
      return res.status(400).json({
        ok: false,
        error: `Apenas planos APROVADOS ou ENVIADOS podem ser exportados. Status: ${plano.status}`,
      });
    }

    // ── 2. Lock de concorrência ──────────────────────────────────────────────
    if (lockAtivo(plano)) {
      return res.status(423).json({
        ok: false,
        codigo: 'EM_EXECUCAO',
        error: 'Este plano já está sendo exportado. Aguarde a conclusão.',
        executando_desde: plano.agente_executando_desde,
      });
    }

    // ── 3. Busca itens ────────────────────────────────────────────────────────────────────────
    const [itens] = await db.query(
      'SELECT * FROM itens_avaliacao WHERE plano_id = ? ORDER BY id ASC', [planoId]
    );
    if (!itens || itens.length === 0) {
      return res.status(422).json({
        ok: false,
        error: 'Este plano não possui itens de avaliação cadastrados.',
      });
    }

    // Fallback de data por bimestre: dia 15 do mês de referência
    // 1º Bim → 15/mar, 2º Bim → 15/mai, 3º Bim → 15/ago, 4º Bim → 15/nov
    const bimN = String(plano.bimestre || '').replace(/\D/g, '');
    const anoPlano = plano.ano || new Date().getFullYear();
    const BIM_MONTH_MAP = { '1': '03', '2': '05', '3': '08', '4': '11' };
    const mesFallback = BIM_MONTH_MAP[bimN] || '03';
    const dataFallback = `${anoPlano}-${mesFallback}-15`;

    // ── 3.5. Buscar Gabarito para Fallback Secundário ─────────────────────────────────────────
    // Caso algum item fixo_direcao (Prova Bimestral) não tenha data_inicio no banco,
    // tentamos encontrar a data_aplicacao no gabarito_avaliacoes correspondente à disciplina.
    let dataGabaritoSecundario = null;
    try {
      const [gabs] = await db.query(
        `SELECT data_aplicacao, disciplinas_config 
         FROM gabarito_avaliacoes 
         WHERE escola_id = ? 
           AND bimestre LIKE ? 
           AND data_aplicacao IS NOT NULL
         ORDER BY criado_em DESC`,
        [escolaId, `%${bimN}%`]
      );
      // Procurar o gabarito que contém a disciplina deste plano
      for (const gab of gabs) {
        if (gab.disciplinas_config) {
          const dConfig = typeof gab.disciplinas_config === 'string' ? JSON.parse(gab.disciplinas_config) : gab.disciplinas_config;
          if (Array.isArray(dConfig)) {
            const ids = dConfig.map(d => d.disciplina_id).filter(Boolean);
            if (ids.length > 0) {
               const [rows] = await db.query('SELECT nome FROM disciplinas WHERE id IN (?)', [ids]);
               const nomesDisc = rows.map(r => r.nome.toUpperCase());
               if (nomesDisc.includes(String(plano.disciplina || '').toUpperCase())) {
                 dataGabaritoSecundario = gab.data_aplicacao;
                 break;
               }
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[agente-planos] Falha ao buscar fallback secundário no gabarito: ${e.message}`);
    }

    // Monta array de itens com data resolvida (data_inicio do banco ou fallback por bimestre)
    // E deduplica por nome da atividade para garantir que sub-divisões do PAP não criem colunas duplicadas
    const itensComDataMap = new Map();
    itens.forEach(item => {
      const nomeAtividade = (item.atividade || '').trim();
      if (!itensComDataMap.has(nomeAtividade)) {
        let dataResolvida = item.data_inicio;
        
        if (!dataResolvida) {
          if (item.fixo_direcao && dataGabaritoSecundario) {
             dataResolvida = dataGabaritoSecundario;
             console.log(`[agente-planos] item "${nomeAtividade}": data_inicio null → fallback secundário gabarito: ${dataResolvida}`);
          } else {
             dataResolvida = dataFallback;
             console.log(`[agente-planos] item "${nomeAtividade}": data_inicio null → fallback genérico: ${dataResolvida}`);
          }
        }

        itensComDataMap.set(nomeAtividade, {
          atividade:      item.atividade,
          tipo_avaliacao: item.tipo_avaliacao,
          data_inicio:    dataResolvida,
          data:           dataResolvida,
          descricao:      item.descricao,
          nota_total:     item.nota_total,
          fixo_direcao:   !!item.fixo_direcao,
        });
      }
    });
    const itensComData = Array.from(itensComDataMap.values());

    // ── 4. Credenciais ───────────────────────────────────────────────────────
    const cred = await buscarCredenciais(db, escolaId, usuarioId);
    if (!cred) {
      return res.status(422).json({
        ok: false, error: 'Credenciais EDUCADF não configuradas.', codigo: 'SEM_CREDENCIAIS',
      });
    }
    let senhaPlain;
    try {
      senhaPlain = decrypt(cred.educadf_senha_enc, cred.educadf_senha_iv, cred.educadf_senha_tag);
    } catch {
      return res.status(422).json({
        ok: false, error: 'Credenciais desatualizadas. Salve novamente.', codigo: 'CREDENCIAIS_CORROMPIDAS',
      });
    }

    const perfil        = PERFIL_MAP[cred.perfil_id] || 'professor';
    const professorNome = await buscarNomeProfessor(db, planoId, usuarioId);

    const dadosPlano = {
      turmas:      plano.turmas,
      disciplina:  plano.disciplina,
      bimestre:    plano.bimestre,
      ano:         plano.ano,
      professorNome,
      itens:       itensComData,      // array completo — todos os itens do professor
    };

    // ── 5. SET lock + resposta imediata 202 ──────────────────────────────────
    await setLock(db, planoId);
    res.status(202).json({ ok: true, status: 'running', message: 'Exportação iniciada.' });

    // ── 6. Playwright em background ──────────────────────────────────────────
    (async () => {
      let resultado;
      try {
        console.log(`[agente-planos] ▶ Estrutura plano=${planoId} | ${plano.turmas} | ${plano.bimestre}`);
        resultado = await EducaDFBrowser.withSession(
          async (session) => exportarPAPEducaDF(
            session, { login: cred.educadf_login, senha: senhaPlain, perfil }, dadosPlano
          ),
          { escolaId, professorId: usuarioId, headless: true }
        );

        const sucesso = resultado.ok || resultado.errorCode === 'JA_EXISTE';
        const resultVal = resultado.errorCode === 'JA_EXISTE' ? 'JA_EXISTIA' : 'CRIADO';

        if (sucesso) {
          // UPDATE primário: sempre funciona (colunas garantidas)
          await db.query(
            `UPDATE planos_avaliacao
                SET agente_exportado_em    = NOW(),
                    agente_executando_desde = NULL,
                    agente_ultimo_erro      = NULL
              WHERE id = ?`,
            [planoId]
          ).catch(e => console.warn('[agente-planos] UPDATE estrutura (base):', e.message));

          // UPDATE secundário: tenta gravar resultado (coluna pode não existir ainda)
          db.query(
            `UPDATE planos_avaliacao SET agente_exportado_resultado = ? WHERE id = ?`,
            [resultVal, planoId]
          ).catch(() => {/* coluna agente_exportado_resultado ainda não existe — ignorar */});

          console.log(`[agente-planos] ✅ Estrutura plano=${planoId} (${resultVal})`);
        } else {
          const erroMsg = (resultado.message || 'Erro desconhecido no agente').substring(0, 500);
          // Grava mensagem de erro para exibição ao usuário
          await db.query(
            `UPDATE planos_avaliacao SET agente_executando_desde = NULL, agente_ultimo_erro = ? WHERE id = ?`,
            [erroMsg, planoId]
          ).catch(async () => {
            // Coluna pode não existir ainda — tenta só limpar lock
            await clearLock(db, planoId);
          });
          console.warn(`[agente-planos] ❌ Estrutura plano=${planoId}: ${erroMsg}`);
        }

        // Auditoria
        db.query(
          `INSERT INTO agente_audit_log (execucao_id, acao, detalhe, screenshot_path, duracao_ms)
           VALUES (0, 'EXPORTAR_PAP', ?, ?, ?)`,
          [JSON.stringify({ plano_id: planoId, ok: resultado.ok }), resultado.screenshotPath || null, resultado.durationMs || 0]
        ).catch(() => {});

      } catch (err) {
        console.error(`[agente-planos] ERRO Playwright estrutura plano=${planoId}:`, err.message);
        await clearLock(db, planoId);
      }
    })();

  } catch (err) {
    console.error(`[agente-planos] ERRO exportar-estrutura plano=${planoId}:`, err.message);
    return res.status(500).json({ ok: false, error: `Erro interno: ${err.message}` });
  }
});

// ============================================================================
// POST /api/agente-planos/:id/exportar-notas
// ============================================================================
router.post('/:id/exportar-notas', async (req, res) => {
  const db        = req.db;
  const planoId   = Number(req.params.id);
  const escolaId  = getEscolaId(req);
  const usuarioId = getUserId(req);

  try {
    if (!planoId || !escolaId || !usuarioId)
      return res.status(400).json({ ok: false, error: 'Parâmetros inválidos.' });

    // ── 1. Busca plano ───────────────────────────────────────────────────────
    const [[plano]] = await db.query(
      'SELECT * FROM planos_avaliacao WHERE id = ? AND escola_id = ?',
      [planoId, escolaId]
    );
    if (!plano) return res.status(404).json({ ok: false, error: 'Plano não encontrado.' });

    if (plano.status !== 'APROVADO' && plano.status !== 'ENVIADO') {
      return res.status(400).json({
        ok: false,
        error: `Apenas planos APROVADOS ou ENVIADOS podem ter notas exportadas. Status: ${plano.status}`,
      });
    }

    if (!plano.agente_exportado_em) {
      return res.status(422).json({
        ok: false,
        error: 'A estrutura ainda não foi exportada (Etapa 1). Execute a Etapa 1 primeiro.',
      });
    }

    // ── 2. Lock de concorrência ──────────────────────────────────────────────
    if (lockAtivo(plano)) {
      return res.status(423).json({
        ok: false,
        codigo: 'EM_EXECUCAO',
        error: 'As notas deste plano já estão sendo exportadas. Aguarde.',
        executando_desde: plano.agente_executando_desde,
      });
    }

    // ── 3. Busca itens do plano ──────────────────────────────────────────────
    const [itens] = await db.query(
      'SELECT * FROM itens_avaliacao WHERE plano_id = ? ORDER BY id ASC', [planoId]
    );
    if (!itens || !itens.length) {
      return res.status(422).json({
        ok: false, error: 'Plano não possui itens de avaliação.',
      });
    }

    // ── 4. Busca alunos com notas (agrega sub-colunas via SUM por atividade) ──
    let notasRaw = [];
    try {
      const [rows] = await db.query(`
        SELECT
          nd.item_idx,
          a.codigo        AS re,
          a.estudante     AS nome,
          SUM(nd.nota)    AS nota
        FROM notas_diario nd
        JOIN alunos a ON a.id = nd.aluno_id
        WHERE nd.plano_id = ?
          AND nd.nota IS NOT NULL
          AND (a.status = 'ativo' OR a.status IS NULL)
        GROUP BY nd.item_idx, a.id, a.codigo, a.estudante
      `, [planoId]);
      notasRaw = rows || [];
    } catch (e) {
      console.warn('[agente-planos] Erro ao buscar notas_diario:', e.message);
    }

    // Agrupa e soma as notas por "Atividade" (o nome da coluna consolidada no EDUCADF)
    const notasPorAtividade = {}; // { 'Caderno': { '1234': {re, nome, nota} } }
    
    for (const notaRaw of notasRaw) {
      const itemDef = itens[notaRaw.item_idx];
      if (!itemDef) continue;
      
      const atividadeNome = (itemDef.atividade || '').trim();
      if (!notasPorAtividade[atividadeNome]) {
         notasPorAtividade[atividadeNome] = {};
      }
      
      const alunoKey = String(notaRaw.re || notaRaw.nome);
      if (!notasPorAtividade[atividadeNome][alunoKey]) {
         notasPorAtividade[atividadeNome][alunoKey] = {
            re: String(notaRaw.re || ''),
            nome: String(notaRaw.nome || ''),
            nota: 0
         };
      }
      notasPorAtividade[atividadeNome][alunoKey].nota += Number(notaRaw.nota);
    }

    const colunas = Object.keys(notasPorAtividade).map(nomeColuna => {
       const alunosMap = notasPorAtividade[nomeColuna];
       const alunosArray = Object.values(alunosMap).map(a => ({
          re: a.re,
          nome: a.nome,
          nota: Number(a.nota.toFixed(1))
       })).sort((a, b) => a.nome.localeCompare(b.nome));
       return {
          nomeColuna,
          alunos: alunosArray
       };
    });

    if (colunas.length === 0 || colunas.every(c => c.alunos.length === 0)) {
      return res.status(422).json({
        ok: false,
        error: 'Nenhuma nota encontrada para este plano. Verifique se as notas foram lançadas.',
      });
    }

    // ── 5. Credenciais ───────────────────────────────────────────────────────
    const cred = await buscarCredenciais(db, escolaId, usuarioId);
    if (!cred) {
      return res.status(422).json({
        ok: false, error: 'Credenciais EDUCADF não configuradas.', codigo: 'SEM_CREDENCIAIS',
      });
    }
    let senhaPlain;
    try {
      senhaPlain = decrypt(cred.educadf_senha_enc, cred.educadf_senha_iv, cred.educadf_senha_tag);
    } catch {
      return res.status(422).json({
        ok: false, error: 'Credenciais desatualizadas. Salve novamente.', codigo: 'CREDENCIAIS_CORROMPIDAS',
      });
    }

    const perfil        = PERFIL_MAP[cred.perfil_id] || 'professor';
    const professorNome = await buscarNomeProfessor(db, planoId, usuarioId);

    const dadosPlano = {
      turmas:       plano.turmas,
      disciplina:   plano.disciplina,
      bimestre:     plano.bimestre,
      ano:          plano.ano,
      professorNome,
      colunas:      colunas,
    };

    // ── 6. SET lock + resposta imediata 202 ──────────────────────────────────
    await setLock(db, planoId);
    res.status(202).json({ ok: true, status: 'running', message: 'Exportação de notas iniciada.' });

    // ── 7. Playwright em background ──────────────────────────────────────────
    (async () => {
      let resultado;
      try {
        console.log(`[agente-planos] ▶ Notas plano=${planoId} | ${plano.turmas} | ${colunas.length} colunas mapeadas`);
        resultado = await EducaDFBrowser.withSession(
          async (session) => exportarNotasEducaDF(
            session, { login: cred.educadf_login, senha: senhaPlain, perfil }, dadosPlano
          ),
          { escolaId, professorId: usuarioId, headless: true }
        );

        if (resultado.ok) {
          // UPDATE primário: sempre funciona
          await db.query(
            `UPDATE planos_avaliacao
                SET agente_notas_exportadas_em = NOW(),
                    agente_executando_desde      = NULL,
                    agente_ultimo_erro           = NULL
              WHERE id = ?`,
            [planoId]
          ).catch(e => console.warn('[agente-planos] UPDATE notas (base):', e.message));

          // UPDATE secundário: tenta gravar JSON de resultado
          const statsJson = JSON.stringify({
            totalPreenchidos:     resultado.totalPreenchidos,
            totalErros:           resultado.totalErros,
            alunosNaoEncontrados: resultado.alunosNaoEncontrados || [],
            alunosDesabilitados:  resultado.alunosDesabilitados  || [],
          });
          db.query(
            `UPDATE planos_avaliacao SET agente_notas_resultado_json = ? WHERE id = ?`,
            [statsJson, planoId]
          ).catch(() => {/* coluna agente_notas_resultado_json pode não existir ainda */});

          console.log(`[agente-planos] ✅ Notas plano=${planoId} (${resultado.totalPreenchidos} alunos, ${resultado.totalErros} erros)`);
        } else {
          const erroMsg = (resultado.message || 'Erro desconhecido no agente').substring(0, 500);
          await db.query(
            `UPDATE planos_avaliacao SET agente_executando_desde = NULL, agente_ultimo_erro = ? WHERE id = ?`,
            [erroMsg, planoId]
          ).catch(async () => { await clearLock(db, planoId); });
          console.warn(`[agente-planos] ❌ Notas plano=${planoId}: ${erroMsg}`);
        }

      } catch (err) {
        console.error(`[agente-planos] ERRO Playwright notas plano=${planoId}:`, err.message);
        await clearLock(db, planoId);
      }
    })();

  } catch (err) {
    console.error(`[agente-planos] ERRO exportar-notas plano=${planoId}:`, err.message);
    return res.status(500).json({ ok: false, error: `Erro interno: ${err.message}` });
  }
});

export default router;
