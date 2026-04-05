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

/** Somente diretor/admin/secretario pode gerenciar credenciais */
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
// Cadastrar credencial de acesso ao EducaDF
// Suporta tanto credenciais de professor (professor_id > 0) quanto
// credenciais de escola/secretaria (professor_id = 0 ou ausente).
// ============================================================================
router.post('/credenciais', async (req, res) => {
  try {
    if (!assertDiretor(req, res)) return;

    const escolaId = getEscolaId(req);
    const { professor_id, educadf_login, educadf_senha } = req.body || {};

    // professor_id é OPCIONAL — 0 significa credencial da escola/secretaria
    if (!educadf_login || !educadf_senha) {
      return res.status(400).json({
        ok: false,
        message: 'Campos obrigatórios: educadf_login, educadf_senha.',
      });
    }

    const profId = Number(professor_id) || 0;

    // Criptografar a senha
    const { encrypted, iv, tag } = encrypt(educadf_senha);

    const db = req.db;

    // Upsert (inserir ou atualizar se já existir)
    const [result] = await db.query(
      `INSERT INTO agente_credenciais 
        (escola_id, professor_id, educadf_login, educadf_senha_enc, educadf_senha_iv, educadf_senha_tag)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        educadf_login = VALUES(educadf_login),
        educadf_senha_enc = VALUES(educadf_senha_enc),
        educadf_senha_iv = VALUES(educadf_senha_iv),
        educadf_senha_tag = VALUES(educadf_senha_tag),
        ativo = 1,
        updated_at = CURRENT_TIMESTAMP`,
      [escolaId, profId, String(educadf_login).trim(), encrypted, iv, tag]
    );

    console.log(`[agente.routes] Credencial salva: escola=${escolaId}, professor=${profId}`);

    return res.status(201).json({
      ok: true,
      id: result.insertId || null,
      message: 'Credencial cadastrada com sucesso.',
    });
  } catch (err) {
    console.error('[agente.routes] Erro POST /credenciais:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao cadastrar credencial.' });
  }
});

// ============================================================================
// GET /api/agente/credenciais
// Listar credenciais (SEM EXIBIR SENHA)
// ============================================================================
router.get('/credenciais', async (req, res) => {
  try {
    if (!assertDiretor(req, res)) return;

    const escolaId = getEscolaId(req);
    const db = req.db;

    const [rows] = await db.query(
      `SELECT 
        c.id,
        c.professor_id,
        c.educadf_login,
        c.perfil_id,
        c.ativo,
        c.ultimo_teste_em,
        c.created_at,
        c.updated_at,
        p.nome AS professor_nome
       FROM agente_credenciais c
       LEFT JOIN professores p ON p.id = c.professor_id AND p.escola_id = c.escola_id
       WHERE c.escola_id = ?
       ORDER BY p.nome ASC, c.created_at DESC`,
      [escolaId]
    );

    // NUNCA retornar a senha
    const credenciais = (rows || []).map((r) => ({
      id: r.id,
      professor_id: r.professor_id,
      professor_nome: r.professor_id === 0
        ? 'Escola / Secretaria'
        : (r.professor_nome || `Professor #${r.professor_id}`),
      educadf_login: r.educadf_login,
      educadf_senha: '********',  // NUNCA expor
      perfil_id: r.perfil_id,
      ativo: !!r.ativo,
      ultimo_teste_em: r.ultimo_teste_em,
      created_at: r.created_at,
      updated_at: r.updated_at,
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
// Testar login no EducaDF (abre browser, tenta logar, fecha)
// ============================================================================
router.post('/credenciais/:id/testar', async (req, res) => {
  try {
    if (!assertDiretor(req, res)) return;

    const escolaId = getEscolaId(req);
    const credId = Number(req.params.id);
    const db = req.db;

    // Buscar credencial
    const [rows] = await db.query(
      `SELECT id, educadf_login, educadf_senha_enc, educadf_senha_iv, educadf_senha_tag
       FROM agente_credenciais
       WHERE id = ? AND escola_id = ? AND ativo = 1
       LIMIT 1`,
      [credId, escolaId]
    );

    if (!rows?.length) {
      return res.status(404).json({ ok: false, message: 'Credencial não encontrada.' });
    }

    const cred = rows[0];

    // Descriptografar senha
    const senhaPlain = decrypt(cred.educadf_senha_enc, cred.educadf_senha_iv, cred.educadf_senha_tag);

    // Testar login
    console.log(`[agente.routes] Testando credencial #${credId} no EducaDF...`);

    const result = await EducaDFBrowser.withSession(
      async (session) => {
        return await testCredentials(session, {
          login: cred.educadf_login,
          senha: senhaPlain,
        });
      },
      { escolaId, professorId: cred.id, headless: true }
    );

    // Atualizar timestamp do último teste
    if (result.ok) {
      await db.query(
        'UPDATE agente_credenciais SET ultimo_teste_em = NOW() WHERE id = ?',
        [credId]
      );
    }

    // Logar resultado na tabela de auditoria
    await db.query(
      `INSERT INTO agente_audit_log (execucao_id, acao, detalhe, screenshot_path, duracao_ms)
       VALUES (0, 'TESTE_CREDENCIAL', ?, ?, ?)`,
      [
        JSON.stringify({ credencial_id: credId, ok: result.ok, errorCode: result.errorCode }),
        result.screenshotPath,
        result.durationMs,
      ]
    ).catch((e) => console.warn('[agente.routes] Erro ao salvar audit log:', e.message));

    return res.json({
      ok: result.ok,
      message: result.message,
      durationMs: result.durationMs,
      errorCode: result.errorCode,
    });
  } catch (err) {
    console.error('[agente.routes] Erro POST /credenciais/:id/testar:', err);
    return res.status(500).json({ ok: false, message: `Erro ao testar credencial: ${err.message}` });
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

    // Passa a URL da API para o agente importar no backend correto
    // (localhost em dev, produção em prod)
    const protocol = req.protocol;
    const host = req.get('host');
    const apiUrl = `${protocol}://${host}/api`;
    args.push('--api-url', apiUrl);

    if (req.body?.apenasDownload) {
      args.push('--apenas-scraping');
    }

    const cmd = args.join(' ');
    console.log(`[AGENTE-SYNC] Disparando: ${cmd.substring(0, 120)}...`);

    // Executa em background
    const child = exec(cmd, {
      cwd: agentDir,
      timeout: 600000,
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

        // Busca o relatório JSON mais recente
        if (fs.existsSync(downloadsDir)) {
          const files = fs.readdirSync(downloadsDir)
            .filter(f => f.startsWith('relatorio_') && f.endsWith('.json'))
            .sort()
            .reverse();

          if (files.length > 0) {
            const content = fs.readFileSync(path.join(downloadsDir, files[0]), 'utf-8');
            relatorio = JSON.parse(content);
          }
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
