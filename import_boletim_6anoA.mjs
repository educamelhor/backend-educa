/**
 * import_boletim_6anoA.mjs
 * ─────────────────────────────────────────────────────────
 * Importa notas e faltas do 1º Bimestre / Ano Letivo 2026
 * da turma 6º ANO A diretamente do PDF oficial para o banco.
 *
 * Uso:
 *   Dry-run (apenas simulação):
 *     node import_boletim_6anoA.mjs --dry-run
 *
 *   Importação Real (grava no BD):
 *     node import_boletim_6anoA.mjs
 * ─────────────────────────────────────────────────────────
 */

import { readFileSync } from 'fs';
import pdf from 'pdf-parse';
import pool from './db.js';

const ESCOLA_ID  = 1;
const ANO         = 2026;
const BIMESTRE    = 1;
const TURMA_NOME  = '6º ANO A';
const PDF_PATH    = 'C:/projetos/sistema_educacional/geral/boletim/6º ANO A - BOLETIM.pdf';
const DRY_RUN     = process.argv.includes('--dry-run');

const DISCIPLINA_MAP = {
  'PARTE DIVERSIFICADA I': 51,  // Prática Estudantil
  'PARTE DIVERSIFICADA II': 29, // Geometria
  'CIÊNCIAS NATURAIS': 25,      // Ciências
  'EDUCAÇÃO FÍSICA': 27,        // Ed. Física
  'GEOGRAFIA': 23,              // Geografia
  'HISTÓRIA': 24,               // História
  'LEM/INGLÊS': 30,             // Inglês
  'MATEMÁTICA': 21,             // Matemática
  'LÍNGUA PORTUGUESA': 48,      // Português
  'ARTES': 26,                  // Artes
};

const pageTexts = [];

async function render_page(pageData) {
  let render_options = {
    normalizeWhitespace: true,
    disableCombineTextItems: false
  };

  const textContent = await pageData.getTextContent(render_options);
  let lastY, text = '';
  for (let item of textContent.items) {
    if (lastY === item.transform[5] || !lastY){
      text += " " + item.str;
    } else {
      text += '\n' + item.str;
    }
    lastY = item.transform[5];
  }
  pageTexts.push({
    page: pageData.pageNumber,
    text: text
  });
  return text;
}

