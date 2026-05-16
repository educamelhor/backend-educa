// routes/disciplinar-metadados.js
// ============================================================
// Metadados reais do módulo Disciplinar
// Fornece KPIs, gráficos e tabelas filtrados por período
// ============================================================

import { Router } from "express";
import pool from "../db.js";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────
function periodoWhere(periodo) {
  const hoje = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  switch (periodo) {
    case "hoje":
      return `DATE(o.data_ocorrencia) = CURDATE()`;
    case "semana": {
      const ini = new Date(hoje);
      ini.setDate(hoje.getDate() - hoje.getDay()); // domingo da semana atual
      return `o.data_ocorrencia >= '${iso(ini)}'`;
    }
    case "mes":
      return `YEAR(o.data_ocorrencia) = YEAR(CURDATE()) AND MONTH(o.data_ocorrencia) = MONTH(CURDATE())`;
    case "bimestre": {
      const m = hoje.getMonth() + 1; // 1-based
      const bim = Math.ceil(m / 2);
      const mesIni = (bim - 1) * 2 + 1;
      const mesFim = mesIni + 1;
      return `YEAR(o.data_ocorrencia) = YEAR(CURDATE()) AND MONTH(o.data_ocorrencia) BETWEEN ${mesIni} AND ${mesFim}`;
    }
    default: // ano
      return `YEAR(o.data_ocorrencia) = YEAR(CURDATE())`;
  }
}

