// modules/agente/agente.routes.js
// ============================================================================
// ROTAS REST — MÓDULO AGENTE AUTÔNOMO (EducaDF Bridge)
// ============================================================================
// Endpoints:
//   POST   /api/agente/credenciais              → Cadastrar credencial
//   GET    /api/agente/credenciais              → Listar credenciais (sem senha)
//   DELETE /api/agente/credenciais/:id          → Remover credencial
//   POST   /api/agente/credenciais/:id/testar   → Testar login no EducaDF
//   GET    /api/agente/execucoes                → Listar execuções
//   GET    /api/agente/status                   → Status geral do módulo
//   POST   /api/agente/executar                 → Disparar execução manual
// ============================================================================

import { Router } from 'express';
import { encrypt, decrypt, validateMasterKey, selfTest } from './agente.crypt.js';
import { EducaDFBrowser } from './educadf/educadf.browser.js';
import { testCredentials } from './educadf/educadf.login.js';

const router = Router();

// ============================================================================
// HELPERS
// ============================================================================

function getEscolaId(req) {
  return Number(req.escola_id ?? req?.user?.escola_id ?? 0);
}

function getUserId(req) {
  return Number(req?.user?.usuarioId ?? req?.user?.id ?? 0);
}

/** 
 * Converte Date/string do MySQL para ISO UTC string (com 'Z').
 * mysql2 retorna Date objects nativos — estes já sabem sua timezone
 * e .toISOString() converte corretamente para UTC.
 */
function toUTC(val) {
  if (!val) return val;
  // mysql2 retorna Date objects — garantidamente correto
  if (val instanceof Date) return val.toISOString();
  // String: parse para Date e depois serialize (lida com qualquer timezone)
  const s = String(val);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return s;
}

function getPerfil(req) {
  return String(req?.user?.perfil ?? '').toLowerCase();
}

/** Verifica permissão: qualquer usuário logado pode gerenciar suas PRÓPRIAS credenciais.
 *  Somente gestores/admin podem ver credenciais de OUTROS usuários. */
function assertDiretor(req, res) {
  const perfil = getPerfil(req);
  if (!['diretor', 'admin', 'administrador', 'plataforma', 'secretario'].includes(perfil)) {
    res.status(403).json({
      ok: false,
      message: 'Acesso negado. Somente diretor/admin/secretário pode gerenciar credenciais do agente.',
    });
    return false;
  }
  return true;
}

/** Qualquer usuário logado pode acessar (sem restrição de perfil) */
function assertLogado(req, res) {
  const uid = getUserId(req);
  if (!uid) {
    res.status(401).json({ ok: false, message: 'Usuário não autenticado.' });
    return false;
  }
  return true;
}

// ============================================================================
// GET /api/agente/status
// Status geral do módulo
// ============================================================================
router.get('/status', async (req, res) => {
  try {
    const escolaId = getEscolaId(req);
    const db = req.db;

    // Validar chave master
    const keyStatus = validateMasterKey();
    const testStatus = keyStatus.ok ? selfTest() : { ok: false, message: 'Chave não configurada' };

    // Contagens
    const [[{ total: totalCredenciais }]] = await db.query(
      'SELECT COUNT(*) AS total FROM agente_credenciais WHERE escola_id = ? AND ativo = 1',
      [escolaId]
    );

    const [[{ total: totalExecucoes }]] = await db.query(
      'SELECT COUNT(*) AS total FROM agente_execucoes WHERE escola_id = ? AND DATE(created_at) = CURDATE()',
      [escolaId]
    );

    const [[{ total: totalSucesso }]] = await db.query(
      `SELECT COUNT(*) AS total FROM agente_execucoes 
       WHERE escola_id = ? AND status = 'SUCESSO' AND DATE(created_at) = CURDATE()`,
      [escolaId]
    );

    const [[{ total: totalFalha }]] = await db.query(
      `SELECT COUNT(*) AS total FROM agente_execucoes 
       WHERE escola_id = ? AND status = 'FALHA' AND DATE(created_at) = CURDATE()`,
      [escolaId]
    );

    return res.json({
      ok: true,
      modulo: 'AGENTE_EDUCADF',
      versao: '1.0.0',
      chave_master: keyStatus,
      self_test: testStatus,
      hoje: {
        credenciais_ativas: totalCredenciais,
        execucoes_total: totalExecucoes,
        execucoes_sucesso: totalSucesso,
        execucoes_falha: totalFalha,
        taxa_sucesso: totalExecucoes > 0
          ? `${Math.round((totalSucesso / totalExecucoes) * 100)}%`
          : 'N/A',
      },
    });
  } catch (err) {
    console.error('[agente.routes] Erro GET /status:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao obter status do agente.' });
  }
});

