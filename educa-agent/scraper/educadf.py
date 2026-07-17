"""
scraper/educadf.py — Automação do site educadf.se.df.gov.br
Versão final baseada na exploração real do site.

Fluxo:
  1. Acessar /auth/login?id=1 (perfil Professor)
  2. Remover backdrop de cookies via JS
  3. Preencher matrícula + senha → clicar Acessar
  4. Navegar até Matrícula → Ficha do Estudante
  5. Preencher filtros fixos (Rede, CRE, Escola, Ano)
  6. Para a 1ª turma: selecionar → Filtrar → configurar colunas
     (desmarcar PENDÊNCIAS, SITUAÇÃO, AÇÕES) → re-Filtrar → PDF
  7. Para as demais: selecionar → Filtrar → PDF
"""

import asyncio
import sys
import io
import time
from pathlib import Path

# Fix Windows console encoding (only if not already UTF-8)
if hasattr(sys.stdout, 'buffer') and getattr(sys.stdout, 'encoding', '').lower() != 'utf-8':
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    except Exception:
        pass

from playwright.async_api import async_playwright, Page, Download

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import (
    EDUCADF_URL,
    EDUCADF_MATRICULA,
    EDUCADF_SENHA,
    FILTRO_REDE_ENSINO,
    FILTRO_REGIONAL,
    FILTRO_UNIDADE_ESCOLAR,
    FILTRO_ANO_LETIVO,
    COLUNAS_DESMARCAR,
    DOWNLOAD_DIR,
    educadf_to_educa,
)


# ═══════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════

async def remover_backdrops(page: Page):
    """Remove ngb-offcanvas-backdrop e quaisquer overlays bloqueantes."""
    await page.evaluate("""
        document.querySelectorAll('ngb-offcanvas-backdrop, .offcanvas-backdrop, .modal-backdrop').forEach(el => el.remove());
        document.body.classList.remove('modal-open', 'offcanvas-open');
        document.body.style.overflow = 'auto';
    """)