// ── GET /api/disciplinar-metadados?periodo=ano ────────────────
router.get("/", async (req, res) => {
  try {
    const { escola_id } = req.user;
    const periodo = req.query.periodo || "ano";
    const where = periodoWhere(periodo);
    const baseWhere = `o.escola_id = ${pool.escape(escola_id)} AND ${where}`;

    // ── 1. Medidas por tipo (medida_disciplinar) ──────────────
    const [medidas] = await pool.query(`
      SELECT COALESCE(r.medida_disciplinar, o.tipo_ocorrencia, 'Outro') AS medida,
             COUNT(*) AS qtd
      FROM ocorrencias_disciplinares o
      LEFT JOIN registros_ocorrencias r
        ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
      WHERE ${baseWhere} AND o.status != 'CANCELADA'
      GROUP BY medida ORDER BY qtd DESC
    `);

    // ── 2. Distribuição de comportamento (faixas de pontuação) ─
    // Calcula pontuação de cada aluno e agrupa por conceito
    const [pontosAlunos] = await pool.query(`
      SELECT a.id AS aluno_id,
             8.0 + COALESCE(SUM(CASE WHEN o2.status != 'CANCELADA' THEN r2.pontos ELSE 0 END), 0) AS pts
      FROM alunos a
      LEFT JOIN ocorrencias_disciplinares o2 ON o2.aluno_id = a.id AND o2.escola_id = a.escola_id
      LEFT JOIN registros_ocorrencias r2
        ON r2.descricao_ocorrencia = o2.motivo AND r2.tipo_ocorrencia = o2.tipo_ocorrencia
      WHERE a.escola_id = ${pool.escape(escola_id)} AND a.status = 'ativo'
      GROUP BY a.id
    `);

    const conceitos = [
      { label: "I - Excepcional",   nota: "10.00",   min: 10,  max: 10,   cor: "#16a34a", bg: "#dcfce7" },
      { label: "II - Ótimo",        nota: "9.0–9.9", min: 9,   max: 9.99, cor: "#3b82f6", bg: "#dbeafe" },
      { label: "III - Bom",         nota: "7.0–8.9", min: 7,   max: 8.99, cor: "#22c55e", bg: "#dcfce7" },
      { label: "IV - Regular",      nota: "5.0–6.9", min: 5,   max: 6.99, cor: "#f59e0b", bg: "#fef9c3" },
      { label: "V - Insuficiente",  nota: "2.0–4.9", min: 2,   max: 4.99, cor: "#ea580c", bg: "#fff7ed" },
      { label: "VI - Incompatível", nota: "0–1.9",   min: 0,   max: 1.99, cor: "#ef4444", bg: "#fee2e2" },
    ];
    const totalAlunos = pontosAlunos.length;
    const comportamento = conceitos.map(c => {
      const qtd = pontosAlunos.filter(a => {
        const p = Math.max(0, Math.min(10, Number(a.pts)));
        return p >= c.min && p <= c.max;
      }).length;
      return { ...c, qtd, pct: totalAlunos ? Math.round((qtd / totalAlunos) * 100) : 0 };
    });

    // ── 3. Top ocorrências por motivo ─────────────────────────
    const [topOcorr] = await pool.query(`
      SELECT o.motivo AS label, COUNT(*) AS qtd
      FROM ocorrencias_disciplinares o
      WHERE ${baseWhere} AND o.status != 'CANCELADA'
      GROUP BY o.motivo ORDER BY qtd DESC LIMIT 8
    `);

    // ── 4. Convocações pendentes (convocar_responsavel=1, sem data comparecimento) ──
    const [convocacoes] = await pool.query(`
      SELECT LPAD(o.id,4,'0') AS registro,
             a.estudante AS aluno,
             t.nome AS turma,
             t.turno,
             DATE_FORMAT(o.data_ocorrencia,'%d/%m/%Y') AS dataOcorrencia,
             COALESCE(r.medida_disciplinar, o.tipo_ocorrencia,'N/D') AS medida,
             DATEDIFF(CURDATE(), o.data_ocorrencia) AS diasPendente
      FROM ocorrencias_disciplinares o
      JOIN alunos a ON a.id = o.aluno_id
      LEFT JOIN turmas t ON t.id = a.turma_id
      LEFT JOIN registros_ocorrencias r
        ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
      WHERE o.escola_id = ${pool.escape(escola_id)}
        AND o.convocar_responsavel = 1
        AND (o.data_comparecimento_responsavel IS NULL OR o.data_comparecimento_responsavel = '')
        AND o.status != 'CANCELADA'
      ORDER BY o.data_ocorrencia ASC
      LIMIT 50
    `);

    // ── 5. Reincidentes (3+ registros no período) ─────────────
    const [reincidentes] = await pool.query(`
      SELECT a.estudante AS aluno,
             t.nome AS turma,
             t.turno,
             COUNT(o.id) AS regs,
             MAX(o.status) AS status,
             (8.0 + COALESCE(SUM(CASE WHEN o.status!='CANCELADA' THEN COALESCE(r.pontos,0) ELSE 0 END),0)) AS pts
      FROM ocorrencias_disciplinares o
      JOIN alunos a ON a.id = o.aluno_id
      LEFT JOIN turmas t ON t.id = a.turma_id
      LEFT JOIN registros_ocorrencias r
        ON r.descricao_ocorrencia = o.motivo AND r.tipo_ocorrencia = o.tipo_ocorrencia
      WHERE ${baseWhere}
      GROUP BY o.aluno_id
      HAVING regs >= 3
      ORDER BY regs DESC, pts ASC
      LIMIT 20
    `);

    // pts clamp
    const reincidentesFmt = reincidentes.map(r => ({
      ...r,
      pts: Math.max(0, Math.min(10, Number(r.pts))),
      regs: Number(r.regs),
    }));

    // ── 6. Termos de Consentimento Pendentes ─────────────────
    // Responsáveis sem documento assinado vinculados a alunos com ocorrências
    const [termos] = await pool.query(`
      SELECT DISTINCT resp.nome AS responsavel,
             a.estudante AS aluno,
             t.nome AS turma,
             resp.telefone_celular AS telefone
      FROM ocorrencias_disciplinares o
      JOIN alunos a ON a.id = o.aluno_id
      LEFT JOIN turmas t ON t.id = a.turma_id
      JOIN responsaveis_alunos ra ON ra.aluno_id = a.id AND ra.escola_id = o.escola_id AND ra.ativo = 1
      JOIN responsaveis resp ON resp.id = ra.responsavel_id
      WHERE o.escola_id = ${pool.escape(escola_id)}
        AND o.convocar_responsavel = 1
        AND (o.data_comparecimento_responsavel IS NULL OR o.data_comparecimento_responsavel = '')
        AND o.status != 'CANCELADA'
      ORDER BY resp.nome
      LIMIT 30
    `);

    // ── KPIs sumários ─────────────────────────────────────────
    const kpiConvocacoes = convocacoes.length;
    const kpiTermos = termos.length;
    const kpiReincidencia = totalAlunos > 0
      ? ((reincidentesFmt.length / totalAlunos) * 100).toFixed(1) + "%"
      : "0%";

    res.json({
      periodo,
      kpis: { convocacoes: kpiConvocacoes, termos: kpiTermos, reincidencia: kpiReincidencia, totalAlunos },
      medidas,
      comportamento,
      topOcorrencias: topOcorr,
      convocacoes,
      reincidentes: reincidentesFmt,
      termos,
    });
  } catch (err) {
    console.error("[DISCIPLINAR-METADADOS]", err);
    res.status(500).json({ error: "Erro ao buscar metadados disciplinares." });
  }
});

export default router;