// ============================================================================
// POST /api/agente/credenciais
// Cadastrar/atualizar credencial PESSOAL do usuário logado.
// Qualquer perfil pode cadastrar a própria credencial (professor, diretor, etc.)
// A chave de upsert é (escola_id, usuario_id) — cada usuário tem 1 credencial.
// ============================================================================
router.post('/credenciais', async (req, res) => {
  try {
    if (!assertLogado(req, res)) return;

    const escolaId = getEscolaId(req);
    const usuarioId = getUserId(req);
    const { educadf_login, educadf_senha, perfil_educadf } = req.body || {};

    if (!educadf_login || !educadf_senha) {
      return res.status(400).json({
        ok: false,
        message: 'Preencha o usuário e a senha do portal EDUCADF.',
      });
    }

    const perfilStr = String(perfil_educadf || '').toLowerCase() || 'professor';
    const perfilId = perfilStr === 'professor' ? 1
      : perfilStr === 'secretario' ? 2
      : perfilStr === 'diretor'    ? 3
      : 1; // fallback professor

    // Também detecta professor_id para manter compatibilidade com sincronização
    const professorId = Number(req.body?.professor_id) || 0;

    const { encrypted, iv, tag } = encrypt(educadf_senha);
    const db = req.db;

    // Upsert por (escola_id, usuario_id) — cada usuário tem 1 credencial
    const [result] = await db.query(
      `INSERT INTO agente_credenciais
        (escola_id, usuario_id, professor_id, educadf_login, educadf_senha_enc, educadf_senha_iv, educadf_senha_tag, perfil_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        professor_id        = VALUES(professor_id),
        educadf_login       = VALUES(educadf_login),
        educadf_senha_enc   = VALUES(educadf_senha_enc),
        educadf_senha_iv    = VALUES(educadf_senha_iv),
        educadf_senha_tag   = VALUES(educadf_senha_tag),
        perfil_id           = VALUES(perfil_id),
        ativo               = 1,
        updated_at          = CURRENT_TIMESTAMP`,
      [escolaId, usuarioId, professorId, String(educadf_login).trim(), encrypted, iv, tag, perfilId]
    );

    const savedId = result.insertId || null;
    // Se insertId=0 (update), busca o id real
    let credId = savedId;
    if (!credId) {
      const [[row]] = await db.query(
        'SELECT id FROM agente_credenciais WHERE escola_id = ? AND usuario_id = ? LIMIT 1',
        [escolaId, usuarioId]
      );
      credId = row?.id || null;
    }

    console.log(`[agente.routes] Credencial salva: escola=${escolaId}, usuario=${usuarioId}, perfil=${perfilStr}`);

    return res.status(201).json({
      ok: true,
      id: credId,
      message: 'Credencial cadastrada com sucesso.',
    });
  } catch (err) {
    console.error('[agente.routes] Erro POST /credenciais:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao cadastrar credencial.' });
  }
});

// ============================================================================
// GET /api/agente/credenciais
// Retorna a credencial DO USUÁRIO LOGADO (sem expor senha).
// Qualquer perfil pode buscar a própria. Gestores recebem todas da escola.
// ============================================================================
router.get('/credenciais', async (req, res) => {
  try {
    if (!assertLogado(req, res)) return;

    const escolaId = getEscolaId(req);
    const usuarioId = getUserId(req);
    const perfil = getPerfil(req);
    const db = req.db;

    // Gestores veem todas as credenciais da escola; demais veem só a própria
    const isGestor = ['diretor', 'admin', 'administrador', 'plataforma', 'secretario'].includes(perfil);
    const where = isGestor
      ? 'c.escola_id = ?'
      : 'c.escola_id = ? AND c.usuario_id = ?';
    const params = isGestor ? [escolaId] : [escolaId, usuarioId];

    const [rows] = await db.query(
      `SELECT
        c.id,
        c.usuario_id,
        c.professor_id,
        c.educadf_login,
        c.perfil_id,
        c.ativo,
        c.ultimo_teste_em,
        c.created_at,
        c.updated_at,
        u.nome AS usuario_nome
       FROM agente_credenciais c
       LEFT JOIN usuarios u ON u.id = c.usuario_id
       WHERE ${where} AND c.ativo = 1
       ORDER BY u.nome ASC, c.created_at DESC`,
      params
    );

    const credenciais = (rows || []).map((r) => ({
      id: r.id,
      usuario_id: r.usuario_id,
      professor_id: r.professor_id,
      usuario_nome: r.usuario_nome || `Usuário #${r.usuario_id}`,
      educadf_login: r.educadf_login,
      educadf_senha: '********',  // NUNCA expor
      perfil_id: r.perfil_id,
      ativo: !!r.ativo,
      ultimo_teste_em: toUTC(r.ultimo_teste_em),
      created_at: toUTC(r.created_at),
      updated_at: toUTC(r.updated_at),
    }));

    return res.json({ ok: true, credenciais });
  } catch (err) {
    console.error('[agente.routes] Erro GET /credenciais:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao listar credenciais.' });
  }
});