async def selecionar_ng_select(page: Page, placeholder: str, valor: str, timeout: int = 10000):
    """
    Seleciona uma opção num ng-select do educadf.
    
    Usa 3 estratégias em sequência:
      1. Digita o nome completo para filtrar (funciona na maioria dos casos)
      2. Digita apenas a parte única (ex: "- J") para filtrar
      3. Scroll manual pelo dropdown procurando o texto (fallback robusto)
    """
    print(f"  [FILTRO] {placeholder} = '{valor}'...")
    
    # Normaliza para comparação robusta (lida com º vs ° vs . etc)
    import unicodedata
    def norm(s):
        s = s.strip().upper()
        # Normaliza unicode (NFD → NFC)
        s = unicodedata.normalize('NFC', s)
        # Trata variações de ordinal: º, °, ., ª → padrão
        s = s.replace('°', 'º').replace('ª', 'º')
        # Remove espaços extras
        import re as _re2
        s = _re2.sub(r'\s+', ' ', s)
        return s
    target = norm(valor)
    
    ng = page.locator(f"ng-select[placeholder='{placeholder}']")

    # ── Estratégia 1: Busca pelo nome completo ──
    await ng.click()
    await page.wait_for_timeout(500)
    
    search_text = valor[:25]
    input_field = ng.locator("input[type='text']").first
    has_search = await input_field.count() > 0
    
    if has_search:
        await input_field.fill(search_text)
    else:
        await page.keyboard.type(search_text, delay=30)
    
    await page.wait_for_timeout(1500)
    
    # Verifica se alguma opção apareceu
    option = page.locator(".ng-dropdown-panel .ng-option").first
    if await option.count() > 0:
        # Verifica se o texto da opção contém o valor buscado
        opt_text = await option.text_content() or ""
        if norm(opt_text) == target or target in norm(opt_text):
            await option.click()
            print(f"  [FILTRO] OK: {placeholder} (estratégia 1 — busca completa)")
            await page.wait_for_timeout(800)
            return True
        
        # Tem opções mas não é a correta — pode ter retornado resultados genéricos
        # Procura entre todas as opções visíveis
        all_opts = page.locator(".ng-dropdown-panel .ng-option")
        count = await all_opts.count()
        for idx in range(count):
            t = await all_opts.nth(idx).text_content() or ""
            if norm(t) == target:
                await all_opts.nth(idx).click()
                print(f"  [FILTRO] OK: {placeholder} (estratégia 1 — match exato idx={idx})")
                await page.wait_for_timeout(800)
                return True
    
    # Fecha dropdown para tentar novamente
    await page.keyboard.press("Escape")
    await page.wait_for_timeout(300)
    
    # ── Estratégia 2: Busca pelo sufixo único (ex: "- J", "- K") ──
    import re as _re
    suffix_match = _re.search(r'- (\w+)$', valor)
    if suffix_match and has_search:
        suffix = suffix_match.group(0)  # "- J"
        print(f"  [FILTRO] Retry com sufixo '{suffix}'...")
        
        await ng.click()
        await page.wait_for_timeout(500)
        
        input_field2 = ng.locator("input[type='text']").first
        if await input_field2.count() > 0:
            await input_field2.fill(suffix)
        else:
            await page.keyboard.type(suffix, delay=30)
        
        await page.wait_for_timeout(1500)
        
        all_opts = page.locator(".ng-dropdown-panel .ng-option")
        count = await all_opts.count()
        for idx in range(count):
            t = await all_opts.nth(idx).text_content() or ""
            if norm(t) == target:
                await all_opts.nth(idx).click()
                print(f"  [FILTRO] OK: {placeholder} (estratégia 2 — sufixo)")
                await page.wait_for_timeout(800)
                return True
        
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(300)
    
    # ── Estratégia 3: Scroll manual por todas as opções (virtual scrolling) ──
    print(f"  [FILTRO] Scroll manual procurando '{valor}'...")
    
    # Limpa qualquer busca anterior
    await ng.click()
    await page.wait_for_timeout(500)
    
    if has_search:
        input_field3 = ng.locator("input[type='text']").first
        if await input_field3.count() > 0:
            await input_field3.fill("")  # limpa filtro para mostrar todas
            await page.wait_for_timeout(800)
    
    panel = page.locator(".ng-dropdown-panel-items")
    if await panel.count() == 0:
        print(f"  [FILTRO] FALHA: {placeholder} — painel não encontrado")
        await page.keyboard.press("Escape")
        return False
    
    # Scroll para o topo primeiro
    await panel.evaluate("el => el.scrollTop = 0")
    await page.wait_for_timeout(400)
    
    max_scrolls = 60
    seen = set()
    stale_count = 0
    
    for scroll_round in range(max_scrolls):
        all_opts = page.locator(".ng-dropdown-panel .ng-option")
        count = await all_opts.count()
        
        for idx in range(count):
            t = await all_opts.nth(idx).text_content() or ""
            t_norm = norm(t)
            seen.add(t_norm)
            
            if t_norm == target:
                await all_opts.nth(idx).click()
                print(f"  [FILTRO] OK: {placeholder} (estratégia 3 — scroll round {scroll_round})")
                await page.wait_for_timeout(800)
                return True
        
        # Scroll para baixo
        prev_size = len(seen)
        await panel.evaluate("el => el.scrollTop += 250")
        await page.wait_for_timeout(300)
        
        # Verifica se chegou ao final (sem novas opções)
        if len(seen) == prev_size:
            stale_count += 1
            if stale_count >= 4:
                break
        else:
            stale_count = 0
    
    print(f"  [FILTRO] FALHA: {placeholder} — '{valor}' não encontrado após {scroll_round + 1} scrolls ({len(seen)} opções vistas)")
    await page.keyboard.press("Escape")
    return False



# ═══════════════════════════════════════════════════
# FLUXO PRINCIPAL
# ═══════════════════════════════════════════════════

