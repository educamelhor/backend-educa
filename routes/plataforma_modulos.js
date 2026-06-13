// routes/plataforma_modulos.js
// Sistema de Licenciamento de Módulos por Escola — EDUCA.MELHOR
import express from 'express';

const router = express.Router();

// ── Auto-migrate: garante que a tabela escola_modulos existe ──────────────────
// Executado uma única vez quando o módulo é importado pelo server.js.
// Seguro: usa IF NOT EXISTS, não altera dados existentes.
// ─────────────────────────────────────────────────────────────────────────────
let _tableMigrated = false;
router.use(async (req, _res, next) => {
  if (_tableMigrated) return next();
  try {
    await req.db.query(`
      CREATE TABLE IF NOT EXISTS escola_modulos (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        escola_id  INT NOT NULL,
        modulo     VARCHAR(100) NOT NULL,
        ativo      TINYINT(1) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_escola_modulo (escola_id, modulo),
        INDEX      idx_em_escola (escola_id)
      )
    `);
    _tableMigrated = true;
    console.log('[plataforma_modulos] Tabela escola_modulos verificada/criada ✅');
  } catch (e) {
    _tableMigrated = true;
    if (!String(e.message || '').includes('already exists')) {
      console.warn('[plataforma_modulos] Auto-migrate aviso:', e.message);
    }
  }
  next();
});

const MODULOS_VALIDOS = new Set([
  // Secretaria
  'secretaria', 'secretaria.alunos', 'secretaria.responsaveis',
  'secretaria.cargas_horarias', 'secretaria.disciplinas', 'secretaria.turmas',
  'secretaria.professores', 'secretaria.boletim', 'secretaria.relatorios',
  'secretaria.horarios', 'secretaria.agente', 'secretaria.tabela_codigos',
  'secretaria.sincronizar_seedf', 'secretaria.modulacao',
  // Disciplinar
  'disciplinar', 'disciplinar.alunos', 'disciplinar.historico',
  'disciplinar.atas', 'disciplinar.fo_coletivo', 'disciplinar.responsaveis',
  'disciplinar.liberacao', 'disciplinar.metadados', 'disciplinar.equipe',
  'disciplinar.regimentos', 'disciplinar.manual', 'disciplinar.suporte',
  // Pedagógico
  'pedagogico', 'pedagogico.conselho', 'pedagogico.conteudos',
  'pedagogico.relatorios', 'pedagogico.correcoes',
  // Gabarito
  'gabarito', 'gabarito.gerar', 'gabarito.corrigir_lote',
  'gabarito.corrigir', 'gabarito.resultados',
  // Frequência
  'frequencia', 'frequencia.atestados', 'frequencia.relatorios',
  'frequencia.busca_ativa', 'frequencia.conselho_tutelar',
  // Biblioteca
  'biblioteca', 'biblioteca.acervo', 'biblioteca.emprestimos',
  'biblioteca.alunos', 'biblioteca.leitor_destaque',
  'biblioteca.concurso', 'biblioteca.metadados',
  // Professores
  'professores', 'professores.planos', 'professores.avaliacoes',
  'professores.conteudos', 'professores.provas', 'professores.boletim',
  'professores.conselho',
  // Monitoramento
  'monitoramento', 'monitoramento.painel', 'monitoramento.alertas',
  'monitoramento.embeddings',
  // Questões
  'questoes',
  // Agente EDUCA
  'agente_educa', 'agente_educa.credenciais', 'agente_educa.planos', 'agente_educa.notas',
  // Impressão
  'impressao', 'impressao.gabaritos', 'impressao.boletins',
  'impressao.listas', 'impressao.documentos',
  // Ferramentas
  'ferramentas',
  // Direção
  'direcao', 'direcao.educa_capture', 'direcao.responsaveis',
  'direcao.cadastro', 'direcao.governanca',
]);

/**
 * GET /api/plataforma/modulos/:escolaId
 * Retorna todos os módulos de uma escola com status ativo.
 * Se não houver registros, retorna todos com ativo=false.
 */