// ============================================================================
// DELETE /api/agente/credenciais/:id
// Remover credencial (soft delete: ativo = 0)
// ============================================================================
router.delete('/credenciais/:id', async (req, res) => {
  try {
    if (!assertDiretor(req, res)) return;

    const escolaId = getEscolaId(req);
    const credId = Number(req.params.id);
    const db = req.db;

    const [result] = await db.query(
      `UPDATE agente_credenciais SET ativo = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND escola_id = ? LIMIT 1`,
      [credId, escolaId]
    );

    if (!result?.affectedRows) {
      return res.status(404).json({ ok: false, message: 'Credencial não encontrada.' });
    }

    return res.json({ ok: true, message: 'Credencial removida com sucesso.' });
  } catch (err) {
    console.error('[agente.routes] Erro DELETE /credenciais/:id:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao remover credencial.' });
  }
});

// ============================================================================
// POST /api/agente/credenciais/:id/testar
// Inicia o teste de login de forma ASSÍNCRONA (fire-and-forget).
// Retorna imediatamente com status 'executando'. Use GET /testar/status para polling.
// ============================================================================

// Cache em memória: `${escolaId}:${credId}` → { status, result, startedAt }
const _testesEmAndamento = new Map();
router.post('/credenciais/:id/testar', async (req, res) => {
  try {
    if (!assertLogado(req, res)) return;

    const escolaId = getEscolaId(req);
    const credId = Number(req.params.id);
    const db = req.db;
    const perfilReq = getPerfil(req);

    const usuarioId = getUserId(req);
    const perfil = getPerfil(req);
    const isGestor = ['diretor', 'admin', 'administrador', 'plataforma', 'secretario'].includes(perfil);

    // Gestor pode testar qualquer credencial da escola; usuário comum só a própria
    const testarWhere = isGestor
      ? 'id = ? AND escola_id = ? AND ativo = 1'
      : 'id = ? AND escola_id = ? AND usuario_id = ? AND ativo = 1';
    const testarParams = isGestor ? [credId, escolaId] : [credId, escolaId, usuarioId];

    const [rows] = await db.query(
      `SELECT id, educadf_login, educadf_senha_enc, educadf_senha_iv, educadf_senha_tag, perfil_id
       FROM agente_credenciais
       WHERE ${testarWhere}
       LIMIT 1`,
      testarParams
    );

    if (!rows?.length) {
      return res.status(404).json({ ok: false, message: 'Credencial não encontrada.' });
    }

    const cred = rows[0];
    const testeKey = `${escolaId}:${credId}`;

    // Perfil: usa o salvo no banco (definido pelo usuário) como prioridade
    // Fallback: detecta pelo perfil JWT do usuário logado
    const PERFIL_ID_MAP = { 1: 'professor', 2: 'secretario', 3: 'diretor' };
    const perfilFinal = PERFIL_ID_MAP[cred.perfil_id] || perfilReq || 'professor';

    console.log(`[agente.routes] perfil_id no banco: ${cred.perfil_id} → perfil EDUCADF: ${perfilFinal}`);

    // Se já há um teste em andamento, retorna o status atual sem iniciar novo
    const emAndamento = _testesEmAndamento.get(testeKey);
    if (emAndamento && (emAndamento.status === 'executando')) {
      return res.json({ ok: true, async: true, teste_id: testeKey, status: 'executando' });
    }

    const senhaPlain = decrypt(cred.educadf_senha_enc, cred.educadf_senha_iv, cred.educadf_senha_tag);

    const entry = { status: 'executando', result: null, startedAt: Date.now() };
    _testesEmAndamento.set(testeKey, entry);

    console.log(`[agente.routes] Teste assíncrono iniciado: credencial #${credId} (perfil EDUCADF: ${perfilFinal})`);

    // Dispara o Playwright em background SEM bloquear a resposta HTTP
    (async () => {
      try {
        const result = await EducaDFBrowser.withSession(
          async (session) => testCredentials(session, {
            login: cred.educadf_login,
            senha: senhaPlain,
            perfil: perfilFinal,
          }),
          { escolaId, professorId: cred.id, headless: true }
        );

        entry.status = result.ok ? 'sucesso' : 'falha';
        entry.result = result;

        if (result.ok) {
          await db.query(
            'UPDATE agente_credenciais SET ultimo_teste_em = NOW() WHERE id = ?',
            [credId]
          ).catch(() => {});
        }

        await db.query(
          `INSERT INTO agente_audit_log (execucao_id, acao, detalhe, screenshot_path, duracao_ms)
           VALUES (0, 'TESTE_CREDENCIAL', ?, ?, ?)`,
          [
            JSON.stringify({ credencial_id: credId, ok: result.ok, errorCode: result.errorCode }),
            result.screenshotPath,
            result.durationMs,
          ]
        ).catch(() => {});

        console.log(`[agente.routes] Teste #${credId} finalizado: ${entry.status} (${result.durationMs}ms)`);
      } catch (err) {
        entry.status = 'falha';
        entry.result = { ok: false, message: `Erro interno: ${err.message}`, errorCode: 'UNEXPECTED_ERROR' };
        console.error(`[agente.routes] Erro no teste assíncrono #${credId}:`, err.message);
      }
      // Limpa cache após 5 min
      setTimeout(() => _testesEmAndamento.delete(testeKey), 5 * 60_000);
    })();

    // Responde IMEDIATAMENTE ao frontend
    return res.json({ ok: true, async: true, teste_id: testeKey, status: 'executando' });
  } catch (err) {
    console.error('[agente.routes] Erro POST /credenciais/:id/testar:', err);
    return res.status(500).json({ ok: false, message: `Erro ao iniciar teste: ${err.message}` });
  }
});