# Mapeamento de perfil → ID de login no EducaDF
# Professor=1, Estudante=2, Gestão=3, Servidor=4
PERFIL_LOGIN_ID = {
    "professor": 1,
    "secretario": 3,   # secretário loga como Gestão
    "diretor": 3,      # diretor/gestor loga como Gestão
    "vice_diretor": 3,
    "gestao": 3,
    "servidor": 4,
}


async def login(page: Page, matricula: str = None, senha: str = None, perfil: str = None) -> bool:
    """
    Login: acessa página do perfil correto, preenche matrícula+senha, clica Acessar.
    
    Args:
        page: Página Playwright ativa.
        matricula: Matrícula/CPF. Se None, usa EDUCADF_MATRICULA do .env.
        senha: Senha. Se None, usa EDUCADF_SENHA do .env.
        perfil: 'professor' | 'secretario' | 'diretor' | etc. Se None, padrão 'professor'.
    """
    # Fallback para config.py (.env)
    mat = matricula or EDUCADF_MATRICULA
    pwd = senha or EDUCADF_SENHA
    prf = (perfil or "professor").lower().strip()
    
    login_id = PERFIL_LOGIN_ID.get(prf, 1)
    perfil_label = prf.upper()
    
    print(f"[LOGIN] Acessando página de login {perfil_label} (id={login_id})...")
    await page.goto(f"{EDUCADF_URL}/auth/login?id={login_id}", wait_until="networkidle", timeout=30000)
    await page.wait_for_timeout(3000)
    
    # Remove backdrops/cookies que bloqueiam
    await remover_backdrops(page)
    
    # Tenta aceitar cookies visíveis
    try:
        aceitar = page.locator("button:has-text('Aceitar')").first
        if await aceitar.count() > 0 and await aceitar.is_visible():
            await aceitar.click(force=True)
            await page.wait_for_timeout(500)
    except:
        pass
    
    await remover_backdrops(page)
    
    # Preenche credenciais
    await page.locator("#username").fill(mat)
    await page.locator("#password-input").fill(pwd)
    print(f"[LOGIN] Credenciais preenchidas (mat: {mat}, perfil: {perfil_label})")
    
    # Clica Acessar
    try:
        await page.locator("button[type='submit']").click(timeout=5000)
    except:
        await page.locator("button[type='submit']").click(force=True)
    
    await page.wait_for_timeout(5000)
    await page.wait_for_load_state("networkidle", timeout=20000)
    
    url = page.url
    print(f"[LOGIN] URL pós-login: {url}")
    
    if "auth" in url and "home" not in url:
        print("[LOGIN] FALHA — ainda na página de login")
        await page.screenshot(path=str(DOWNLOAD_DIR / "debug_login_falha.png"))
        return False
    
    print("[LOGIN] OK — logado com sucesso")
    return True


async def navegar_ficha_estudante(page: Page) -> bool:
    """Navega pela sidebar: Matrícula → Ficha do Estudante."""
    print("[NAV] Navegando para Ficha do Estudante...")
    
    try:
        # Clica em Matrícula na sidebar (é um SPAN, não um link)
        await page.locator("span:text-is('Matrícula')").first.click()
        await page.wait_for_timeout(1500)
        
        # Clica em Ficha do Estudante (submenu)
        await page.locator("a:has-text('Ficha do Estudante')").first.click()
        await page.wait_for_timeout(3000)
        await page.wait_for_load_state("networkidle", timeout=15000)
        
        print(f"[NAV] URL: {page.url}")
        print("[NAV] OK — na tela de Ficha do Estudante")
        return True
        
    except Exception as e:
        print(f"[NAV] Sidebar falhou ({e}), tentando URL direta...")
        try:
            await page.goto(
                f"{EDUCADF_URL}/estudante/modulos/estudante/ficha-estudante",
                wait_until="networkidle",
                timeout=20000,
            )
            await page.wait_for_timeout(2000)
            print(f"[NAV] URL: {page.url}")
            return True
        except Exception as e2:
            print(f"[NAV] FALHA: {e2}")
            await page.screenshot(path=str(DOWNLOAD_DIR / "debug_nav_falha.png"))
            return False


