// utils/disciplinarCalculos.js
// Modulo compartilhado — importado por relatorio-disciplinar.js e tace.js
// para evitar dependencia circular (tace.js nao pode importar relatorio-disciplinar.js
// porque server.js carrega tace.js ANTES de relatorio-disciplinar.js).

import pool from "../db.js";

// Art. 46 III: Suspensao = pontos_base * dias_suspensao
export function pontosEfetivos(pontoBase, medidaDisciplinar, diasSuspensao) {
  if (String(medidaDisciplinar).trim() === 'Suspens\u00e3o') {
    const dias = Number(diasSuspensao) || 1;
    return Number(pontoBase) * dias;
  }
  return Number(pontoBase) || 0;
}

export function getConceito(pontos) {
  const p = Number(pontos);
  if (p >= 10) return "I - Excepcional";
  if (p >= 9)  return "II - \u00d3timo";
  if (p >= 7)  return "III - Bom";
  if (p >= 5)  return "IV - Regular";
  if (p >= 2)  return "V - Insuficiente";
  return "VI - Incompat\u00edvel";
}

export async function calcularEUpsertMerito(alunoId, escolaId) {
  let totalBonusDias = 0;
  let bonusTotal = 0;
  try {
    const anoAtual = new Date().getFullYear();
    const dataAncoraPadrao = new Date(anoAtual + '-02-15T00:00:00');
    const hoje = new Date(); hoje.setHours(23, 59, 59, 0);
    const [negativos] = await pool.query(
      'SELECT DATE(o.data_ocorrencia) AS data_oc FROM ocorrencias_disciplinares o LEFT JOIN registros_ocorrencias r ON r.descricao_ocorrencia = o.motivo WHERE o.aluno_id = ? AND o.escola_id = ? AND o.tipo_ocorrencia != ' + "'MERITO'" + ' AND o.status NOT IN (' + "'CANCELADA'" + ') AND COALESCE(r.pontos, 0) < 0 AND YEAR(o.data_ocorrencia) = ? ORDER BY o.data_ocorrencia ASC',
      [alunoId, escolaId, anoAtual]
    );
    const datasNegativas = negativos.map(n => { const d = new Date(n.data_oc); d.setHours(0,0,0,0); return d; });
    const inicioGlobal = (datasNegativas.length > 0 && datasNegativas[0] < dataAncoraPadrao) ? datasNegativas[0] : dataAncoraPadrao;
    const marcos = [inicioGlobal, ...datasNegativas, hoje];
    for (let i = 0; i < marcos.length - 1; i++) {
      const diffDias = Math.floor((marcos[i+1] - marcos[i]) / 86400000);
      totalBonusDias += Math.max(0, diffDias - 60);
    }
    bonusTotal = parseFloat((totalBonusDias * 0.01).toFixed(2));
  } catch (e) { console.warn('[MERITO] Erro calculo:', e.message); return { bonusTotal: 0, totalBonusDias: 0, temMerito: false }; }
  if (bonusTotal > 0) {
    try {
      const [[ex]] = await pool.query("SELECT id FROM ocorrencias_disciplinares WHERE aluno_id = ? AND escola_id = ? AND tipo_ocorrencia = 'MERITO' LIMIT 1", [alunoId, escolaId]);
      const desc = 'Pontua\u00e7\u00e3o positiva por m\u00e9rito de aus\u00eancia de reincid\u00eancia de registro.';
      const det  = 'B\u00f4nus acumulado: ' + totalBonusDias + ' dias de m\u00e9rito = +' + bonusTotal.toFixed(2) + ' pontos';
      const h = new Date(); const dr = h.getFullYear()+'-'+String(h.getMonth()+1).padStart(2,'0')+'-'+String(h.getDate()).padStart(2,'0');
      if (ex) { await pool.query('UPDATE ocorrencias_disciplinares SET motivo=?,descricao=?,status=' + "'FINALIZADA'" + ',data_ocorrencia=? WHERE id=?', [desc, det, dr, ex.id]); }
      else     { await pool.query("INSERT INTO ocorrencias_disciplinares (aluno_id,escola_id,tipo_ocorrencia,motivo,descricao,status,data_ocorrencia) VALUES (?,?,'MERITO',?,?,'FINALIZADA',?)", [alunoId, escolaId, desc, det, dr]); }
    } catch (e) { console.warn('[MERITO] Erro persistir:', e.message); }
  }
  return { bonusTotal, totalBonusDias, temMerito: bonusTotal > 0 };
}