// ============================================================================
// GET /api/agente/credenciais/:id/testar/status
// Polling: retorna o status atual do teste assíncrono.
// ============================================================================
router.get('/credenciais/:id/testar/status', async (req, res) => {
  try {
    if (!assertLogado(req, res)) return;

    const escolaId = getEscolaId(req);
    const credId = Number(req.params.id);
    const testeKey = `${escolaId}:${credId}`;
    const entry = _testesEmAndamento.get(testeKey);

    if (!entry) {
      // Nenhum teste ativo — verifica banco
      const db = req.db;
      const [[cred]] = await db.query(
        'SELECT ultimo_teste_em FROM agente_credenciais WHERE id = ? AND escola_id = ? LIMIT 1',
        [credId, escolaId]
      );
      return res.json({ ok: null, status: 'sem_teste', ultimo_teste_em: cred?.ultimo_teste_em || null });
    }

    return res.json({
      ok: entry.result?.ok ?? null,
      status: entry.status,
      message: entry.result?.message || null,
      errorCode: entry.result?.errorCode || null,
      durationMs: entry.result?.durationMs || null,
      elapsedSec: Math.round((Date.now() - entry.startedAt) / 1000),
    });
  } catch (err) {
    console.error('[agente.routes] Erro GET /credenciais/:id/testar/status:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao consultar status.' });
  }
});

// ============================================================================
// GET /api/agente/execucoes
// Listar histórico de execuções
// ============================================================================
router.get('/execucoes', async (req, res) => {
  try {
    const escolaId = getEscolaId(req);
    const db = req.db;

    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const status = req.query.status || null;
    const tipo = req.query.tipo || null;

    let where = 'WHERE e.escola_id = ?';
    const params = [escolaId];

    if (status) {
      where += ' AND e.status = ?';
      params.push(status);
    }
    if (tipo) {
      where += ' AND e.tipo = ?';
      params.push(tipo);
    }

    const [rows] = await db.query(
      `SELECT 
        e.id, e.professor_id, e.tipo, e.status,
        e.turma_nome, e.disciplina_nome, e.data_referencia,
        e.bimestre, e.ano_letivo,
        e.tentativa, e.max_tentativas, e.duracao_ms,
        e.erro, e.screenshot_antes, e.screenshot_depois,
        e.agendado_para, e.iniciado_em, e.finalizado_em,
        e.created_at,
        p.nome AS professor_nome
       FROM agente_execucoes e
       LEFT JOIN professores p ON p.id = e.professor_id AND p.escola_id = e.escola_id
       ${where}
       ORDER BY e.created_at DESC
       LIMIT ?`,
      [...params, limite]
    );

    return res.json({ ok: true, execucoes: rows || [] });
  } catch (err) {
    console.error('[agente.routes] Erro GET /execucoes:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao listar execuções.' });
  }
});