async def aplicar_filtros_fixos(page: Page) -> bool:
    """Aplica filtros que não mudam entre turmas: Rede, CRE, Escola, Ano."""
    print("[FILTROS] Aplicando filtros fixos...")
    
    # Rede de Ensino
    await selecionar_ng_select(page, "Rede de Ensino", FILTRO_REDE_ENSINO)
    await page.wait_for_timeout(1500)  # cascata
    
    # Regional de Ensino
    await selecionar_ng_select(page, "Regional de Ensino", FILTRO_REGIONAL)
    await page.wait_for_timeout(1500)
    
    # Unidade Escolar
    await selecionar_ng_select(page, "Unidade Escolar", FILTRO_UNIDADE_ESCOLAR)
    await page.wait_for_timeout(1500)
    
    # Ano Letivo (input de texto)
    ano_input = page.locator("input[placeholder='Ano Letivo']").first
    await ano_input.fill(FILTRO_ANO_LETIVO)
    print(f"  [FILTRO] Ano Letivo = {FILTRO_ANO_LETIVO}")
    await page.wait_for_timeout(500)
    
    print("[FILTROS] OK — filtros fixos aplicados")
    return True


async def obter_turmas_disponiveis(page: Page) -> list[str]:
    """
    Abre o dropdown de Turmas e retorna TODAS as opções disponíveis.
    
    NOTA: o ng-select do Angular usa virtual scrolling — só renderiza
    os itens visíveis. Para capturar todos, fazemos scroll até o final
    do painel, coletando opções incrementalmente.
    """
    print("[TURMAS] Obtendo lista de turmas...")
    
    ng = page.locator("ng-select[placeholder='Turma']")
    await ng.click()
    await page.wait_for_timeout(1500)
    
    # Coleta turmas com scroll para lidar com virtual scrolling
    turmas_set = set()
    panel = page.locator(".ng-dropdown-panel-items")
    
    max_scrolls = 50  # Limite de segurança
    last_count = 0
    stale_rounds = 0
    
    for scroll_round in range(max_scrolls):
        # Lê opções visíveis no DOM
        options = page.locator(".ng-dropdown-panel .ng-option")
        count = await options.count()
        
        for i in range(count):
            text = (await options.nth(i).text_content() or "").strip()
            if text and text not in ("", "Selecione"):
                turmas_set.add(text)
        
        # Verifica se encontrou novas opções
        if len(turmas_set) == last_count:
            stale_rounds += 1
            if stale_rounds >= 3:
                break  # Nada novo em 3 scrolls → chegou ao final
        else:
            stale_rounds = 0
            last_count = len(turmas_set)
        
        # Scroll para baixo no painel do dropdown
        await panel.evaluate("el => el.scrollTop += 300")
        await page.wait_for_timeout(300)
    
    # Fecha dropdown
    await page.keyboard.press("Escape")
    await page.wait_for_timeout(300)
    
    turmas = sorted(turmas_set)
    print(f"[TURMAS] {len(turmas)} turmas encontradas (após {scroll_round + 1} scrolls):")
    for t in turmas:
        print(f"  - {t} -> {educadf_to_educa(t)}")
    
    return turmas


async def selecionar_turma(page: Page, turma_educadf: str) -> bool:
    """Seleciona uma turma específica no dropdown."""
    return await selecionar_ng_select(page, "Turma", turma_educadf)


async def clicar_filtrar(page: Page):
    """Clica em 'Filtrar' e aguarda resultados."""
    print("  [FILTRAR] Clicando...")
    await page.locator("button:has-text('Filtrar')").first.click()
    await page.wait_for_load_state("networkidle", timeout=30000)
    await page.wait_for_timeout(800)
    print("  [FILTRAR] OK — resultados carregados")


