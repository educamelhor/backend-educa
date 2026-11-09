// utils/vigenciaHorariosHelper.js
// ============================================================================
// Resolve automaticamente o Ano Letivo, Semestre Atual (1º ou 2º) e Bimestre
// vigente da escola a partir de `governanca_ano_letivo_periodos` (Direção >
// Governança) com fallback inteligente para o calendário oficial SEEDF.
// ============================================================================

import pool from "../db.js";

function toIsoDateOnly(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

export function getAnoLetivoAtual() {
  const hoje = new Date();
  // Janeiro ainda pertence ao encerramento do ano letivo anterior na rede pública
  return hoje.getMonth() === 0 ? hoje.getFullYear() - 1 : hoje.getFullYear();
}

export function getSemestrePadraoCalendario() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1; // 1..12
  // Janeiros de encerramento ou meses de Julho (7) a Dezembro (12) pertencem ao 2º Semestre
  if (mes === 1 || mes >= 7) return 2;
  return 1;
}

export function getBimestrePadraoCalendario() {
  const hoje = new Date();
  const mes = hoje.getMonth() + 1; // 1..12
  if (mes === 1) return 4;
  if (mes <= 4) return 1;
  if (mes <= 6) return 2;
  if (mes <= 9) return 3;
  return 4;
}

/**
 * Resolve a vigência acadêmica da escola para o módulo de Horários / Modulação.
 * @param {number|string} escolaId
 * @param {number|string|null} semestreExplicito Se 1 ou 2 for informado explicitamente, respeita-o como semestre_referencia
 */
export async function resolverVigenciaLetiva(escolaId, semestreExplicito = null) {
  const anoLetivo = getAnoLetivoAtual();
  const hojeIso = new Date().toISOString().slice(0, 10);

  let semestreAtual = getSemestrePadraoCalendario();
  let bimestreAtual = getBimestrePadraoCalendario();
  let origem = "calendario_padrao";
  let periodoSemestre = null;
  let periodoBimestre = null;
  let possuiSemestral = false;
  let possuiAnual = false;

  if (escolaId) {
    try {
      const [rows] = await pool.query(
        `SELECT tipo, numero, data_inicio, data_fim
           FROM governanca_ano_letivo_periodos
          WHERE escola_id = ? AND ano_letivo = ?
          ORDER BY tipo ASC, numero ASC`,
        [Number(escolaId), anoLetivo]
      );

      const bimestres = [];
      const semestres = [];
      for (const r of rows || []) {
        const inicio = toIsoDateOnly(r.data_inicio);
        const fim = toIsoDateOnly(r.data_fim);
        if (!inicio || !fim) continue;
        const item = {
          tipo: r.tipo,
          numero: Number(r.numero),
          data_inicio: inicio,
          data_fim: fim,
        };
        if (r.tipo === "bimestre") bimestres.push(item);
        else if (r.tipo === "semestre") semestres.push(item);
      }

      // 1) Resolve bimestre pela data atual
      if (bimestres.length > 0) {
        const bimExato = bimestres.find((b) => hojeIso >= b.data_inicio && hojeIso <= b.data_fim);
        if (bimExato) {
          bimestreAtual = bimExato.numero;
          periodoBimestre = bimExato;
          origem = "governanca_escola";
        } else {
          const iniciados = bimestres.filter((b) => hojeIso >= b.data_inicio);
          if (iniciados.length > 0) {
            const ultimo = iniciados[iniciados.length - 1];
            bimestreAtual = ultimo.numero;
            periodoBimestre = ultimo;
            origem = "governanca_escola";
          }
        }
      }

      // 2) Resolve semestre pela data atual ou pelo bimestre ativo da governança
      if (semestres.length > 0) {
        const semExato = semestres.find((s) => hojeIso >= s.data_inicio && hojeIso <= s.data_fim);
        if (semExato) {
          semestreAtual = semExato.numero;
          periodoSemestre = semExato;
          origem = "governanca_escola";
        } else {
          const sem1 = semestres.find((s) => s.numero === 1);
          const sem2 = semestres.find((s) => s.numero === 2);
          if (sem2 && hojeIso >= sem2.data_inicio) {
            semestreAtual = 2;
            periodoSemestre = sem2;
            origem = "governanca_escola";
          } else if (sem1 && hojeIso > sem1.data_fim) {
            semestreAtual = 2;
            periodoSemestre = sem2 || null;
            origem = "governanca_escola";
          } else if (sem1 && hojeIso <= sem1.data_fim) {
            semestreAtual = 1;
            periodoSemestre = sem1;
            origem = "governanca_escola";
          }
        }
      } else if (bimestres.length > 0) {
        semestreAtual = bimestreAtual >= 3 ? 2 : 1;
      }
    } catch {
      // ignora se tabela ainda não existir
    }

    // 3) Verifica regimes das turmas ativas da escola no ano letivo
    try {
      const [regRows] = await pool.query(
        `SELECT DISTINCT LOWER(COALESCE(regime, 'anual')) AS regime
           FROM turmas
          WHERE escola_id = ? AND ano = ?`,
        [Number(escolaId), anoLetivo]
      );
      for (const r of regRows || []) {
        if (r.regime === "semestral") possuiSemestral = true;
        else possuiAnual = true;
      }
    } catch {
      // fallback silencioso
    }
  }

  const semExpNum = Number(semestreExplicito);
  const semestreReferencia =
    semExpNum === 1 || semExpNum === 2 ? semExpNum : semestreAtual;

  const regimePredominante =
    possuiSemestral && possuiAnual
      ? "misto"
      : possuiSemestral
      ? "semestral"
      : "anual";

  return {
    ano_letivo: anoLetivo,
    semestre_atual: semestreAtual,
    semestre_referencia: semestreReferencia,
    bimestre_atual: bimestreAtual,
    possui_semestral: possuiSemestral,
    possui_anual: possuiAnual,
    regime_predominante: regimePredominante,
    origem,
    periodo_semestre: periodoSemestre,
    periodo_bimestre: periodoBimestre,
    label_curto: `${semestreReferencia}º Semestre / ${anoLetivo}`,
    label_completo: `${semestreReferencia}º Semestre / ${anoLetivo} • Cargas e Turmas Vigentes`,
  };
}

export default {
  getAnoLetivoAtual,
  getSemestrePadraoCalendario,
  getBimestrePadraoCalendario,
  resolverVigenciaLetiva,
};
