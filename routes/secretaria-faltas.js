// routes/secretaria-faltas.js
// ============================================================================
// Submódulo FALTAS — Secretaria
// Gestão e consolidação de faltas por turno, turma e bimestre.
// ============================================================================

import express from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import pool from '../db.js';
import { resolverDisciplina, norm } from '../utils/disciplinasHelper.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

function anoLetivoPadrao() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1;
  return mes <= 1 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

// Normaliza identificação de turma (ex: "7º Ano - I" -> "7 ANO I")
function normTurma(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[-_./]/g, ' ')
    .replace(/\bANO\b/g, 'ANO')
    .replace(/[^A-Z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extrai linhas de arquivos (.csv, .xls, .xlsx) com detecção automática de encoding
function extrairLinhasPlanilha(buffer, originalname) {
  const nomeLower = String(originalname || '').toLowerCase();
  
  // Se for Excel binário (.xlsx ou .xls)
  if (nomeLower.endsWith('.xlsx') || nomeLower.endsWith('.xls')) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  }

  // Se for CSV ou texto: tenta decodificar como UTF-8 com fallback para Windows-1252 (Latin1)
  let wb;
  try {
    const utfText = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    wb = XLSX.read(utfText, { type: 'string' });
  } catch (_) {
    const winText = new TextDecoder('windows-1252').decode(buffer);
    wb = XLSX.read(winText, { type: 'string' });
  }

  if (wb && wb.SheetNames && wb.SheetNames.length > 0) {
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  }

  return [];
}

/**
 * GET /api/secretaria/faltas/turma/:turmaId
 * Retorna os estudantes da turma com o total de faltas por bimestre e detalhamento por disciplina.
 */
router.get('/turma/:turmaId', async (req, res) => {
  try {
    const { escola_id } = req.user;
    const turmaId = Number(req.params.turmaId);
    const anoEfetivo = req.query.ano || req.query.ano_letivo ? Number(req.query.ano || req.query.ano_letivo) : anoLetivoPadrao();

    if (!turmaId || Number.isNaN(turmaId)) {
      return res.status(400).json({ ok: false, message: 'ID da turma inválido.' });
    }

    // 1. Dados da turma
    const [[turma]] = await pool.query(
      `SELECT id, nome, serie, turno, etapa, ano, COALESCE(regime, 'anual') AS regime
       FROM turmas
       WHERE id = ? AND escola_id = ?
       LIMIT 1`,
      [turmaId, escola_id]
    );

    if (!turma) {
      return res.status(404).json({ ok: false, message: 'Turma não encontrada nesta escola.' });
    }

    // 2. Busca estudantes vinculados à turma (matriculas ativas ou alunos.turma_id)
    const sqlAlunos = `
      SELECT DISTINCT
        a.id AS aluno_id,
        a.codigo,
        a.estudante AS nome,
        a.foto,
        a.status
      FROM alunos a
      LEFT JOIN matriculas m 
        ON m.aluno_id = a.id 
       AND m.escola_id = a.escola_id 
       AND m.ano_letivo = ?
       AND m.status IN ('ativo', 'matriculado')
      WHERE (m.turma_id = ? OR (m.turma_id IS NULL AND a.turma_id = ?))
        AND a.escola_id = ?
        AND (a.status = 'ativo' OR a.status IS NULL)
      ORDER BY a.estudante ASC
    `;

    const [alunos] = await pool.query(sqlAlunos, [anoEfetivo, turmaId, turmaId, escola_id]);

    if (!alunos.length) {
      return res.json({
        ok: true,
        turma,
        ano_letivo: anoEfetivo,
        total_alunos: 0,
        estudantes: [],
      });
    }

    const alunoIds = alunos.map((al) => al.aluno_id);

    // 3. Busca faltas na tabela notas agrupadas por aluno, disciplina e bimestre
    const [notasRows] = await pool.query(
      `SELECT
         n.aluno_id,
         n.disciplina_id,
         d.nome AS disciplina_nome,
         n.bimestre,
         COALESCE(n.faltas, 0) AS faltas
       FROM notas n
       LEFT JOIN disciplinas d ON d.id = n.disciplina_id
       WHERE n.aluno_id IN (?)
         AND n.escola_id = ?
         AND n.ano = ?
         AND n.faltas IS NOT NULL
       ORDER BY d.nome ASC`,
      [alunoIds, escola_id, anoEfetivo]
    );

    // 4. Busca atestados / justificativas de faltas (frequencia_justificativas) com quebra bimestral
    const justificativasMap = {};
    for (const id of alunoIds) {
      justificativasMap[id] = {
        b1: 0,
        b2: 0,
        b3: 0,
        b4: 0,
        total: 0,
        dias: 0,
        qtd: 0,
        detalhes: [],
      };
    }

    try {
      const [justRows] = await pool.query(
        `SELECT
           id,
           aluno_id,
           tipo,
           data_inicio,
           data_fim,
           COALESCE(dias, 1) AS dias,
           observacao
         FROM frequencia_justificativas
         WHERE aluno_id IN (?)
           AND escola_id = ?
           AND (YEAR(data_inicio) = ? OR YEAR(data_fim) = ?)
         ORDER BY data_inicio ASC`,
        [alunoIds, escola_id, anoEfetivo, anoEfetivo]
      );

      for (const row of justRows) {
        const aId = row.aluno_id;
        if (!justificativasMap[aId]) continue;

        const totalDias = Math.max(1, Number(row.dias || 1));
        justificativasMap[aId].qtd += 1;
        justificativasMap[aId].detalhes.push({
          id: row.id,
          tipo: row.tipo,
          data_inicio: row.data_inicio,
          data_fim: row.data_fim,
          dias: totalDias,
          observacao: row.observacao,
        });

        // Formata data_inicio YYYY-MM-DD
        let dtInicioStr = null;
        if (row.data_inicio) {
          if (row.data_inicio instanceof Date) {
            const y = row.data_inicio.getUTCFullYear();
            const m = String(row.data_inicio.getUTCMonth() + 1).padStart(2, '0');
            const d = String(row.data_inicio.getUTCDate()).padStart(2, '0');
            dtInicioStr = `${y}-${m}-${d}`;
          } else {
            dtInicioStr = String(row.data_inicio).slice(0, 10);
          }
        }

        if (dtInicioStr && /^\d{4}-\d{2}-\d{2}$/.test(dtInicioStr)) {
          const [anoPart, mesPart, diaPart] = dtInicioStr.split('-').map(Number);

          // Distribui os dias no calendário bimestral escolar
          for (let step = 0; step < totalDias; step++) {
            const curDate = new Date(Date.UTC(anoPart, mesPart - 1, diaPart + step));
            const cAno = curDate.getUTCFullYear();
            const cMes = curDate.getUTCMonth() + 1; // 1-12

            if (cAno === anoEfetivo) {
              if (cMes <= 4) {
                justificativasMap[aId].b1 += 1;
              } else if (cMes <= 7) {
                justificativasMap[aId].b2 += 1;
              } else if (cMes <= 9) {
                justificativasMap[aId].b3 += 1;
              } else {
                justificativasMap[aId].b4 += 1;
              }
              justificativasMap[aId].total += 1;
            }
          }
        } else {
          justificativasMap[aId].b1 += totalDias;
          justificativasMap[aId].total += totalDias;
        }

        justificativasMap[aId].dias = justificativasMap[aId].total;
      }
    } catch (errJust) {
      console.warn('[secretaria-faltas] Aviso ao consultar justificativas:', errJust.message);
    }

    // 5. Agrega faltas por aluno
    // Estrutura por aluno:
    // { b1: 0, b2: 0, b3: 0, b4: 0, total: 0, disciplinas: { [discId]: { nome, b1, b2, b3, b4, total } } }
    const faltasPorAluno = {};
    for (const id of alunoIds) {
      faltasPorAluno[id] = {
        b1: 0,
        b2: 0,
        b3: 0,
        b4: 0,
        total: 0,
        disciplinas: {},
      };
    }

    for (const r of notasRows) {
      const aId = r.aluno_id;
      const bNum = Number(r.bimestre);
      const faltasNum = Number(r.faltas || 0);
      const dNome = r.disciplina_nome || 'Sem disciplina';
      const dId = r.disciplina_id || dNome;

      if (!faltasPorAluno[aId]) continue;

      // Soma por bimestre global
      if (bNum === 1) faltasPorAluno[aId].b1 += faltasNum;
      else if (bNum === 2) faltasPorAluno[aId].b2 += faltasNum;
      else if (bNum === 3) faltasPorAluno[aId].b3 += faltasNum;
      else if (bNum === 4) faltasPorAluno[aId].b4 += faltasNum;
      faltasPorAluno[aId].total += faltasNum;

      // Detalhamento por disciplina
      if (!faltasPorAluno[aId].disciplinas[dId]) {
        faltasPorAluno[aId].disciplinas[dId] = {
          id: dId,
          nome: dNome,
          b1: 0,
          b2: 0,
          b3: 0,
          b4: 0,
          total: 0,
        };
      }

      if (bNum === 1) faltasPorAluno[aId].disciplinas[dId].b1 += faltasNum;
      else if (bNum === 2) faltasPorAluno[aId].disciplinas[dId].b2 += faltasNum;
      else if (bNum === 3) faltasPorAluno[aId].disciplinas[dId].b3 += faltasNum;
      else if (bNum === 4) faltasPorAluno[aId].disciplinas[dId].b4 += faltasNum;
      faltasPorAluno[aId].disciplinas[dId].total += faltasNum;
    }

    // 6. Monta o resultado final formatado
    const estudantes = alunos.map((al) => {
      const f = faltasPorAluno[al.aluno_id] || { b1: 0, b2: 0, b3: 0, b4: 0, total: 0, disciplinas: {} };
      const just = justificativasMap[al.aluno_id] || { b1: 0, b2: 0, b3: 0, b4: 0, total: 0, dias: 0, qtd: 0, detalhes: [] };
      const listaDisciplinas = Object.values(f.disciplinas);

      return {
        aluno_id: al.aluno_id,
        codigo: al.codigo || '—',
        nome: al.nome,
        foto: al.foto || null,
        status: al.status || 'ativo',
        faltas: {
          b1: f.b1,
          b2: f.b2,
          b3: f.b3,
          b4: f.b4,
          total: f.total,
        },
        justificadas: just,
        disciplinas: listaDisciplinas,
      };
    });

    return res.json({
      ok: true,
      turma,
      ano_letivo: anoEfetivo,
      total_alunos: estudantes.length,
      estudantes,
    });
  } catch (err) {
    console.error('[secretaria-faltas] Erro ao buscar faltas da turma:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao carregar faltas da turma.' });
  }
});