async def configurar_colunas(page: Page):
    """
    Abre o modal "Escolher Colunas" e desmarca PENDÊNCIAS, SITUAÇÃO, AÇÕES.
    Só precisa ser feito UMA VEZ por sessão — a config persiste entre turmas.
    
    Clica em button.btn-soft-dark (ícone mdi-format-columns), localiza os
    checkboxes pelo ID via getElementById + normalização Unicode (o site 
    grafa AÇÕES como 'AÇÔES'), e clica na <label for="ID"> via Playwright.
    """
    print("[COLUNAS] Configurando colunas (uma vez)...")
    
    try:
        # ── Passo 1+2: Abrir modal "Escolher Colunas" ──
        # O botão de colunas é btn-soft-dark com ícone mdi-format-columns (posição 0 da barra)
        col_btn = page.locator("button.btn-soft-dark").first
        
        if await col_btn.count() == 0:
            print("[COLUNAS] AVISO: botão btn-soft-dark não encontrado")
            await page.screenshot(path=str(DOWNLOAD_DIR / "debug_colunas_btn_nf.png"))
            return
        
        await col_btn.click()
        await page.wait_for_timeout(1500)
        
        # Verifica se apareceu o modal
        has_modal = await page.evaluate("""
            () => {
                const els = [...document.querySelectorAll('*')];
                for (const el of els) {
                    if (el.children.length === 0 && el.textContent.trim() === 'Escolher Colunas') return true;
                }
                // Fallback: verifica se há checkboxes com IDs de colunas
                return !!document.getElementById('RE') && !!document.getElementById('NOME');
            }
        """)
        
        if not has_modal:
            print("[COLUNAS] AVISO: modal não abriu após click em btn-soft-dark")
            await page.screenshot(path=str(DOWNLOAD_DIR / "debug_colunas_btn_nf.png"))
            return
        
        print("  [COLUNAS] ✅ Modal 'Escolher Colunas' aberto")
        await page.screenshot(path=str(DOWNLOAD_DIR / "debug_colunas_modal.png"))
        
        # ── Passo 3: Desmarcar checkboxes ──
        # DOM real do educadf (Bootstrap + Angular):
        #   <div class="form-check form-check-secondary">
        #     <input type="checkbox" id="PENDÊNCIAS" class="form-check-input ...">
        #     <label class="form-check-label" for="PENDÊNCIAS"> PENDÊNCIAS </label>
        #   </div>
        # 
        # NOTA: O site tem um TYPO — a coluna AÇÕES está grafada como "AÇÔES" 
        # (com Ô circunflexo em vez de Õ til). Precisamos lidar com isso.
        # 
        # Estratégia: busca checkboxes pelo ID, clica na <label for="ID"> 
        # associada via Playwright (o atributo "for" dispara o toggle).
        
        for col_name in COLUNAS_DESMARCAR:
            # Busca o checkbox pelo ID (exato ou aproximado)
            cb_info = await page.evaluate("""
                (colName) => {
                    // Tenta match exato pelo ID
                    let cb = document.getElementById(colName);
                    if (cb && cb.type === 'checkbox') {
                        return {id: cb.id, checked: cb.checked, found: true};
                    }
                    
                    // Tenta match normalizado (remove acentos e compara)
                    const normalize = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
                    const target = normalize(colName);
                    
                    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
                    for (const c of checkboxes) {
                        if (c.id && normalize(c.id) === target) {
                            return {id: c.id, checked: c.checked, found: true};
                        }
                    }
                    
                    // Fallback: busca pela label text
                    const labels = document.querySelectorAll('label.form-check-label');
                    for (const l of labels) {
                        if (normalize(l.textContent.trim()) === target) {
                            const forId = l.getAttribute('for');
                            if (forId) {
                                const c = document.getElementById(forId);
                                if (c && c.type === 'checkbox') {
                                    return {id: c.id, checked: c.checked, found: true};
                                }
                            }
                        }
                    }
                    
                    return {found: false};
                }
            """, col_name)
            
            if not cb_info.get('found'):
                print(f"  [COLUNAS] {col_name}: ✗ checkbox não encontrado")
                continue
            
            cb_id = cb_info['id']
            
            if not cb_info['checked']:
                print(f"  [COLUNAS] {col_name}: já desmarcado (id={cb_id})")
                continue
            
            # Clica na <label for="ID"> via Playwright
            # O atributo "for" faz com que o click na label toggle o checkbox
            label_locator = page.locator(f"label[for='{cb_id}']").first
            
            if await label_locator.count() > 0:
                await label_locator.click()
                await page.wait_for_timeout(500)
                
                # Verifica se desmarcou
                still_checked = await page.evaluate(
                    "(cbId) => { const cb = document.getElementById(cbId); return cb ? cb.checked : null; }",
                    cb_id
                )
                
                if still_checked is False:
                    print(f"  [COLUNAS] {col_name}: ✅ desmarcado (id={cb_id})")
                else:
                    print(f"  [COLUNAS] {col_name}: ❌ ainda marcado após click (id={cb_id})")
            else:
                print(f"  [COLUNAS] {col_name}: ✗ label[for='{cb_id}'] não encontrada")
        
        await page.wait_for_timeout(500)
        
        # Screenshot após desmarcar (antes de confirmar)
        await page.screenshot(path=str(DOWNLOAD_DIR / "debug_colunas_desmarcados.png"))
        
        # ── Passo 4: Confirmar clicando OK (do modal Escolher Colunas) ──
        ok_clicked = False
        
        ok_btn = page.locator("button:text-is('OK')").first
        if await ok_btn.count() > 0 and await ok_btn.is_visible():
            await ok_btn.click()
            ok_clicked = True
        
        if not ok_clicked:
            ok_btn2 = page.locator("button:has-text('OK')").first
            if await ok_btn2.count() > 0 and await ok_btn2.is_visible():
                await ok_btn2.click()
                ok_clicked = True
        
        if not ok_clicked:
            ok_clicked = await page.evaluate("""
                () => {
                    const btns = document.querySelectorAll('button');
                    for (const b of btns) {
                        const txt = b.textContent.trim();
                        if ((txt === 'OK' || txt === 'Ok') && b.offsetParent !== null) {
                            b.click();
                            return true;
                        }
                    }
                    return false;
                }
            """)
        
        if ok_clicked:
            await page.wait_for_timeout(1000)
            print("[COLUNAS] OK — colunas configuradas e confirmadas ✅")
        else:
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)
            print("[COLUNAS] AVISO — OK não encontrado, fechado com Escape")
        
        await page.screenshot(path=str(DOWNLOAD_DIR / "debug_colunas_resultado.png"))
        
    except Exception as e:
        print(f"[COLUNAS] ERRO: {e}")
        await page.screenshot(path=str(DOWNLOAD_DIR / "debug_colunas.png"))