async function main() {
  console.log('📖 INICIANDO IMPORTAÇÃO DE BOLETIM — 6º ANO A');
  console.log(`📅 Ano Letivo: ${ANO} | Bimestre: ${BIMESTRE}º | Escola ID: ${ESCOLA_ID}`);
  if (DRY_RUN) console.log('⚠️  MODO SIMULAÇÃO (DRY-RUN) — Nenhum dado será modificado no banco.\n');

  // 1. Ler o PDF
  console.log(`📄 Lendo arquivo PDF: "${PDF_PATH}"...`);
  const buf = readFileSync(PDF_PATH);
  await pdf(buf, { pagerender: render_page });
  pageTexts.sort((a, b) => a.page - b.page);
  console.log(`✅ PDF lido com sucesso. Total de páginas: ${pageTexts.length}\n`);

  // 2. Extrair dados dos alunos das páginas ímpares
  const parsedStudents = [];
  for (let i = 0; i < pageTexts.length; i += 2) {
    const pageNum = i + 1;
    const text = pageTexts[i].text;

    const nameMatch = text.match(/Nome do\(a\) Estudante:\s*([^\r\n]+)/);
    const reMatch = text.match(/(?:RE\s*RE\s*nº|RERE\s*nº):\s*(\d+)/i);

    if (!nameMatch || !reMatch) {
      console.warn(`⚠️  Falha ao ler dados de identificação na página ${pageNum}.`);
      continue;
    }

    const rawName = nameMatch[1].trim();
    let studentName = rawName;
    const cleanNameMatch = rawName.match(/^([^\(]+?)(?:\s*(?:RE\s*RE\s*nº|RERE\s*nº|\s*RE\s*nº))/i);
    if (cleanNameMatch) {
      studentName = cleanNameMatch[1].trim();
    } else {
      studentName = studentName.replace(/\s+RE\s*RE\s*nº.*$/i, '').trim();
    }

    const re = parseInt(reMatch[1].trim());
    const student = {
      name: studentName,
      re: re,
      grades: []
    };

    const lines = text.split('\n');
    for (const line of lines) {
      const match = line.match(/^([a-zA-ZáéíóúàèìòùâêîôûãõçÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÃÕÇ/ ]+?)\s+(\d+,\d+)\s+(\d+)\s+CURSANDO/i);
      if (match) {
        const discName = match[1].trim();
        const gradeStr = match[2].trim().replace(',', '.');
        const absences = parseInt(match[3].trim());
        const discId = DISCIPLINA_MAP[discName];

        if (discId) {
          student.grades.push({
            disciplineName: discName,
            disciplineId: discId,
            grade: parseFloat(gradeStr),
            absences: absences
          });
        }
      }
    }

    parsedStudents.push(student);
  }

  console.log(`✅ Total de alunos estruturados do PDF: ${parsedStudents.length}\n`);

  // 3. Conexão com o Banco de Dados e Gravação/Upsert
  const conn = await pool.getConnection();
  try {
    let inseridos = 0;
    let atualizados = 0;
    let pulados = 0;

    for (const ps of parsedStudents) {
      // Obter aluno correspondente no banco
      const [dbAlunos] = await conn.query(
        "SELECT id, estudante FROM alunos WHERE codigo = ? AND escola_id = ? AND status = 'ativo'",
        [ps.re, ESCOLA_ID]
      );

      if (dbAlunos.length === 0) {
        console.error(`❌ Aluno com RE ${ps.re} ("${ps.name}") não foi encontrado ativo no banco de dados!`);
        process.exit(1); // Aborta a operação imediatamente por segurança se um aluno falhar
      }

      const dbA = dbAlunos[0];
      console.log(`👤 Processando: ${ps.name} (RE: ${ps.re} | ID Banco: ${dbA.id})`);

      for (const g of ps.grades) {
        if (DRY_RUN) {
          console.log(`  [DRY] Matéria: ${g.disciplineName.padEnd(25)} (ID: ${g.disciplineId}) | Nota: ${g.grade.toFixed(2)} | Faltas: ${g.absences}`);
          inseridos++;
          continue;
        }

        const [res] = await conn.query(`
          INSERT INTO notas
            (escola_id, aluno_id, ano, bimestre, disciplina_id, nota, faltas, data_lancamento)
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            nota = VALUES(nota),
            faltas = VALUES(faltas),
            data_lancamento = NOW()
        `, [ESCOLA_ID, dbA.id, ANO, BIMESTRE, g.disciplineId, g.grade, g.absences]);

        if (res.affectedRows === 1) {
          inseridos++;
          console.log(`  ✔ Inserido: ${g.disciplineName.padEnd(25)} | Nota: ${g.grade.toFixed(2)} | Faltas: ${g.absences}`);
        } else if (res.affectedRows === 2) {
          atualizados++;
          console.log(`  🔄 Atualizado: ${g.disciplineName.padEnd(25)} | Nota: ${g.grade.toFixed(2)} | Faltas: ${g.absences}`);
        } else {
          pulados++;
        }
      }
      console.log(); // Linha em branco por aluno
    }

    console.log('══════════════════════════════════════════════');
    console.log('📊 RELATÓRIO FINAL DE IMPORTAÇÃO');
    console.log('══════════════════════════════════════════════');
    console.log(`   Registros Inseridos   : ${inseridos}`);
    console.log(`   Registros Atualizados : ${atualizados}`);
    console.log(`   Registros Inalterados : ${pulados}`);
    console.log(`   Total de Alunos       : ${parsedStudents.length}`);
    console.log(`   Modo                  : ${DRY_RUN ? 'SIMULAÇÃO' : 'GRAVAÇÃO REAL'}`);
    console.log('══════════════════════════════════════════════\n');

  } catch (err) {
    console.error('❌ Ocorreu um erro fatal durante a importação:', err.message);
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