router.get('/:escolaId', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);

  if (!escolaId || isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: 'escolaId inválido.' });
  }

  try {
    const [rows] = await db.query(
      'SELECT modulo, ativo FROM escola_modulos WHERE escola_id = ?',
      [escolaId]
    );

    let modulos;
    if (!rows || rows.length === 0) {
      // Sem registros: retorna todos com ativo=false
      modulos = Array.from(MODULOS_VALIDOS).map(modulo => ({ modulo, ativo: false }));
    } else {
      // Monta mapa dos existentes
      const mapa = new Map(rows.map(r => [r.modulo, Number(r.ativo) === 1]));
      // Retorna todos os módulos válidos, com status do banco ou false
      modulos = Array.from(MODULOS_VALIDOS).map(modulo => ({
        modulo,
        ativo: mapa.has(modulo) ? mapa.get(modulo) : false,
      }));
    }

    return res.json({ ok: true, escola_id: escolaId, modulos });
  } catch (err) {
    console.error('[plataforma_modulos] GET erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao buscar módulos da escola.' });
  }
});

/**
 * PUT /api/plataforma/modulos/:escolaId
 * body: { modulos: [{ modulo: 'gabarito.gerar', ativo: true }, ...] }
 * Faz upsert de cada módulo. Valida contra MODULOS_VALIDOS.
 */
router.put('/:escolaId', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);

  if (!escolaId || isNaN(escolaId)) {
    return res.status(400).json({ ok: false, message: 'escolaId inválido.' });
  }

  const { modulos } = req.body;
  if (!Array.isArray(modulos) || modulos.length === 0) {
    return res.status(400).json({ ok: false, message: 'Campo modulos deve ser um array não vazio.' });
  }

  // Valida módulos
  const invalidos = modulos.filter(m => !MODULOS_VALIDOS.has(m?.modulo));
  if (invalidos.length > 0) {
    return res.status(400).json({
      ok: false,
      message: `Módulos inválidos: ${invalidos.map(m => m?.modulo).join(', ')}`,
    });
  }

  try {
    let total_ativados = 0;
    let total_desativados = 0;

    for (const { modulo, ativo } of modulos) {
      const ativoVal = ativo ? 1 : 0;
      await req.db.query(
        `INSERT INTO escola_modulos (escola_id, modulo, ativo)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE ativo = ?`,
        [escolaId, modulo, ativoVal, ativoVal]
      );
      if (ativoVal) total_ativados++;
      else total_desativados++;
    }

    return res.json({ ok: true, total_ativados, total_desativados });
  } catch (err) {
    console.error('[plataforma_modulos] PUT erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao salvar módulos da escola.' });
  }
});

/**
 * POST /api/plataforma/modulos/:escolaId/copiar-de/:origemId
 * Copia todas as configurações de módulos da escola origemId para escolaId.
 */
router.post('/:escolaId/copiar-de/:origemId', async (req, res) => {
  const db = req.db;
  const escolaId = Number(req.params.escolaId);
  const origemId = Number(req.params.origemId);

  if (!escolaId || isNaN(escolaId) || !origemId || isNaN(origemId)) {
    return res.status(400).json({ ok: false, message: 'escolaId ou origemId inválido.' });
  }

  if (escolaId === origemId) {
    return res.status(400).json({ ok: false, message: 'escola destino e origem não podem ser iguais.' });
  }

  try {
    // Busca módulos da origem
    const [origemRows] = await db.query(
      'SELECT modulo, ativo FROM escola_modulos WHERE escola_id = ?',
      [origemId]
    );

    // Remove registros existentes do destino
    await db.query('DELETE FROM escola_modulos WHERE escola_id = ?', [escolaId]);

    // Copia registros da origem para o destino
    let total_copiados = 0;
    for (const { modulo, ativo } of origemRows) {
      await db.query(
        'INSERT INTO escola_modulos (escola_id, modulo, ativo) VALUES (?, ?, ?)',
        [escolaId, modulo, ativo]
      );
      total_copiados++;
    }

    return res.json({ ok: true, total_copiados });
  } catch (err) {
    console.error('[plataforma_modulos] POST copiar-de erro:', err.message);
    return res.status(500).json({ ok: false, message: 'Erro ao copiar módulos.' });
  }
});

export default router;