/**
 * POST /api/secretaria/faltas/importar
 * Ingestão de planilhas de faltas oficiais baixadas do portal EDUCADF (.csv, .xls, .xlsx).
 * Permite pré-visualizar ou gravar diretamente na tabela `notas` (alimentando o Boletim Escolar).
 */
router.post('/importar', upload.array('files'), async (req, res) => {
  try {
    const { escola_id } = req.user;
    const ano = Number(req.body.ano) || anoLetivoPadrao();
    const bimestre = Number(req.body.bimestre) || 1;
    const isPreview = req.body.preview === 'true' || req.body.preview === true;
    const turmaIdFiltro = req.body.turma_id ? Number(req.body.turma_id) : null;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, message: 'Nenhum arquivo enviado para importação.' });
    }

    if (![1, 2, 3, 4].includes(bimestre)) {
      return res.status(400).json({ ok: false, message: 'Bimestre inválido (deve ser 1, 2, 3 ou 4).' });
    }

    // 1. Carrega dados da escola para resolução em memória (alta performance)
    const [turmasDb] = await pool.query(
      `SELECT id, nome, serie, turno, ano FROM turmas WHERE escola_id = ? AND ano = ?`,
      [escola_id, ano]
    );

    const [alunosDb] = await pool.query(
      `SELECT id, codigo, estudante, turma_id FROM alunos WHERE escola_id = ?`,
      [escola_id]
    );

    const [disciplinasDb] = await pool.query(
      `SELECT id, nome, nome_oficial, abreviatura FROM disciplinas WHERE escola_id = ?`,
      [escola_id]
    );

    const [modulacaoDb] = await pool.query(
      `SELECT m.turma_id, m.disciplina_id, m.professor_id, p.nome AS professor_nome, d.nome AS disciplina_nome
       FROM modulacao m
       JOIN disciplinas d ON d.id = m.disciplina_id
       LEFT JOIN professores p ON p.id = m.professor_id
       WHERE m.escola_id = ?`,
      [escola_id]
    );

    // Índices de busca rápida
    const turmasMap = new Map();
    for (const t of turmasDb) {
      turmasMap.set(normTurma(t.nome), t);
      const cleanNum = t.nome.replace(/\D/g, '');
      const cleanLetter = t.nome.replace(/[^A-Za-z]/g, '').toUpperCase();
      if (cleanNum && cleanLetter) {
        turmasMap.set(`${cleanNum} ${cleanLetter}`, t);
      }
    }

    const alunoByCodigo = new Map();
    const alunoByNome = new Map();
    for (const a of alunosDb) {
      if (a.codigo) {
        const cleanCod = String(a.codigo).trim();
        alunoByCodigo.set(cleanCod, a);
        alunoByCodigo.set(cleanCod.replace(/^0+/, ''), a);
      }
      if (a.estudante) {
        alunoByNome.set(norm(a.estudante), a);
      }
    }

    const disciplinasTurmaMap = new Map();
    for (const m of modulacaoDb) {
      if (!disciplinasTurmaMap.has(m.turma_id)) {
        disciplinasTurmaMap.set(m.turma_id, []);
      }
      disciplinasTurmaMap.get(m.turma_id).push({
        id: m.disciplina_id,
        nome: m.disciplina_nome,
        professor_nome: m.professor_nome,
      });
    }

    // Estruturas de agregação e estatísticas
    const lancamentosValidos = [];
    const naoMapeados = [];
    const turmasDetectadas = new Set();
    const alunosDetectados = new Set();
    const disciplinasDetectadas = new Set();
    const logs = [];

    logs.push(`📂 Processando ${req.files.length} arquivo(s) para o ${bimestre}º Bimestre de ${ano}...`);

    for (const file of req.files) {
      const rows = extrairLinhasPlanilha(file.buffer, file.originalname);
      if (!rows || rows.length < 3) {
        logs.push(`⚠️ Arquivo "${file.originalname}" vazio ou sem dados suficientes.`);
        continue;
      }

      // Identifica a linha de cabeçalho
      let headerIdx = -1;
      let colTurma = -1, colProf = -1, colComp = -1, colRe = -1, colAluno = -1, colFaltas = -1, colJustif = -1;

      for (let r = 0; r < Math.min(10, rows.length); r++) {
        const row = rows[r].map(c => String(c || '').toUpperCase().trim());
        const hasAluno = row.some(c => c.includes('ESTUDANTE') || c.includes('ALUNO') || c === 'NOME');
        const hasFaltas = row.some(c => c.includes('FALTA'));
        if (hasAluno && hasFaltas) {
          headerIdx = r;
          row.forEach((cell, idx) => {
            if (cell.includes('TURMA') || cell.includes('AGRUPAMENTO')) colTurma = idx;
            else if (cell.includes('PROFESSOR') || cell.includes('DOCENTE')) colProf = idx;
            else if (cell.includes('COMPONENTE') || cell.includes('DISCIPLINA')) colComp = idx;
            else if (cell === 'RE' || cell.includes('RE DO') || cell.includes('MATRICULA') || cell.includes('MATRÍCULA') || cell.includes('CODIGO')) colRe = idx;
            else if (cell.includes('ESTUDANTE') || cell.includes('ALUNO') || cell === 'NOME') colAluno = idx;
            else if (cell.includes('TOTAL DE FALTA') || cell === 'FALTAS') colFaltas = idx;
            else if (cell.includes('FALTA JUSTIFICADA') || cell.includes('JUSTIFICADA')) colJustif = idx;
          });
          break;
        }
      }

      if (headerIdx === -1) {
        logs.push(`⚠️ Não foi possível identificar o cabeçalho no arquivo "${file.originalname}".`);
        continue;
      }

      // Fallbacks para índices padrão do EDUCADF se alguma coluna não tiver sido mapeada por nome
      if (colTurma === -1) colTurma = 4;
      if (colProf === -1) colProf = 5;
      if (colComp === -1) colComp = 6;
      if (colRe === -1) colRe = 7;
      if (colAluno === -1) colAluno = 8;
      if (colFaltas === -1) colFaltas = 10;
      if (colJustif === -1) colJustif = 11;

      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 5) continue;

        const turmaRaw = String(row[colTurma] || '').trim();
        const profRaw = String(row[colProf] || '').trim();
        const compRaw = String(row[colComp] || '').trim();
        const reRaw = String(row[colRe] || '').trim();
        const alunoRaw = String(row[colAluno] || '').trim();
        const faltasStr = String(row[colFaltas] || '0').replace(/\D/g, '') || '0';
        const faltasNum = Math.max(0, parseInt(faltasStr, 10));

        if (!alunoRaw && !reRaw) continue;

        // 1. Identifica Aluno
        let alunoObj = null;
        if (reRaw) {
          const cleanRe = reRaw.replace(/^0+/, '');
          alunoObj = alunoByCodigo.get(reRaw) || alunoByCodigo.get(cleanRe);
        }
        if (!alunoObj && alunoRaw) {
          alunoObj = alunoByNome.get(norm(alunoRaw));
        }

        if (!alunoObj) {
          naoMapeados.push({
            tipo: 'aluno',
            motivo: `Aluno não localizado: "${alunoRaw}" (RE: ${reRaw})`,
            linha: i + 1,
            arquivo: file.originalname,
          });
          continue;
        }

        // 2. Identifica Turma
        let turmaObj = null;
        if (turmaIdFiltro) {
          turmaObj = turmasDb.find(t => t.id === turmaIdFiltro);
        }
        if (!turmaObj && turmaRaw) {
          turmaObj = turmasMap.get(normTurma(turmaRaw));
        }
        if (!turmaObj && alunoObj.turma_id) {
          turmaObj = turmasDb.find(t => t.id === alunoObj.turma_id);
        }

        const turmaEfetivaId = turmaObj ? turmaObj.id : (alunoObj.turma_id || null);

        // 3. Identifica Disciplina
        const disciplinasTurma = turmaEfetivaId ? disciplinasTurmaMap.get(turmaEfetivaId) : null;
        let discObj = null;

        // 1ª Prioridade: resolver nome do componente pelo catálogo ou modulação
        if (disciplinasTurma && disciplinasTurma.length > 0) {
          discObj = resolverDisciplina(compRaw, disciplinasTurma);
        }
        if (!discObj) {
          discObj = resolverDisciplina(compRaw, disciplinasDb);
        }

        // 2ª Prioridade: resolução por professor modulado na turma se o componente for genérico
        if (!discObj && profRaw && disciplinasTurma && disciplinasTurma.length > 0) {
          const profParts = profRaw.split(/[;,/]/).map(p => norm(p.trim())).filter(Boolean);
          const modProf = disciplinasTurma.find(d => {
            if (!d.professor_nome) return false;
            const dNorm = norm(d.professor_nome);
            return profParts.some(p => dNorm.includes(p) || p.includes(dNorm));
          });
          if (modProf) {
            discObj = { id: modProf.id, nome: modProf.nome };
          }
        }

        if (!discObj) {
          naoMapeados.push({
            tipo: 'disciplina',
            motivo: `Disciplina não reconhecida: "${compRaw}" (Prof: ${profRaw})`,
            linha: i + 1,
            aluno: alunoObj.estudante,
          });
          continue;
        }

        lancamentosValidos.push({
          aluno_id: alunoObj.id,
          aluno_nome: alunoObj.estudante,
          aluno_re: alunoObj.codigo || reRaw,
          turma_id: turmaEfetivaId,
          turma_nome: turmaObj?.nome || 'Turma não identificada',
          disciplina_id: discObj.id,
          disciplina_nome: discObj.nome,
          prof: profRaw,
          faltas: faltasNum,
        });

        turmasDetectadas.add(turmaObj?.nome || 'Turma ' + turmaEfetivaId);
        alunosDetectados.add(alunoObj.id);
        disciplinasDetectadas.add(discObj.nome);
      }
    }

    logs.push(`✅ Identificados ${lancamentosValidos.length} lançamento(s) para ${alunosDetectados.size} aluno(s) em ${turmasDetectadas.size} turma(s).`);

    // Modo Pré-visualização: não grava no banco
    if (isPreview) {
      return res.json({
        ok: true,
        preview: true,
        ano,
        bimestre,
        stats: {
          totalArquivos: req.files.length,
          totalValidos: lancamentosValidos.length,
          totalAlunos: alunosDetectados.size,
          totalTurmas: turmasDetectadas.size,
          turmas: Array.from(turmasDetectadas),
          disciplinas: Array.from(disciplinasDetectadas),
          naoMapeadosQtd: naoMapeados.length,
        },
        amostra: lancamentosValidos.slice(0, 10),
        naoMapeados: naoMapeados.slice(0, 10),
        logs,
      });
    }

    // Modo Gravação Real no Boletim (tabela `notas`)
    const conn = await pool.getConnection();
    let totalGravados = 0;
    try {
      await conn.beginTransaction();

      for (const item of lancamentosValidos) {
        await conn.query(
          `INSERT INTO notas
            (escola_id, aluno_id, ano, bimestre, disciplina_id, faltas, data_lancamento)
           VALUES (?, ?, ?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE
             faltas = VALUES(faltas),
             data_lancamento = NOW()`,
          [escola_id, item.aluno_id, ano, bimestre, item.disciplina_id, item.faltas]
        );
        totalGravados++;
      }

      await conn.commit();
      logs.push(`🎉 Sucesso: ${totalGravados} registro(s) de faltas salvos no Boletim Escolar.`);

      return res.json({
        ok: true,
        preview: false,
        ano,
        bimestre,
        message: `${totalGravados} faltas lançadas com sucesso no Boletim (${bimestre}º Bimestre).`,
        stats: {
          totalGravados,
          totalAlunos: alunosDetectados.size,
          totalTurmas: turmasDetectadas.size,
          turmas: Array.from(turmasDetectadas),
          disciplinas: Array.from(disciplinasDetectadas),
          naoMapeadosQtd: naoMapeados.length,
        },
        logs,
      });
    } catch (errDb) {
      await conn.rollback();
      console.error('[secretaria-faltas] Erro ao gravar faltas no boletim:', errDb);
      return res.status(500).json({ ok: false, message: 'Erro ao gravar faltas no banco de dados: ' + errDb.message });
    } finally {
      conn.release();
    }
  } catch (errGlobal) {
    console.error('[secretaria-faltas] Erro na importação de faltas:', errGlobal);
    return res.status(500).json({ ok: false, message: 'Erro interno ao importar faltas: ' + errGlobal.message });
  }
});

export default router;