async def baixar_pdf(page: Page, turma_educa: str, max_retries: int = 2) -> Path | None:
    """
    Clica no botão PDF (btn-soft-danger, vermelho) para baixar.
    Salva com o nome no padrão EDUCA.MELHOR (ex: "7º ANO A.pdf").
    Se o arquivo existente estiver bloqueado, usa nome temporário.
    Inclui retry automático em caso de falha.
    """
    dest = DOWNLOAD_DIR / f"{turma_educa}.pdf"
    print(f"  [PDF] Baixando -> {dest.name}...")
    
    # Se já existe, tenta remover antes (pode estar bloqueado)
    if dest.exists():
        try:
            dest.unlink()
        except PermissionError:
            # Arquivo bloqueado (aberto em leitor de PDF) — usa nome alternativo
            import datetime
            ts = datetime.datetime.now().strftime("%H%M%S")
            dest = DOWNLOAD_DIR / f"{turma_educa}_{ts}.pdf"
            print(f"  [PDF] Arquivo anterior bloqueado, salvando como {dest.name}")
    
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            # Botão PDF = btn-soft-danger (vermelho)
            pdf_btn = page.locator("button.btn-soft-danger.border-danger").first
            
            # Timeout crescente: 30s, 45s, 60s
            dl_timeout = 30000 + (attempt * 15000)
            
            async with page.expect_download(timeout=dl_timeout) as dl_info:
                await pdf_btn.click()
            
            download: Download = await dl_info.value
            await download.save_as(str(dest))
            
            size = dest.stat().st_size
            if size < 500:
                print(f"  [PDF] AVISO: arquivo muito pequeno ({size} bytes) — possível erro")
                last_error = f"Arquivo muito pequeno ({size} bytes)"
                if attempt < max_retries:
                    print(f"  [PDF] Tentativa {attempt+1}/{max_retries+1} falhou — retry...")
                    await page.wait_for_timeout(2000)
                    continue
                return None
            
            suffix = f" (tentativa {attempt+1})" if attempt > 0 else ""
            print(f"  [PDF] OK: {dest.name} ({size:,} bytes){suffix}")
            return dest
            
        except Exception as e:
            last_error = str(e)
            if attempt < max_retries:
                print(f"  [PDF] Tentativa {attempt+1}/{max_retries+1} falhou: {e} — retry em 3s...")
                await page.wait_for_timeout(3000)
            else:
                print(f"  [PDF] FALHA após {max_retries+1} tentativas: {last_error}")
                await page.screenshot(path=str(DOWNLOAD_DIR / f"debug_pdf_{turma_educa}.png"))
    
    return None


