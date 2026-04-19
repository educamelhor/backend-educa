// fix_popup_block.cjs — substitui o bloco de abertura do popup (linhas 255-263)
const fs = require('fs');
const f = 'modules/agente/educadf/educadf.pap.js';
let lines = fs.readFileSync(f, 'utf8').split('\n');

console.log('Linha 254 (0-idx):', lines[254]);
console.log('Linha 255 (0-idx):', lines[255]);
console.log('Linha 263 (0-idx):', lines[263]);

const newBlock = [
  '  // PASSO 1: Abre o popup do datepicker clicando no input de data.',
  '  // IMPORTANTE: ngb-datepicker e portal Angular renderizado no <body>,',
  '  // fora do ngb-modal-window. Buscar no document inteiro, nao dentro do modal.',
  '  const inputAbrir = await page.evaluate(() => {',
  "    const modal = document.querySelector('ngb-modal-window');",
  "    if (!modal) return 'modal-not-found';",
  "    const allInputs = [...modal.querySelectorAll('input')];",
  '    const dateInp = allInputs.find(inp => /\\d{1,2}\\s+\\w{3}/.test(inp.value || \'\'));',
  '    if (dateInp) {',
  '      dateInp.focus();',
  '      dateInp.click();',
  "      dateInp.dispatchEvent(new MouseEvent('click', { bubbles: true }));",
  "      return 'input-clicado:' + dateInp.value;",
  '    }',
  "    return 'date-input-not-found';",
  '  });',
  "  console.log('[educadf.pap] calendario: abrindo popup -> ' + inputAbrir);",
  '  await page.waitForTimeout(900);',
  '',
  '  // PASSO 2: Verifica que ngb-datepicker apareceu no document (retry x3)',
  '  let calPopupOk = false;',
  '  for (let attempt = 0; attempt < 3 && !calPopupOk; attempt++) {',
  "    calPopupOk = await page.evaluate(() => !!document.querySelector('ngb-datepicker'));",
  '    if (!calPopupOk) {',
  "      console.warn('[educadf.pap] calendario: popup nao abriu (tentativa ' + (attempt+1) + '/3)...');",
  '      await page.waitForTimeout(600);',
  '    }',
  '  }',
  '  if (!calPopupOk) {',
  "    console.warn('[educadf.pap] calendario: ngb-datepicker nao encontrado no document apos 3 tentativas.');",
  '    return false;',
  '  }',
];

// Substituir linhas 254..262 (9 linhas, 0-indexed) = linhas 255-263 no editor
lines.splice(254, 9, ...newBlock);
fs.writeFileSync(f, lines.join('\n'), 'utf8');

const newSrc = fs.readFileSync(f, 'utf8');
const hasOld = newSrc.includes('Primeiro: abre o datepicker');
const hasNew = newSrc.includes('PASSO 1: Abre o popup');
console.log('Tem padrao antigo:', hasOld, '| Tem padrao novo:', hasNew);
console.log('Total linhas:', newSrc.split('\n').length);
if (!hasOld && hasNew) {
  console.log('PATCH OK!');
} else {
  console.error('PATCH FALHOU!');
  process.exit(1);
}
