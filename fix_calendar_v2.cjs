// fix_calendar_v2.cjs — Reescreve a função navegarCalendarioEClicarDia
// O popup ngb-datepicker NÃO abre ao clicar no input.
// No Angular ng-bootstrap, o popup abre ao clicar num BOTÃO TOGGLE (ícone calendário).
// Se o popup não existir, manipula o input diretamente via Angular events.

const fs = require('fs');
const f = 'modules/agente/educadf/educadf.pap.js';
let lines = fs.readFileSync(f, 'utf8').split('\n');

// Encontrar limites da função navegarCalendarioEClicarDia
// Começa no comentário "// HELPER: Navega o calendario" (linha ~236)
// Termina no "}" final da função (antes do "// ⚠️  preencherDatePicker")
let startIdx = -1;
let endIdx = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('HELPER: Navega o calend') && lines[i].includes('ngb-datepicker')) {
    startIdx = i;
  }
  if (startIdx >= 0 && endIdx < 0 && i > startIdx + 10) {
    // Procura a linha que contém "preencherDatePicker() REMOVIDA"
    if (lines[i].includes('preencherDatePicker() REMOVIDA')) {
      // endIdx é a linha anterior (o } final da função)
      endIdx = i - 1;
      // Garante que endIdx é o fechamento da função (uma linha com apenas "}")
      while (endIdx > startIdx && lines[endIdx].trim() === '') endIdx--;
      break;
    }
  }
}

console.log(`Função encontrada: linhas ${startIdx + 1} a ${endIdx + 1} (0-indexed: ${startIdx}-${endIdx})`);
console.log(`Primeira: ${lines[startIdx]}`);
console.log(`Última:   ${lines[endIdx]}`);

if (startIdx < 0 || endIdx < 0) {
  console.error('Não encontrou os limites da função!');
  process.exit(1);
}