// ============================================================================
// POST /api/agente/sincronizar
// Disparar sincronização SEEDF → EDUCA.MELHOR (scraping + importação)
// ============================================================================
router.post('/sincronizar', async (req, res) => {
  try {
    if (!assertDiretor(req, res)) return;

    const escolaId = getEscolaId(req);
    const usuarioId = getUserId(req);
    const db = req.db;

    // Verifica se já existe uma sincronização em andamento
    const [[emAndamento]] = await db.query(
      `SELECT id FROM sincronizacao_logs 
       WHERE escola_id = ? AND status = 'em_andamento' 
       ORDER BY criado_em DESC LIMIT 1`,
      [escolaId]
    );

    if (emAndamento) {
      return res.status(409).json({
        ok: false,
        message: 'Já existe uma sincronização em andamento.',
        log_id: emAndamento.id,
      });
    }

    // Cria registro no log
    const [insertResult] = await db.query(
      `INSERT INTO sincronizacao_logs (escola_id, usuario_id, status, turmas_solicitadas)
       VALUES (?, ?, 'em_andamento', ?)`,
      [escolaId, usuarioId, JSON.stringify(req.body?.turmas || null)]
    );
    const logId = insertResult.insertId;

    // ── Busca turmas cadastradas na escola para filtrar o scraping ──
    // Filtra pelo ano letivo atual (mesmo critério do resto do sistema)
    const mesAtual = new Date().getMonth() + 1;
    const anoLetivo = mesAtual <= 1 ? new Date().getFullYear() - 1 : new Date().getFullYear();

    const [turmasRows] = await db.query(
      'SELECT nome FROM turmas WHERE escola_id = ? AND ano = ? ORDER BY nome',
      [escolaId, String(anoLetivo)]
    );
    const turmasEscola = (turmasRows || []).map(r => r.nome).filter(Boolean);
    console.log(`[AGENTE-SYNC] ${turmasEscola.length} turmas do ano letivo ${anoLetivo} na escola ${escolaId}`);

    // Monta comando do agente Python
    const { exec } = await import('child_process');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __fn = fileURLToPath(import.meta.url);
    const __dn = path.dirname(__fn);

    // Detecta caminho do agente: Docker (/app/educa-agent) ou dev local (monorepo)
    const fs = await import('fs');
    const agentDirDocker = path.resolve(__dn, '../../educa-agent');
    const agentDirLocal  = path.resolve(__dn, '../../../educa-agent');
    const agentDir = fs.existsSync(path.join(agentDirDocker, 'agent.py'))
      ? agentDirDocker
      : agentDirLocal;
    const agentScript = path.join(agentDir, 'agent.py');
    console.log(`[AGENTE-SYNC] Agent dir: ${agentDir}`);

    // python3 no Linux/Docker, python no Windows
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const args = [pythonCmd, `"${agentScript}"`];

    // Se turmas específicas foram solicitadas, usa essas; senão usa as da escola
    if (req.body?.turmas && Array.isArray(req.body.turmas)) {
      for (const t of req.body.turmas) {
        args.push('--turma', `"${t}"`);
      }
    } else if (turmasEscola.length > 0) {
      // Salva turmas num arquivo temp (evita problemas de escape no Windows)
      const turmasFile = path.join(agentDir, `turmas_sync_${logId}.json`);
      fs.writeFileSync(turmasFile, JSON.stringify(turmasEscola, null, 2), 'utf-8');
      args.push('--turmas-file', `"${turmasFile}"`);
      console.log(`[AGENTE-SYNC] Turmas salvas em: ${turmasFile}`);
    }

    // ── Credenciais EducaDF (fonte unificada: Agente EDUCA) ──
    // Busca credenciais ativas do banco (mesmas do módulo Agente EDUCA)
    // e passa para o Python via arquivo temp (evita .env)
    const PERFIL_MAP = { 1: 'professor', 2: 'secretario', 3: 'diretor' };
    try {
      const [credRows] = await db.query(
        `SELECT educadf_login, educadf_senha_enc, educadf_senha_iv, educadf_senha_tag, perfil_id
         FROM agente_credenciais
         WHERE escola_id = ? AND ativo = 1
         ORDER BY updated_at DESC LIMIT 1`,
        [escolaId]
      );
      if (credRows.length > 0) {
        const cred = credRows[0];
        const senhaDecrypted = decrypt(cred.educadf_senha_enc, cred.educadf_senha_iv, cred.educadf_senha_tag);
        const perfilName = PERFIL_MAP[cred.perfil_id] || 'professor';
        const credFile = path.join(agentDir, `cred_sync_${logId}.json`);
        fs.writeFileSync(credFile, JSON.stringify({
          login: cred.educadf_login,
          senha: senhaDecrypted,
          perfil: perfilName,
        }), 'utf-8');
        args.push('--cred-file', `"${credFile}"`);
        console.log(`[AGENTE-SYNC] Credenciais EducaDF: login=${cred.educadf_login}, perfil=${perfilName}`);
      } else {
        console.warn('[AGENTE-SYNC] AVISO: Nenhuma credencial ativa encontrada! O agente usará fallback do .env');
      }
    } catch (credErr) {
      console.error('[AGENTE-SYNC] Erro ao ler credenciais do banco:', credErr.message);
    }

    // Token e escola para importação
    // IMPORTANTE: Salvar token em arquivo temp para evitar problemas de escape
    // no Windows (tokens JWT longos eram truncados/corrompidos pelo shell,
    // fazendo o agente rodar em modo apenas-scraping silenciosamente)
    const token = req.headers.authorization?.replace('Bearer ', '') || '';
    if (token) {
      const tokenFile = path.join(agentDir, `token_sync_${logId}.txt`);
      fs.writeFileSync(tokenFile, token, 'utf-8');
      args.push('--token-file', `"${tokenFile}"`);
      console.log(`[AGENTE-SYNC] Token salvo em arquivo temp (${token.length} chars)`);
    } else {
      console.warn('[AGENTE-SYNC] AVISO: Token JWT não encontrado no header Authorization!');
    }
    args.push('--escola', String(escolaId));

    // URL da API para o agente importar
    // Em Docker: o agente roda no MESMO container → usa localhost:3000 (direto)
    // Em dev local: usa a URL derivada do request (localhost:3001, etc.)
    const isDocker = agentDir === agentDirDocker;
    let apiUrl;
    if (isDocker) {
      apiUrl = 'http://localhost:3000/api';
      console.log('[AGENTE-SYNC] Docker detectado → API interna: http://localhost:3000/api');
    } else {
      const protocol = req.protocol;
      const host = req.get('host');
      apiUrl = `${protocol}://${host}/api`;
    }
    args.push('--api-url', apiUrl);

    if (req.body?.apenasDownload) {
      args.push('--apenas-scraping');
    }

    const cmd = args.join(' ');
    console.log(`[AGENTE-SYNC] Disparando: ${cmd.substring(0, 120)}...`);

    // Marca o início para filtrar relatórios (evitar pegar de sync anterior)
    const syncStartTime = Date.now();

    // Executa em background
    // 30 min (1800s) — 40 turmas × ~20s/turma + overhead de login/filtros
    const SYNC_TIMEOUT_MS = 1_800_000;
    const child = exec(cmd, {
      cwd: agentDir,
      timeout: SYNC_TIMEOUT_MS,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });

    let stdout = '';
    let stderr = '';

    // Parseia stdout em tempo real para atualizar progresso
    // O agente imprime: "--- Turma 5/40: 7º Ano - A ---"
    const progressRegex = /---\s*Turma\s+(\d+)\/(\d+):\s*(.+?)\s*---/;

    child.stdout?.on('data', (data) => {
      stdout += data;
      // Tenta extrair progresso da última linha
      const lines = String(data).split('\n');
      for (const line of lines) {
        const m = line.match(progressRegex);
        if (m) {
          const [, atual, total, turma] = m;
          db.query(
            `UPDATE sincronizacao_logs SET progresso_atual = ?, progresso_total = ?, progresso_turma = ? WHERE id = ?`,
            [Number(atual), Number(total), turma.trim(), logId]
          ).catch(() => {});
        }
      }
    });
    child.stderr?.on('data', (data) => { stderr += data; });

    child.on('close', async (code) => {
      console.log(`[AGENTE-SYNC] Processo encerrado (code=${code})`);
      try {
        const downloadsDir = path.join(agentDir, 'downloads');
        let relatorio = null;

        // Busca o relatório JSON criado APÓS o início desta sync
        // (evita pegar relatório de uma sync anterior)
        if (fs.existsSync(downloadsDir)) {
          const files = fs.readdirSync(downloadsDir)
            .filter(f => f.startsWith('relatorio_') && f.endsWith('.json'))
            .filter(f => {
              try {
                const stat = fs.statSync(path.join(downloadsDir, f));
                return stat.mtimeMs >= syncStartTime - 5000; // margem de 5s
              } catch { return false; }
            })
            .sort()
            .reverse();

          if (files.length > 0) {
            const content = fs.readFileSync(path.join(downloadsDir, files[0]), 'utf-8');
            relatorio = JSON.parse(content);
            console.log(`[AGENTE-SYNC] Relatório JSON encontrado: ${files[0]}`);
          }
        }

        // ── FALLBACK: se não encontrou relatório JSON, gera a partir do stdout ──
        // Isso acontece quando o agente é encerrado (code=null/timeout) antes de
        // salvar o JSON, mas o stdout capturou toda a saída com os resultados.
        if (!relatorio && stdout.length > 100) {
          console.log(`[AGENTE-SYNC] Sem relatório JSON — gerando a partir do stdout (${stdout.length} chars)`);

          // ── Parseia o stdout do PYTHON (não do Node.js!) ──
          // Python importador.py imprime: "[IMPORT] OK: loc=36 ins=0 reat=0 exist=36 pend=0"
          const importOkRegex = /\[IMPORT\]\s*OK:\s*loc=(\d+)\s*ins=(\d+)\s*reat=(\d+)\s*exist=(\d+)(?:\s*pend=(\d+))?/g;
          const turmaLines = stdout.match(/---\s*Turma\s+\d+\/\d+:\s*.+?\s*---/g) || [];
          const pdfOkLines = stdout.match(/\[IMPORT\]\s*OK:/g) || [];

          let totalLoc = 0, totalIns = 0, totalReat = 0, totalInativ = 0, totalJaExistiam = 0, totalPendentes = 0;
          const detalhes = [];
          let m;
          while ((m = importOkRegex.exec(stdout)) !== null) {
            const loc = Number(m[1]), ins = Number(m[2]), reat = Number(m[3]), exist = Number(m[4]), pend = Number(m[5] || 0);
            totalLoc += loc;
            totalIns += ins;
            totalReat += reat;
            totalJaExistiam += exist;
            totalPendentes += pend;
            detalhes.push({ localizados: loc, inseridos: ins, reativados: reat, jaExistiam: exist, pendentesInativacao: pend, status: 'sucesso' });
          }

          const pdfsOk = pdfOkLines.length || detalhes.length;

          // Conta turmas que o scraper iniciou no stdout ("--- Turma N/M: ... ---")
          // Mas o TOTAL REAL de turmas é o M do "Turma N/M" (não o número de linhas)
          let turmasTotal = turmaLines.length || pdfsOk;
          if (turmaLines.length > 0) {
            // Extrai o "M" de "Turma 11/40"
            const totalMatch = turmaLines[turmaLines.length - 1].match(/\d+\/(\d+)/);
            if (totalMatch) turmasTotal = Number(totalMatch[1]);
          } else if (turmasEscola.length > 0) {
            turmasTotal = turmasEscola.length;
          }

          // Distingue entre falha real de download e turma não processada (timeout)
          // pdfFalhaLine: linhas com "[PDF] FALHA:" no stdout
          const pdfFalhaLines = stdout.match(/\[PDF\]\s*FALHA:/g) || [];
          const turmaNotFoundLines = stdout.match(/\[SKIP\].*não encontrada/g) || [];
          const pdsFalhaReal = pdfFalhaLines.length + turmaNotFoundLines.length;
          const pdfsProcessados = pdfsOk + pdsFalhaReal;
          const pdfsNaoProcessados = Math.max(0, turmasTotal - pdfsProcessados);

          // Status: se houve timeout (code=null) → parcial com motivo
          const duracaoS = Math.round((Date.now() - syncStartTime) / 1000);
          const isTimeout = code === null || duracaoS >= (SYNC_TIMEOUT_MS / 1000 - 10);
          let syncStatus, motivoParcial;
          if (code === 0 && pdfsOk >= turmasTotal) {
            syncStatus = 'sucesso';
          } else if (pdfsOk > 0) {
            syncStatus = 'parcial';
            if (isTimeout) {
              motivoParcial = `Tempo máximo excedido (${duracaoS}s). Processadas ${pdfsOk} de ${turmasTotal} turmas. Aumente o timeout ou execute em horário de menor carga.`;
            } else if (pdsFalhaReal > 0) {
              motivoParcial = `${pdsFalhaReal} turma(s) falharam no download. ${pdfsNaoProcessados > 0 ? `${pdfsNaoProcessados} não processada(s).` : ''}`;
            }
          } else {
            syncStatus = 'falha';
          }

          relatorio = {
            status: syncStatus,
            motivo_parcial: motivoParcial || null,
            data_execucao: new Date(syncStartTime).toISOString(),
            _gerado_de: 'stdout_fallback',
            etapa_importacao: {
              total_turmas: turmasTotal,
              sucesso: pdfsOk,
              erro: pdsFalhaReal,
              nao_processadas: pdfsNaoProcessados,
              total_localizados: totalLoc,
              total_inseridos: totalIns,
              total_reativados: totalReat,
              total_inativados: totalInativ,
              total_jaExistiam: totalJaExistiam,
              detalhes,
            },
            resumo: {
              pdfs_baixados: pdfsOk,
              pdfs_falha: pdsFalhaReal,
              pdfs_nao_processados: pdfsNaoProcessados,
              alunos_localizados: totalLoc,
              alunos_inseridos: totalIns,
              alunos_jaExistiam: totalJaExistiam,
              alunos_reativados: totalReat,
              alunos_inativados: totalInativ,
              turmas_ok: pdfsOk,
              turmas_total: turmasTotal,
              turmas_vazias: pdfsOk > 0 ? 0 : undefined,
              total_alunos_verificados: totalLoc,
              duracao_s: duracaoS,
              motivo_parcial: motivoParcial || null,
            },
          };
          console.log(`[AGENTE-SYNC] Resumo do stdout: ${pdfsOk}/${turmasTotal} PDFs (${pdsFalhaReal} falhas, ${pdfsNaoProcessados} não processadas), ${totalLoc} loc, ${totalJaExistiam} exist, ${totalIns} ins`);
        }

        await db.query(
          `UPDATE sincronizacao_logs 
           SET status = ?, relatorio = ?, finalizado_em = NOW()
           WHERE id = ?`,
          [
            relatorio?.status || (code === 0 ? 'sucesso' : 'falha'),
            JSON.stringify(relatorio || { stdout: stdout.substring(0, 8000), stderr: stderr.substring(0, 2000) }),
            logId,
          ]
        );
      } catch (err) {
        console.error('[AGENTE-SYNC] Erro ao salvar resultado:', err.message);
        await db.query(
          `UPDATE sincronizacao_logs SET status = 'erro', relatorio = ?, finalizado_em = NOW() WHERE id = ?`,
          [JSON.stringify({ error: err.message }), logId]
        ).catch(() => {});
      }
    });

    // Responde imediatamente
    return res.json({
      ok: true,
      message: 'Sincronização SEEDF iniciada em segundo plano.',
      log_id: logId,
    });
  } catch (err) {
    console.error('[AGENTE-SYNC] Erro:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});


// ============================================================================
// GET /api/agente/sincronizacao/status
// Status da sincronização mais recente (ou por log_id)
// ============================================================================
router.get('/sincronizacao/status', async (req, res) => {
  try {
    const escolaId = getEscolaId(req);
    const db = req.db;

    let query, params;
    if (req.query.log_id) {
      query = 'SELECT * FROM sincronizacao_logs WHERE id = ? AND escola_id = ?';
      params = [req.query.log_id, escolaId];
    } else {
      query = 'SELECT * FROM sincronizacao_logs WHERE escola_id = ? ORDER BY criado_em DESC LIMIT 1';
      params = [escolaId];
    }

    const [[log]] = await db.query(query, params);

    if (!log) {
      return res.json({ ok: true, data: null, message: 'Nenhuma sincronização encontrada.' });
    }

    let relatorio = null;
    if (log.relatorio) {
      try { relatorio = typeof log.relatorio === 'string' ? JSON.parse(log.relatorio) : log.relatorio; } catch {}
    }

    return res.json({
      ok: true,
      data: {
        id: log.id,
        status: log.status,
        turmas_solicitadas: log.turmas_solicitadas,
        relatorio,
        progresso_atual: log.progresso_atual || 0,
        progresso_total: log.progresso_total || 0,
        progresso_turma: log.progresso_turma || null,
        criado_em: toUTC(log.criado_em),
        finalizado_em: toUTC(log.finalizado_em),
      },
    });
  } catch (err) {
    console.error('[AGENTE-SYNC] Erro status:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});


// ============================================================================
// GET /api/agente/sincronizacao/historico
// Histórico de sincronizações
// ============================================================================
router.get('/sincronizacao/historico', async (req, res) => {
  try {
    const escolaId = getEscolaId(req);
    const db = req.db;
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const offset = Number(req.query.offset) || 0;

    const [rows] = await db.query(
      `SELECT id, status, turmas_solicitadas, criado_em, finalizado_em,
              JSON_EXTRACT(relatorio, '$.resumo') AS resumo
       FROM sincronizacao_logs 
       WHERE escola_id = ? 
       ORDER BY criado_em DESC 
       LIMIT ? OFFSET ?`,
      [escolaId, limit, offset]
    );

    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) as total FROM sincronizacao_logs WHERE escola_id = ?',
      [escolaId]
    );

    const data = (rows || []).map((r) => ({
      ...r,
      criado_em: toUTC(r.criado_em),
      finalizado_em: toUTC(r.finalizado_em),
      resumo: typeof r.resumo === 'string' ? JSON.parse(r.resumo) : r.resumo,
      turmas_solicitadas: typeof r.turmas_solicitadas === 'string'
        ? JSON.parse(r.turmas_solicitadas)
        : r.turmas_solicitadas,
    }));

    return res.json({ ok: true, data, total, limit, offset });
  } catch (err) {
    console.error('[AGENTE-SYNC] Erro historico:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});


export default router;