export async function calcularEUpsertBonusMedia(alunoId, escolaId) {
  const MOTIVOS = { 1:'B\u00f4nus de m\u00e9dia bimestral >= 8,00 \u2014 1B', 2:'B\u00f4nus de m\u00e9dia bimestral >= 8,00 \u2014 2B', 3:'B\u00f4nus de m\u00e9dia bimestral >= 8,00 \u2014 3B', 4:'B\u00f4nus de m\u00e9dia bimestral >= 8,00 \u2014 4B' };
  const NOMES  = ['','1\u00ba Bimestre','2\u00ba Bimestre','3\u00ba Bimestre','4\u00ba Bimestre'];
  const PONTOS = 0.50;
  try {
    const anoAtual = new Date().getFullYear();
    for (const bim of [1,2,3,4]) {
      const [[ex]] = await pool.query("SELECT id FROM registros_ocorrencias WHERE tipo_ocorrencia='BONUS_MEDIA' AND descricao_ocorrencia=? LIMIT 1", [MOTIVOS[bim]]);
      if (!ex) await pool.query("INSERT INTO registros_ocorrencias (medida_disciplinar,tipo_ocorrencia,descricao_ocorrencia,pontos,ativo) VALUES ('B\u00f4nus de M\u00e9dia Bimestral','BONUS_MEDIA',?,?,1)", [MOTIVOS[bim], PONTOS]);
    }
    const [medias] = await pool.query('SELECT bimestre, ROUND(AVG(nota),2) AS media FROM notas WHERE aluno_id=? AND ano=? GROUP BY bimestre ORDER BY bimestre', [alunoId, anoAtual]);
    const h = new Date(); const dr = h.getFullYear()+'-'+String(h.getMonth()+1).padStart(2,'0')+'-'+String(h.getDate()).padStart(2,'0');
    const bonus = new Set();
    for (const row of medias) {
      const bim = Number(row.bimestre); const media = Number(row.media);
      if (bim < 1 || bim > 4) continue;
      if (media >= 8.00) {
        bonus.add(bim);
        const det = NOMES[bim] + ' \u2014 M\u00e9dia: ' + media.toFixed(2).replace('.',',') + ' \u2265 8,00 \u2192 +0,50 pontos disciplinares';
        const [[ex]] = await pool.query("SELECT id FROM ocorrencias_disciplinares WHERE aluno_id=? AND escola_id=? AND tipo_ocorrencia='BONUS_MEDIA' AND motivo=? AND YEAR(data_ocorrencia)=? LIMIT 1", [alunoId, escolaId, MOTIVOS[bim], anoAtual]);
        if (ex) { await pool.query('UPDATE ocorrencias_disciplinares SET descricao=?,data_ocorrencia=?,status=' + "'FINALIZADA'" + ' WHERE id=?', [det, dr, ex.id]); }
        else     { await pool.query("INSERT INTO ocorrencias_disciplinares (aluno_id,escola_id,tipo_ocorrencia,motivo,descricao,status,data_ocorrencia) VALUES (?,?,'BONUS_MEDIA',?,?,'FINALIZADA',?)", [alunoId, escolaId, MOTIVOS[bim], det, dr]); }
      }
    }
    for (const bim of [1,2,3,4]) {
      if (!bonus.has(bim)) await pool.query("DELETE FROM ocorrencias_disciplinares WHERE aluno_id=? AND escola_id=? AND tipo_ocorrencia='BONUS_MEDIA' AND motivo=? AND YEAR(data_ocorrencia)=?", [alunoId, escolaId, MOTIVOS[bim], anoAtual]);
    }
    return { bimestresBonus:[...bonus], bonusTotal: bonus.size * PONTOS };
  } catch(e) { console.warn('[BONUS_MEDIA] Erro:', e.message); return { bimestresBonus:[], bonusTotal:0 }; }
}