const newFunction = `// ============================================================================
// HELPER: Altera a data no modal de criação/edição do Procedimento Avaliativo.
//
// ESTRATÉGIA TRIPLA:
//  1. Procura um botão de toggle (ícone calendário) ao lado do input de data
//     e clica nele para abrir o popup ngb-datepicker. Se abrir, navega até
//     o mês/ano correto e clica no dia.
//  2. Se não encontrar botão de toggle, tenta clicar no próprio input.
//  3. Se o popup ngb-datepicker nunca aparece (componente customizado),
//     faz fallback: manipula o input diretamente via JavaScript,
//     disparando InputEvent + change + blur para Angular capturar.
// ============================================================================
async function navegarCalendarioEClicarDia(page, dataStr) {
  const target = parseDateUTC(dataStr);
  if (!target) {
    console.warn('[educadf.pap] navegarCalendarioEClicarDia: data inválida:', dataStr);
    return false;
  }

  const tDay   = target.getUTCDate();
  const tMonth = target.getUTCMonth(); // 0-based
  const tYear  = target.getUTCFullYear();
  const dataFormatada = formatarDataEducaDF(dataStr);
  console.log('[educadf.pap] calendario: navegando para ' + tDay + '/' + (tMonth + 1) + '/' + tYear + ' (formatada: "' + dataFormatada + '")');

  // ── PASSO 1: Diagnóstico — descobre quais elementos de data existem no modal ──
  const diagnostico = await page.evaluate(() => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return { error: 'modal-not-found' };

    const allInputs = [...modal.querySelectorAll('input')];
    const dateInp = allInputs.find(inp => /\\d{1,2}\\s+\\w{3}/.test(inp.value || ''));

    // Procura botões de toggle (ícone calendário) perto do date input
    let toggleBtn = null;
    let toggleInfo = 'nao-encontrado';
    if (dateInp) {
      // Procura no parent (div.input-group) por um botão com ícone de calendário
      const parent = dateInp.closest('.input-group') || dateInp.parentElement;
      if (parent) {
        const buttons = [...parent.querySelectorAll('button, .input-group-append button, .input-group-text')];
        toggleBtn = buttons.find(b => {
          const hasIcon = b.querySelector('i.fa-calendar, i.fa-calendar-alt, .bi-calendar, [class*="calendar"]');
          const isToggle = b.hasAttribute('ngbDatepickerToggle') || b.closest('[ngbDatepickerToggle]');
          return hasIcon || isToggle;
        });
        if (toggleBtn) toggleInfo = 'botao-toggle:' + toggleBtn.tagName + '.' + toggleBtn.className;
        else toggleInfo = 'sem-toggle. Filhos parent: ' + [...parent.children].map(c => c.tagName + '.' + (c.className || '')).join(' | ');
      }
    }

    // Verifica se já existe ngb-datepicker no document
    const dpExists = !!document.querySelector('ngb-datepicker');

    // Procura QUALQUER componente de data no modal
    const dateComponents = [...modal.querySelectorAll('*')].filter(el => {
      const tag = el.tagName.toLowerCase();
      return tag.includes('date') || tag.includes('calendar') || tag.includes('picker');
    }).map(el => el.tagName.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i);

    return {
      dateInputValue: dateInp?.value || 'not-found',
      dateInputType: dateInp?.type || 'unknown',
      dateInputSize: dateInp?.getAttribute('size') || 'null',
      toggleBtn: toggleInfo,
      dpAlreadyExists: dpExists,
      dateComponents: dateComponents.join(', ') || 'nenhum',
    };
  });
  console.log('[educadf.pap] calendario diagnostico:', JSON.stringify(diagnostico));

  // ── PASSO 2: Tenta abrir o popup do datepicker ───────────────────────────
  const popupAberto = await page.evaluate(() => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return 'modal-not-found';

    const allInputs = [...modal.querySelectorAll('input')];
    const dateInp = allInputs.find(inp => /\\d{1,2}\\s+\\w{3}/.test(inp.value || ''));
    if (!dateInp) return 'date-input-not-found';

    // Estratégia A: clicar no botão de toggle (ícone calendário)
    const parent = dateInp.closest('.input-group') || dateInp.parentElement;
    if (parent) {
      // Tenta encontrar o toggle via atributo Angular
      let toggle = parent.querySelector('[ngbDatepickerToggle] button, button[ngbDatepickerToggle]');
      // Tenta via ícone de calendário
      if (!toggle) {
        const allBtns = [...parent.querySelectorAll('button')];
        toggle = allBtns.find(b => {
          const icon = b.querySelector('i, span, svg');
          if (!icon) return false;
          const cls = (icon.className || '') + ' ' + (b.className || '');
          return cls.includes('calendar') || cls.includes('datepicker');
        });
      }
      // Tenta qualquer botão no input-group-append
      if (!toggle) {
        toggle = parent.querySelector('.input-group-append button, .input-group-text');
      }
      if (toggle) {
        toggle.scrollIntoView({ block: 'center' });
        toggle.click();
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 'toggle-clicado:' + toggle.tagName + '.' + toggle.className;
      }
    }

    // Estratégia B: clicar no próprio input (pode funcionar em alguns setups)
    dateInp.focus();
    dateInp.click();
    dateInp.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Estratégia C: simular Escape + re-focus (some datepickers toggle on focus)
    return 'input-clicado:' + dateInp.value;
  });
  console.log('[educadf.pap] calendario: tentativa abertura -> ' + popupAberto);
  await page.waitForTimeout(1000);

  // ── PASSO 3: Verifica se ngb-datepicker apareceu no document ─────────────
  let calPopupOk = false;
  for (let attempt = 0; attempt < 3 && !calPopupOk; attempt++) {
    calPopupOk = await page.evaluate(() => !!document.querySelector('ngb-datepicker'));
    if (!calPopupOk) {
      console.warn('[educadf.pap] calendario: popup nao apareceu (tentativa ' + (attempt+1) + '/3)');
      // Tenta novamente: click do Playwright com force no input ou button
      try {
        const toggle = page.locator('ngb-modal-window .input-group button, ngb-modal-window .input-group-append button').first();
        if (await toggle.count() > 0) {
          await toggle.click({ force: true, timeout: 2000 }).catch(() => {});
        }
      } catch {}
      await page.waitForTimeout(600);
    }
  }

  // ── Se o popup abriu, usa navegação por calendário (estratégia visual) ────
  if (calPopupOk) {
    console.log('[educadf.pap] calendario: popup ngb-datepicker encontrado! Navegando...');
    return await _navegarCalendarioPopup(page, tDay, tMonth, tYear);
  }

  // ── FALLBACK: Popup não existe — manipulação direta do input ──────────────
  // O campo de data é provavelmente um input com formatação custom.
  // Vamos limpar o input e preencher com o valor formatado, disparando os
  // eventos que Angular precisa para atualizar o FormControl.
  console.log('[educadf.pap] calendario: popup nao existe — usando manipulacao direta do input...');

  const inputOk = await page.evaluate((novaData) => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return 'modal-not-found';

    const allInputs = [...modal.querySelectorAll('input')];
    const dateInp = allInputs.find(inp => /\\d{1,2}\\s+\\w{3}/.test(inp.value || ''));
    if (!dateInp) return 'date-input-not-found';

    const valorAntigo = dateInp.value;

    // Foca o input
    dateInp.focus();
    dateInp.dispatchEvent(new Event('focus', { bubbles: true }));

    // Tenta usar Object.getOwnPropertyDescriptor para bypassing Angular's setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(dateInp, novaData);
    } else {
      dateInp.value = novaData;
    }

    // Dispara eventos que Angular precisa para capturar a mudança
    dateInp.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    dateInp.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    dateInp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
    dateInp.dispatchEvent(new Event('blur', { bubbles: true }));

    return 'valor-antigo:' + valorAntigo + ' -> novo:' + dateInp.value;
  }, dataFormatada);
  console.log('[educadf.pap] calendario manipulacao direta: ' + inputOk);

  // Agora tenta também via Playwright keyboard (backup)
  try {
    // Procura o input e faz triple-click + type
    const dateInputLocator = page.locator('ngb-modal-window input').first();
    const allInputs = page.locator('ngb-modal-window input');
    const inputCount = await allInputs.count();

    for (let i = 0; i < inputCount; i++) {
      const val = await allInputs.nth(i).inputValue().catch(() => '');
      if (/\\d{1,2}\\s+\\w{3}/.test(val)) {
        await allInputs.nth(i).click({ clickCount: 3, force: true });
        await page.waitForTimeout(200);
        await page.keyboard.type(dataFormatada, { delay: 60 });
        await page.waitForTimeout(300);
        await page.keyboard.press('Tab');
        await page.waitForTimeout(300);
        console.log('[educadf.pap] calendario: keyboard type tambem executado como backup');
        break;
      }
    }
  } catch (kbErr) {
    console.warn('[educadf.pap] calendario: keyboard backup falhou: ' + kbErr.message);
  }

  // Verifica se o valor mudou
  const valorFinal = await page.evaluate(() => {
    const modal = document.querySelector('ngb-modal-window');
    if (!modal) return 'modal-null';
    const allInputs = [...modal.querySelectorAll('input')];
    const dateInp = allInputs.find(inp => /\\d{1,2}\\s+\\w{3}/.test(inp.value || ''));
    return dateInp?.value || 'input-null';
  });
  console.log('[educadf.pap] calendario: valor final do input = "' + valorFinal + '"');

  const sucesso = valorFinal.includes(String(tDay));
  if (sucesso) {
    console.log('[educadf.pap] calendario OK: data atualizada para "' + valorFinal + '"');
  } else {
    console.warn('[educadf.pap] calendario WARN: data pode nao ter atualizado (esperado dia ' + tDay + ', got "' + valorFinal + '")');
  }
  return sucesso;
}

// ── Sub-helper: navega o popup ngb-datepicker e clica no dia ─────────────────
async function _navegarCalendarioPopup(page, tDay, tMonth, tYear) {
  for (let nav = 0; nav < 14; nav++) {
    const calInfo = await page.evaluate((mesesLong) => {
      const cal = document.querySelector('ngb-datepicker');
      if (!cal) return null;

      const selects = [...cal.querySelectorAll('select')];
      if (selects.length >= 2) {
        const mSel = selects.find(s => parseInt(s.value) >= 1 && parseInt(s.value) <= 12);
        const ySel = selects.find(s => parseInt(s.value) > 100);
        if (mSel && ySel) return { month: parseInt(mSel.value) - 1, year: parseInt(ySel.value), mode: 'selects' };
      }

      const header = cal.querySelector('.ngb-dp-month-name');
      if (header) {
        const txt = header.textContent.trim().toLowerCase();
        const parts = txt.split(/\\s+/);
        const m = mesesLong.indexOf(parts[0]);
        const y = parseInt(parts[parts.length - 1]);
        if (m >= 0 && !isNaN(y)) return { month: m, year: y, mode: 'header' };
      }
      return null;
    }, MESES_PT_LONG);

    if (!calInfo) { console.warn('[educadf.pap] calendario: popup sumiu'); break; }
    console.log('[educadf.pap] calendario: mes atual ' + (calInfo.month+1) + '/' + calInfo.year + ' (' + calInfo.mode + ')');

    if (calInfo.month === tMonth && calInfo.year === tYear) {
      const clicked = await page.evaluate((day, tY) => {
        const cal = document.querySelector('ngb-datepicker');
        if (!cal) return null;

        const btns = [...cal.querySelectorAll('.ngb-dp-day button:not([disabled])')];
        for (const btn of btns) {
          if (btn.textContent?.trim() === String(day)) {
            btn.scrollIntoView({ block: 'center' });
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'dia ' + day + ' clicado';
          }
        }
        const allBtns = [...cal.querySelectorAll('button')];
        for (const btn of allBtns) {
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes(String(day)) && label.includes(String(tY))) {
            btn.scrollIntoView({ block: 'center' });
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'dia ' + day + ' clicado via aria-label';
          }
        }
        const disp = btns.map(b => b.textContent?.trim()).filter(Boolean).join(',');
        return 'nao-encontrado:[' + disp + ']';
      }, tDay, tYear);

      if (clicked && clicked.startsWith('dia')) {
        console.log('[educadf.pap] calendario via popup OK: ' + clicked);
        await page.waitForTimeout(600);
        return true;
      }
      console.warn('[educadf.pap] calendario popup: ' + clicked);
      break;
    }

    // Navegar mês
    const diff = (tYear - calInfo.year) * 12 + (tMonth - calInfo.month);
    if (calInfo.mode === 'selects') {
      await page.evaluate((m, y) => {
        const cal = document.querySelector('ngb-datepicker');
        const selects = [...(cal?.querySelectorAll('select') || [])];
        const mSel = selects.find(s => parseInt(s.value) >= 1 && parseInt(s.value) <= 12);
        const ySel = selects.find(s => parseInt(s.value) > 100);
        if (mSel) { mSel.value = String(m + 1); mSel.dispatchEvent(new Event('change', { bubbles: true })); }
        if (ySel) { ySel.value = String(y);     ySel.dispatchEvent(new Event('change', { bubbles: true })); }
      }, tMonth, tYear);
    } else {
      const goNext = diff > 0;
      await page.evaluate((goNext) => {
        const cal = document.querySelector('ngb-datepicker');
        if (!cal) return;
        const btns = [...cal.querySelectorAll('button.ngb-dp-arrow-btn')];
        const btn = goNext ? btns[btns.length - 1] : btns[0];
        if (btn) btn.click();
      }, goNext);
    }
    await page.waitForTimeout(500);
  }
  console.warn('[educadf.pap] calendario popup: nao conseguiu clicar no dia ' + tDay + '/' + (tMonth+1) + '/' + tYear);
  return false;
}`;

// Substituir as linhas
lines.splice(startIdx, endIdx - startIdx + 1, ...newFunction.split('\n'));
fs.writeFileSync(f, lines.join('\n'), 'utf8');

const finalSrc = fs.readFileSync(f, 'utf8');
const hasNew = finalSrc.includes('ESTRATÉGIA TRIPLA');
const hasOld = finalSrc.includes('popup nao abriu (tentativa');
console.log('Tem nova função:', hasNew, '| Tem antiga:', hasOld);
console.log('Total linhas:', finalSrc.split('\n').length);
if (hasNew && !hasOld) {
  console.log('✅ PATCH V2 OK!');
} else if (hasNew) {
  console.log('⚠️ Nova função adicionada, mas ainda tem referências antigas');
} else {
  console.error('❌ PATCH FALHOU');
  process.exit(1);
}
