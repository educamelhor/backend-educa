// ============================================================================
// GABARITO — Correção + Resultados
// Salva na tabela nova `gabarito_respostas` (vinculada a `gabarito_avaliacoes`)
// ============================================================================

import express from "express";
import pool from "../db.js";

const router = express.Router();

// Middleware para verificar escola
function verificarEscola(req, res, next) {
  if (!req.user || !req.user.escola_id) {
    return res.status(403).json({ error: "Acesso negado: escola não definida." });
  }
  next();
}

// ─── POST /api/gabaritos/corrigir ────────────────────────────────────────────
// Salva o resultado da correção de um aluno na tabela gabarito_respostas
// Aceita tanto o formato novo (avaliacao_id) quanto o antigo (gabaritoOficial)
router.post("/corrigir", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;

  const {
    avaliacao_id,
    codigo_aluno,
    nome_aluno,
    turma_id,
    turma_nome,
    respostas_aluno,
    acertos,
    total_questoes,
    nota,
    acertos_por_disciplina,
    detalhes,
    avisos,
    // Campos legados (compat)
    respostasAluno,
    gabaritoOficial,
    codigoAluno,
    nome,
    turma,
    nomeGabarito,
  } = req.body;

  // ─── FORMATO NOVO (gabarito_respostas) ───
  if (avaliacao_id) {
    const codAluno = codigo_aluno || codigoAluno;
    const respostas = respostas_aluno || respostasAluno;

    if (!codAluno || !Array.isArray(respostas)) {
      return res.status(400).json({ error: "codigo_aluno e respostas_aluno são obrigatórios." });
    }

    try {
      // UPSERT: atualiza se já existe resultado para este aluno nesta avaliação
      await pool.query(
        `INSERT INTO gabarito_respostas 
          (avaliacao_id, escola_id, codigo_aluno, nome_aluno, turma_id, turma_nome,
           respostas_aluno, acertos, total_questoes, nota, acertos_por_disciplina, detalhes, avisos, origem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'omr')
         ON DUPLICATE KEY UPDATE
           nome_aluno = VALUES(nome_aluno),
           turma_id = VALUES(turma_id),
           turma_nome = VALUES(turma_nome),
           respostas_aluno = VALUES(respostas_aluno),
           acertos = VALUES(acertos),
           total_questoes = VALUES(total_questoes),
           nota = VALUES(nota),
           acertos_por_disciplina = VALUES(acertos_por_disciplina),
           detalhes = VALUES(detalhes),
           avisos = VALUES(avisos),
           corrigido_em = CURRENT_TIMESTAMP`,
        [
          avaliacao_id,
          escola_id,
          codAluno,
          nome_aluno || nome || null,
          turma_id || null,
          turma_nome || turma || null,
          JSON.stringify(respostas),
          acertos || 0,
          total_questoes || respostas.length,
          nota || 0,
          acertos_por_disciplina ? JSON.stringify(acertos_por_disciplina) : null,
          detalhes ? JSON.stringify(detalhes) : null,
          avisos ? JSON.stringify(avisos) : null,
        ]
      );

      // Atualizar status da avaliação para "em_correcao" se ainda estiver como "publicada"
      await pool.query(
        `UPDATE gabarito_avaliacoes SET status = 'em_correcao' 
         WHERE id = ? AND escola_id = ? AND status = 'publicada'`,
        [avaliacao_id, escola_id]
      );

      return res.json({ success: true, saved: true, message: "Resultado salvo com sucesso." });
    } catch (err) {
      console.error("Erro ao salvar resultado (gabarito_respostas):", err);
      return res.status(500).json({ error: "Erro ao salvar resultado." });
    }
  }

  // ─── FORMATO LEGADO (gabaritos_corrigidos) ───
  if (Array.isArray(respostasAluno) && Array.isArray(gabaritoOficial)) {
    let notaCalc = 0;
    const correcao = respostasAluno.map((resposta, i) => {
      const correto = gabaritoOficial[i] || "-";
      const acertou = resposta === correto;
      if (acertou) notaCalc++;
      return { numero: i + 1, resposta, correto, acertou };
    });

    try {
      await pool.query(
        `INSERT INTO gabaritos_corrigidos 
          (codigo_aluno, nome_aluno, turma, respostas_aluno, gabarito_oficial, nome_gabarito, acertos, detalhes_correcao, escola_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          codigoAluno, nome, turma,
          respostasAluno.join(","), gabaritoOficial.join(","),
          nomeGabarito, notaCalc, JSON.stringify(correcao), escola_id,
        ]
      );
      return res.json({ nota: notaCalc, correcao, saved: true });
    } catch (err) {
      console.error("Erro ao salvar (legado):", err);
      return res.status(500).json({ error: "Erro ao salvar no banco." });
    }
  }

  return res.status(400).json({ error: "Formato de dados inválido." });
});

// ─── GET /api/gabaritos/resultados?avaliacao_id=X ────────────────────────────
// Retorna todos os resultados de uma avaliação específica
router.get("/resultados", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  const { avaliacao_id } = req.query;

  if (!avaliacao_id) {
    return res.status(400).json({ error: "avaliacao_id é obrigatório." });
  }

  try {
    const [rows] = await pool.query(
      `SELECT r.*, a.titulo as avaliacao_titulo, a.num_questoes, a.nota_total,
              a.gabarito_oficial, a.disciplinas_config
       FROM gabarito_respostas r
       JOIN gabarito_avaliacoes a ON a.id = r.avaliacao_id
       WHERE r.avaliacao_id = ? AND r.escola_id = ?
       ORDER BY r.nota DESC, r.acertos DESC`,
      [avaliacao_id, escola_id]
    );

    // Parse JSON fields
    const parsed = rows.map(r => ({
      ...r,
      respostas_aluno: safeJson(r.respostas_aluno),
      acertos_por_disciplina: safeJson(r.acertos_por_disciplina),
      detalhes: safeJson(r.detalhes),
      avisos: safeJson(r.avisos),
      gabarito_oficial: safeJson(r.gabarito_oficial),
      disciplinas_config: safeJson(r.disciplinas_config),
    }));

    res.json(parsed);
  } catch (err) {
    console.error("Erro ao buscar resultados:", err);
    res.status(500).json({ error: "Erro ao buscar resultados." });
  }
});

// ─── GET /api/gabaritos/resultados/resumo ────────────────────────────────────
// Retorna um resumo de todas as avaliações que possuem resultados
router.get("/resultados/resumo", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;

  try {
    const [rows] = await pool.query(
      `SELECT 
         a.id, a.titulo, a.bimestre, a.num_questoes, a.nota_total,
         a.disciplinas_config, a.turno, a.status, a.created_at,
         COUNT(r.id) as total_correcoes,
         ROUND(AVG(r.acertos), 1) as media_acertos,
         ROUND(AVG(r.nota), 2) as media_nota,
         MAX(r.nota) as melhor_nota,
         MIN(r.nota) as pior_nota,
         MAX(r.acertos) as max_acertos,
         MIN(r.acertos) as min_acertos
       FROM gabarito_avaliacoes a
       LEFT JOIN gabarito_respostas r ON r.avaliacao_id = a.id AND r.escola_id = a.escola_id
       WHERE a.escola_id = ? AND a.gabarito_oficial IS NOT NULL
       GROUP BY a.id
       ORDER BY a.created_at DESC`,
      [escola_id]
    );

    const parsed = rows.map(r => ({
      ...r,
      disciplinas_config: safeJson(r.disciplinas_config),
    }));

    res.json(parsed);
  } catch (err) {
    console.error("Erro ao buscar resumo:", err);
    res.status(500).json({ error: "Erro ao buscar resumo de resultados." });
  }
});

// ─── GET /api/gabaritos/nome-unicos ──────────────────────────────────────────
// Compat: lista nomes únicos da tabela legada
router.get("/nome-unicos", verificarEscola, async (req, res) => {
  const { escola_id } = req.user;
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT nome_gabarito 
         FROM gabaritos_corrigidos 
         WHERE nome_gabarito IS NOT NULL 
           AND escola_id = ?`,
      [escola_id]
    );
    const nomes = rows.map(r => r.nome_gabarito).filter(Boolean);
    res.json(nomes);
  } catch (err) {
    console.error("Erro ao buscar nomes:", err);
    res.status(500).json({ error: "Erro ao buscar nomes de gabaritos." });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function safeJson(val) {
  if (!val) return null;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return null; }
}

export default router;
