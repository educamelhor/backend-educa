import pool from './db.js';

function safeJson(str) {
  if (!str) return null;
  try {
    return typeof str === "string" ? JSON.parse(str) : str;
  } catch (e) {
    return null;
  }
}

async function run() {
  console.log("Iniciando migração de ajustes pendentes...");
  
  try {
    // 1. Encontrar todos os ajustes pendentes
    const [pendentes] = await pool.query(
      "SELECT * FROM gabarito_ajustes_manuais WHERE status = 'pendente'"
    );
    
    console.log(`Encontrados ${pendentes.length} ajustes pendentes.`);
    
    if (pendentes.length === 0) {
      console.log("Nada a fazer.");
      process.exit(0);
    }

    // Agrupar por arquivo para não recalcular o mesmo arquivo múltiplas vezes se tiver mais de um ajuste
    const arquivosAfetados = {};
    
    for (const ajuste of pendentes) {
      arquivosAfetados[ajuste.arquivo_id] = ajuste.escola_id;
      
      // Atualizar para aprovado
      await pool.query(
        "UPDATE gabarito_ajustes_manuais SET status = 'aprovado', decidido_em = CURRENT_TIMESTAMP WHERE id = ?",
        [ajuste.id]
      );
      console.log(`Ajuste ${ajuste.id} atualizado para 'aprovado'.`);
    }

    console.log(`Recalculando notas para ${Object.keys(arquivosAfetados).length} arquivos...`);

    // 2. Recalcular nota para cada arquivo afetado
    for (const arquivoId of Object.keys(arquivosAfetados)) {
      const escolaId = arquivosAfetados[arquivoId];
      await recalcularNotaArquivo(arquivoId, escolaId);
    }

    console.log("Migração concluída com sucesso!");
    process.exit(0);
  } catch (err) {
    console.error("Erro na migração:", err);
    process.exit(1);
  }
}

async function recalcularNotaArquivo(arquivo_id, escola_id) {
  // Buscar arquivo + avaliação
  const [arqRows] = await pool.query(
    `SELECT a.*, l.avaliacao_id
     FROM gabarito_arquivos a
     JOIN gabarito_lotes l ON l.id = a.lote_id
     WHERE a.id = ? AND a.escola_id = ?`,
    [arquivo_id, escola_id]
  );
  
  if (arqRows.length === 0) return null;
  const arq = arqRows[0];
  const respostasAluno = safeJson(arq.respostas_aluno) || [];

  // Buscar gabarito oficial + questões canceladas
  const [avRows] = await pool.query(
    `SELECT gabarito_oficial, num_questoes, nota_total, disciplinas_config, questoes_canceladas
     FROM gabarito_avaliacoes WHERE id = ? AND escola_id = ?`,
    [arq.avaliacao_id, escola_id]
  );
  
  if (avRows.length === 0) return null;
  const avaliacao = avRows[0];
  const gabOficial   = safeJson(avaliacao.gabarito_oficial) || [];
  const numQuestoes  = avaliacao.num_questoes || gabOficial.length;
  const notaTotal    = Number(avaliacao.nota_total) || 10;
  const canceladas   = safeJson(avaliacao.questoes_canceladas) || [];

  // Mapear questões canceladas por número
  const cancelMap = {};
  for (const c of canceladas) {
    cancelMap[c.numero] = c.modo;
  }

  // Calcular total efetivo (excluindo desconsideradas)
  const numDesconsideradas  = canceladas.filter(c => c.modo === "desconsiderar").length;
  const numQuestoesEfetivas = Math.max(1, numQuestoes - numDesconsideradas);

  // Buscar TODOS os ajustes aprovados para este arquivo
  const [todosAjustes] = await pool.query(
    `SELECT questao_numero, tipo_ajuste FROM gabarito_ajustes_manuais
     WHERE arquivo_id = ? AND status = 'aprovado'`,
    [arquivo_id]
  );

  const ajustesMap = {};
  for (const a of todosAjustes) {
    ajustesMap[a.questao_numero] = a.tipo_ajuste;
  }

  const detalhes = [];
  for (let i = 0; i < numQuestoes; i++) {
    const questaoNum = i + 1;
    const modoCancelada = cancelMap[questaoNum];

    if (modoCancelada === "desconsiderar") continue;

    const resp    = respostasAluno[i] || null;
    const correto = gabOficial[i] || "";
    const isNulo  = resp === "N";
    let acertou   = !isNulo && resp !== null && resp === correto;

    if (ajustesMap[questaoNum] !== undefined) {
      acertou = ajustesMap[questaoNum] === "acerto";
    }
    else if (modoCancelada === "bonificar") {
      acertou = true;
    }

    detalhes.push({
      numero: questaoNum,
      resposta: resp,
      correto,
      acertou,
      ...(modoCancelada === "bonificar" ? { cancelada: "bonificada" } : {}),
      ...(ajustesMap[questaoNum] !== undefined ? { ajuste_manual: ajustesMap[questaoNum] } : {}),
    });
  }

  const acertos      = detalhes.filter(d => d.acertou).length;
  const valorQuestao = numQuestoesEfetivas > 0 ? notaTotal / numQuestoesEfetivas : 0;
  const nota         = parseFloat((acertos * valorQuestao).toFixed(2));

  const disciplinasConfig = safeJson(avaliacao.disciplinas_config) || [];
  let acertosPorDisciplina = null;
  if (disciplinasConfig.length > 0) {
    acertosPorDisciplina = disciplinasConfig.map(dc => {
      const questoesDisciplina = detalhes.filter(d => d.numero >= dc.de && d.numero <= dc.ate);
      const acertosDisciplina  = questoesDisciplina.filter(d => d.acertou).length;
      return {
        nome: dc.nome,
        disciplina_id: dc.disciplina_id,
        de: dc.de, ate: dc.ate,
        total: questoesDisciplina.length,
        acertos: acertosDisciplina,
      };
    });
  }

  // Atualizar gabarito_arquivos
  await pool.query(
    `UPDATE gabarito_arquivos SET acertos = ?, nota = ? WHERE id = ?`,
    [acertos, nota, arquivo_id]
  );

  const codigoAluno = arq.codigo_aluno || `ARQ_${arquivo_id}`;
  const [upd] = await pool.query(
    `UPDATE gabarito_respostas SET
      acertos = ?, total_questoes = ?, nota = ?,
      detalhes = ?, acertos_por_disciplina = ?
     WHERE avaliacao_id = ? AND escola_id = ? AND codigo_aluno = ?`,
    [
      acertos, numQuestoesEfetivas, nota,
      JSON.stringify(detalhes),
      acertosPorDisciplina ? JSON.stringify(acertosPorDisciplina) : null,
      arq.avaliacao_id, escola_id, codigoAluno,
    ]
  );

  const linhasAfetadas = upd.affectedRows || 0;
  console.log(
    `[Migração] Arquivo ${arquivo_id} aluno ${codigoAluno} -> ${acertos}/${numQuestoesEfetivas} acertos, nota ${nota}. Respostas afetadas: ${linhasAfetadas}`
  );
}

run();
