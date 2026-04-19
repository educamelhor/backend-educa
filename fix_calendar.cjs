// fix_calendar.cjs — script temporário para corrigir educadf.pap.js
// Causa raiz: ngb-datepicker é portal do Angular, renderizado no <body>,
// FORA do ngb-modal-window. Código antigo buscava dentro do modal e falhava.

const fs = require('fs');
const filePath = 'modules/agente/educadf/educadf.pap.js';
let src = fs.readFileSync(filePath, 'utf8');

let fixes = 0;
let skips = 0;

function fix(label, oldStr, newStr) {
  if (src.includes(oldStr)) {
    src = src.replace(oldStr, newStr);
    console.log(`✅ ${label}`);
    fixes++;
  } else {
    console.warn(`⏭️  SKIP ${label} — padrão não encontrado`);
    skips++;
  }
}

// ── FIX 1: Abertura do popup — adicionar retry e log ─────────────────────────
fix('FIX1 abertura popup',
  `  // Primeiro: abre o datepicker clicando no input de data (ele já pode estar aberto)
  await page.evaluate(() => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return;
    const allInputs = [...modal.querySelectorAll('input')];
    const dateInp = allInputs.find(inp => /\\d{1,2}\\s+\\w{3}/.test(inp.value || ''));
    if (dateInp) { dateInp.focus(); dateInp.click(); }
  });
  await page.waitForTimeout(600);`,
  `  // PASSO 1: Abre o popup do datepicker clicando no input de data no modal.
  // IMPORTANTE: o ngb-datepicker é renderizado como PORTAL no <body>,
  // fora do DOM do ngb-modal-window — nunca buscá-lo dentro do modal.
  const inputAbrir = await page.evaluate(() => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return 'modal-not-found';
    const allInputs = [...modal.querySelectorAll('input')];
    const dateInp = allInputs.find(inp => /\\d{1,2}\\s+\\w{3}/.test(inp.value || ''));
    if (dateInp) {
      dateInp.focus();
      dateInp.click();
      dateInp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'input-clicado:' + dateInp.value;
    }
    return 'date-input-not-found';
  });
  console.log(\`[educadf.pap] calendário: abrindo popup → \${inputAbrir}\`);
  await page.waitForTimeout(900);

  // PASSO 2: Verifica se ngb-datepicker apareceu no document (com retry)
  let calPopupOk = false;
  for (let attempt = 0; attempt < 3 && !calPopupOk; attempt++) {
    calPopupOk = await page.evaluate(() => !!document.querySelector('ngb-datepicker'));
    if (!calPopupOk) {
      console.warn(\`[educadf.pap] calendário: popup não abriu (tentativa \${attempt + 1}/3)...\`);
      await page.waitForTimeout(600);
    }
  }
  if (!calPopupOk) {
    console.warn('[educadf.pap] calendário: ngb-datepicker não encontrado no document após 3 tentativas.');
    return false;
  }`
);

// ── FIX 2: leitura do calInfo — busca no document inteiro ────────────────────
fix('FIX2 calInfo busca no document',
  `      const modal = document.querySelector('ngb-modal-window');
      const cal   = modal?.querySelector('ngb-datepicker');
      if (!cal) return null;`,
  `      // PORTAL: ngb-datepicker é renderizado no <body>, fora do ngb-modal-window
      const cal = document.querySelector('ngb-datepicker');
      if (!cal) return null;`
);

// ── FIX 3: clique no dia — busca no document inteiro ─────────────────────────
fix('FIX3 clique dia busca no document',
  `        const modal = document.querySelector('ngb-modal-window');
        const cal   = modal?.querySelector('ngb-datepicker');
        if (!cal) return false;`,
  `        // PORTAL: ngb-datepicker é renderizado no <body>, fora do ngb-modal-window
        const cal = document.querySelector('ngb-datepicker');
        if (!cal) return null;`
);

// ── FIX 4: clique com dispatchEvent (mais compatível com Angular) ─────────────
fix('FIX4 dispatchEvent no dia',
  `            btn.scrollIntoView({ block: 'center' });
            btn.click();
            return \`dia \${day} clicado\`;`,
  `            btn.scrollIntoView({ block: 'center' });
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return \`dia \${day} clicado\`;`
);

// ── FIX 5: aria-label fallback — também usa dispatchEvent ────────────────────
fix('FIX5 dispatchEvent aria-label',
  `            btn.scrollIntoView({ block: 'center' });
            btn.click();
            return \`dia \${day} clicado via aria-label\`;`,
  `            btn.scrollIntoView({ block: 'center' });
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return \`dia \${day} clicado via aria-label\`;`
);

// ── FIX 6: return null → return string descritiva para log ──────────────────
fix('FIX6 retorno descritivo',
  `        return null;
      }, tDay, tMonth, tYear);

      if (clicked) {`,
  `        // Log diagnóstico: mostra quais dias estão disponíveis no calendário
        const disponiveis = [...cal.querySelectorAll('.ngb-dp-day button')].map(b => b.textContent?.trim()).filter(Boolean).join(',');
        return \`nao-encontrado:[\${disponiveis}]\`;
      }, tDay, tMonth, tYear);

      if (clicked && (clicked.startsWith('dia'))) {`
);

// ── FIX 7: mensagem de not-found mais informativa ─────────────────────────────
fix('FIX7 log nao-encontrado',
  `        console.warn(\`[educadf.pap] calendário ⚠️: dia \${tDay} não encontrado. Tentando navegação de fallback.\`);`,
  `        console.warn(\`[educadf.pap] calendário ⚠️: \${clicked}\`);`
);

// ── FIX 8: navegação por selects — busca no document ─────────────────────────
fix('FIX8 selects nav no document',
  `        const modal = document.querySelector('ngb-modal-window');
        const cal   = modal?.querySelector('ngb-datepicker');
        const selects = [...(cal?.querySelectorAll('select') || [])];`,
  `        // PORTAL: busca no document inteiro
        const cal = document.querySelector('ngb-datepicker');
        const selects = [...(cal?.querySelectorAll('select') || [])];`
);

// ── FIX 9: navegação por botões prev/next — busca no document ────────────────
fix('FIX9 btn nav no document',
  `        const modal = document.querySelector('ngb-modal-window');
        const cal   = modal?.querySelector('ngb-datepicker');`,
  `        // PORTAL: busca no document inteiro
        const cal = document.querySelector('ngb-datepicker');`
);

// ── Salvas e verifica ─────────────────────────────────────────────────────────
fs.writeFileSync(filePath, src, 'utf8');

const remaining = (src.match(/modal\?\.querySelector\('ngb-datepicker'\)/g) || []).length;
console.log('');
console.log(`Fixes aplicados: ${fixes} | Skips: ${skips}`);
console.log(`Ocorrências restantes de modal?.querySelector('ngb-datepicker'): ${remaining}`);
if (remaining === 0) {
  console.log('✅ Patch concluído com sucesso!');
} else {
  console.error('❌ Ainda há ocorrências do padrão antigo!');
  process.exit(1);
}