# ═══════════════════════════════════════════════════
# ORQUESTRADOR
# ═══════════════════════════════════════════════════

async def executar_scraping(
    turmas_filtro: list[str] | None = None,
    headless: bool = True,
    matricula: str = None,
    senha: str = None,
    perfil: str = None,
) -> list[dict]:
    """
    Executa o fluxo completo de scraping.
    
    Args:
        turmas_filtro: Lista de nomes (formato educadf) para processar. None = todas.
        headless: True=sem interface, False=visível (debug).
        matricula: Matrícula/CPF para login. None = usa .env.
        senha: Senha para login. None = usa .env.
        perfil: Perfil no EducaDF ('professor'|'secretario'|'diretor'). None = 'professor'.
    
    Returns:
        Lista de resultados por turma.
    """
    print("=" * 60)
    print("  AGENTE SINCRONIZADOR SEEDF — Inicio do scraping")
    print("=" * 60)
    
    inicio = time.time()
    results = []
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=headless,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            accept_downloads=True,
        )
        page = await context.new_page()
        
        try:
            # 1. Login (usa credenciais passadas ou fallback para .env)
            if not await login(page, matricula=matricula, senha=senha, perfil=perfil):
                return [{"status": "erro", "error": "Falha no login"}]
            
            # 2. Navegar até Ficha do Estudante
            if not await navegar_ficha_estudante(page):
                return [{"status": "erro", "error": "Falha na navegacao"}]
            
            # 3. Aplicar filtros fixos (Rede, CRE, Escola, Ano)
            await aplicar_filtros_fixos(page)
            
            # 4. Determinar turmas a processar
            if turmas_filtro:
                # ── MODO DIRETO: itera sobre as turmas do EDUCA.MELHOR ──
                turmas = turmas_filtro  # já vêm no formato educadf (ex: "7º Ano - J")
                print(f"\n[TURMAS] Modo direto: {len(turmas)} turmas recebidas do EDUCA.MELHOR")
                for t in turmas:
                    print(f"  → {t}")
            else:
                # ── MODO LEGADO: lista turmas do dropdown ──
                turmas = await obter_turmas_disponiveis(page)
                if not turmas:
                    print("FALHA: nenhuma turma encontrada")
                    await page.screenshot(path=str(DOWNLOAD_DIR / "debug_sem_turmas.png"))
                    return [{"status": "erro", "error": "Nenhuma turma encontrada"}]
            
            print(f"\n{'=' * 60}")
            print(f"  Processando {len(turmas)} turmas")
            print(f"{'=' * 60}\n")
            
            # Flag: colunas já foram configuradas (só precisa UMA VEZ)
            colunas_configuradas = False
            
            # 5. Loop: para cada turma → selecionar → filtrar → configurar colunas (1x) → PDF
            for i, turma_educadf in enumerate(turmas, start=1):
                # ── Verifica se foi solicitado shutdown (SIGTERM do timeout) ──
                try:
                    from agent import _shutdown_requested
                    if _shutdown_requested:
                        print(f"\n[SCRAPING] ⚠ Shutdown solicitado — interrompendo no turma {i}/{len(turmas)}")
                        break
                except ImportError:
                    pass

                turma_educa = educadf_to_educa(turma_educadf)
                print(f"\n--- Turma {i}/{len(turmas)}: {turma_educadf} ---")
                sys.stdout.flush()  # Garante que o backend captura esta linha
                
                try:
                    # Limpa dropdown antes de selecionar (exceto na primeira)
                    if i > 1:
                        ng_clear = page.locator("ng-select[placeholder='Turma'] .ng-clear-wrapper").first
                        if await ng_clear.count() > 0:
                            await ng_clear.click()
                            await page.wait_for_timeout(300)
                    
                    turma_ok = await selecionar_turma(page, turma_educadf)
                    
                    # ⛔ PROTEÇÃO: se a seleção da turma falhou, NÃO baixar PDF
                    # (evita salvar o PDF da turma anterior com o nome da turma atual)
                    if not turma_ok:
                        print(f"  [SKIP] Turma '{turma_educadf}' não encontrada no dropdown — pulando")
                        results.append({
                            "turma_educadf": turma_educadf,
                            "turma_educa": turma_educa,
                            "pdf_path": None,
                            "status": "turma_nao_encontrada",
                            "error": f"Turma '{turma_educadf}' nao encontrada no dropdown do educadf",
                        })
                        continue
                    
                    await clicar_filtrar(page)
                    
                    # ── Configurar colunas APÓS o primeiro Filtrar ──
                    if not colunas_configuradas:
                        await configurar_colunas(page)
                        colunas_configuradas = True
                        await clicar_filtrar(page)
                    
                    pdf = await baixar_pdf(page, turma_educa)
                    
                    results.append({
                        "turma_educadf": turma_educadf,
                        "turma_educa": turma_educa,
                        "pdf_path": str(pdf) if pdf else None,
                        "status": "pdf_baixado" if pdf else "falha_download",
                        "error": None if pdf else "PDF nao baixado",
                    })
                except Exception as e:
                    results.append({
                        "turma_educadf": turma_educadf,
                        "turma_educa": turma_educa,
                        "pdf_path": None,
                        "status": "erro",
                        "error": str(e),
                    })
                    print(f"  ERRO: {e}")
                
                # Pausa entre turmas (breve — já temos waits na seleção/filtro)
                await page.wait_for_timeout(300)
                sys.stdout.flush()  # Garante que o backend captura saída
        
        except Exception as e:
            print(f"ERRO GERAL: {e}")
            import traceback
            traceback.print_exc()
            await page.screenshot(path=str(DOWNLOAD_DIR / "debug_erro_geral.png"))
            results.append({"status": "erro", "error": str(e)})
        
        finally:
            await context.close()
            await browser.close()
    
    # Relatório
    duracao = time.time() - inicio
    ok = sum(1 for r in results if r.get("status") == "pdf_baixado")
    falha = len(results) - ok
    
    print(f"\n{'=' * 60}")
    print(f"  RELATORIO DO SCRAPING")
    print(f"  Duracao: {duracao:.1f}s | Total: {len(results)} | OK: {ok} | Falha: {falha}")
    print(f"{'=' * 60}")
    for r in results:
        icon = "[OK]" if r.get("status") == "pdf_baixado" else "[FALHA]"
        print(f"  {icon} {r.get('turma_educadf', '?')} -> {r.get('turma_educa', '?')}")
    print(f"{'=' * 60}\n")
    
    return results


# ═══════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Scraper educadf.se.df.gov.br")
    parser.add_argument("--turma", type=str, help="Turma especifica (formato educadf, ex: '7. Ano - A')")
    parser.add_argument("--visible", action="store_true", help="Mostra o navegador")
    args = parser.parse_args()
    
    turmas = [args.turma] if args.turma else None
    results = asyncio.run(executar_scraping(turmas_filtro=turmas, headless=not args.visible))
    
    ok = sum(1 for r in results if r.get("status") == "pdf_baixado")
    exit(0 if ok > 0 else 1)
