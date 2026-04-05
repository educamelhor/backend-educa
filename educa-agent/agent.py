"""
agent.py — Orquestrador principal do Agente Sincronizador SEEDF
Liga o scraper (educadf) com o importador (API EDUCA.MELHOR).

Fluxo:
  1. Scraper baixa PDFs do educadf.se.df.gov.br
  2. Importador envia cada PDF para POST /api/alunos/importar-pdf
  3. Registra resultado e gera relatório

Uso CLI:
  python agent.py --visible                    # todas as turmas, navegador visível
  python agent.py --turma "7º Ano - A"         # turma única
  python agent.py --token <JWT> --escola 1     # com auth para importar
"""

import asyncio
import sys
import io
import json
import time
from pathlib import Path
from datetime import datetime

if hasattr(sys.stdout, 'buffer') and getattr(sys.stdout, 'encoding', '').lower() != 'utf-8':
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    except:
        pass

sys.path.insert(0, str(Path(__file__).parent))
from scraper.educadf import executar_scraping
from sync.importador import importar_lote
from config import DOWNLOAD_DIR, EDUCA_API_URL, educa_to_educadf


async def buscar_turmas_educa(token: str, escola_id: int) -> list[dict]:
    """
    Consulta GET /api/turmas no EDUCA.MELHOR para obter as turmas cadastradas.
    Retorna lista de dicts com {id, turma (nome), turno, ...}.
    """
    import requests as req
    url = f"{EDUCA_API_URL}/turmas"
    headers = {
        "Authorization": f"Bearer {token}",
        "x-escola-id": str(escola_id),
    }
    
    try:
        print("[TURMAS-EDUCA] Consultando turmas cadastradas no EDUCA.MELHOR...")
        resp = req.get(url, headers=headers, timeout=15)
        
        if resp.status_code != 200:
            print(f"[TURMAS-EDUCA] ERRO HTTP {resp.status_code}: {resp.text[:200]}")
            return []
        
        turmas = resp.json()
        if isinstance(turmas, dict) and "turmas" in turmas:
            turmas = turmas["turmas"]
        
        print(f"[TURMAS-EDUCA] {len(turmas)} turmas cadastradas no EDUCA.MELHOR")
        return turmas
    except Exception as e:
        print(f"[TURMAS-EDUCA] ERRO ao consultar API: {e}")
        return []


async def verificar_turmas(
    token: str,
    escola_id: int,
    turmas_esperadas: list[str] | None = None,
    resultados_import: list[dict] | None = None,
    api_url: str | None = None,
) -> dict:
    """
    ETAPA 3 — Checklist de confiança do Agente.
    Consulta a API do EDUCA.MELHOR para verificar se cada turma
    tem alunos cadastrados após a importação.
    
    Returns:
        dict com turmas_ok, turmas_vazias, detalhes
    """
    import requests as req
    from config import educadf_to_educa
    
    base_url = api_url or EDUCA_API_URL
    headers = {
        "Authorization": f"Bearer {token}",
        "x-escola-id": str(escola_id),
    }

    # Primeiro, busca todas as turmas da escola
    try:
        resp = req.get(f"{base_url}/turmas", headers=headers, timeout=15)
        if resp.status_code != 200:
            print(f"[VERIFICAÇÃO] ERRO ao buscar turmas: HTTP {resp.status_code}")
            return {"status": "erro", "error": f"HTTP {resp.status_code}"}
        
        turmas_api = resp.json()
        if isinstance(turmas_api, dict) and "turmas" in turmas_api:
            turmas_api = turmas_api["turmas"]
    except Exception as e:
        print(f"[VERIFICAÇÃO] ERRO ao consultar turmas: {e}")
        return {"status": "erro", "error": str(e)}

    # Filtra turmas relevantes (as que foram sincronizadas)
    if turmas_esperadas:
        nomes_esperados = set()
        for t in turmas_esperadas:
            nomes_esperados.add(educadf_to_educa(t))
        turmas_verificar = [t for t in turmas_api if t.get("nome", "") in nomes_esperados]
    else:
        turmas_verificar = turmas_api

    turmas_ok = []
    turmas_vazias = []
    turmas_erro = []
    detalhes = []

    print(f"\n[VERIFICAÇÃO] Verificando {len(turmas_verificar)} turmas...\n")
    
    for i, turma in enumerate(turmas_verificar, 1):
        nome = turma.get("nome", turma.get("turma", "?"))
        turma_id = turma.get("id")
        
        try:
            # Consulta alunos da turma
            params = {
                "turma": nome,
                "ano_letivo": str(datetime.now().year),
                "limit": 1,
                "offset": 0,
            }
            resp = req.get(f"{base_url}/alunos", headers=headers, params=params, timeout=15)
            
            if resp.status_code == 200:
                body = resp.json()
                total = body.get("total", len(body.get("alunos", [])))
                
                detalhe = {
                    "turma": nome,
                    "turma_id": turma_id,
                    "total_alunos": total,
                    "status": "ok" if total > 0 else "vazia",
                }
                detalhes.append(detalhe)
                
                if total > 0:
                    turmas_ok.append(nome)
                    print(f"  [{i}/{len(turmas_verificar)}] ✅ {nome}: {total} aluno(s)")
                else:
                    turmas_vazias.append(nome)
                    print(f"  [{i}/{len(turmas_verificar)}] ❌ {nome}: NENHUM ALUNO!")
            else:
                turmas_erro.append(nome)
                print(f"  [{i}/{len(turmas_verificar)}] ⚠ {nome}: HTTP {resp.status_code}")
                detalhes.append({
                    "turma": nome,
                    "turma_id": turma_id,
                    "status": "erro",
                    "error": f"HTTP {resp.status_code}",
                })
        except Exception as e:
            turmas_erro.append(nome)
            print(f"  [{i}/{len(turmas_verificar)}] ⚠ {nome}: {e}")
            detalhes.append({
                "turma": nome,
                "turma_id": turma_id,
                "status": "erro",
                "error": str(e),
            })

    print(f"\n{'─' * 60}")
    print(f"  CHECKLIST: {len(turmas_ok)}/{len(turmas_verificar)} turmas OK")
    if turmas_vazias:
        print(f"  ❌ {len(turmas_vazias)} turma(s) SEM alunos: {', '.join(turmas_vazias)}")
    if turmas_erro:
        print(f"  ⚠ {len(turmas_erro)} turma(s) com erro de verificação")
    print(f"{'─' * 60}\n")
    
    return {
        "status": "ok" if not turmas_vazias and not turmas_erro else "com_problemas",
        "turmas_total": len(turmas_verificar),
        "turmas_ok": len(turmas_ok),
        "turmas_vazias": turmas_vazias,
        "turmas_erro": turmas_erro,
        "detalhes": detalhes,
    }


async def sincronizar(
    turmas_filtro: list[str] | None = None,
    headless: bool = True,
    token: str | None = None,
    escola_id: int | None = None,
    apenas_scraping: bool = False,
    api_url: str | None = None,
) -> dict:
    """
    Executa o fluxo completo de sincronização:
      1. Consulta turmas cadastradas no EDUCA.MELHOR
      2. Scraper baixa PDFs do educadf (somente turmas cadastradas)
      3. Importador envia para o EDUCA.MELHOR (se token fornecido)
      4. Gera relatório consolidado
    
    Args:
        turmas_filtro: Turmas (formato educadf) para processar. None = busca da API.
        headless: Navegador invisível (True) ou visível (False).
        token: JWT do EDUCA.MELHOR. Se None, só faz scraping.
        escola_id: ID da escola. Obrigatório se token fornecido.
        apenas_scraping: Se True, só baixa os PDFs sem importar.
    
    Returns:
        Relatório consolidado com resultados.
    """
    inicio = time.time()
    data_execucao = datetime.now().isoformat()
    
    relatorio = {
        "data_execucao": data_execucao,
        "status": "em_andamento",
        "etapa_scraping": None,
        "etapa_importacao": None,
        "resumo": {},
        "duracao_total_s": 0,
    }

    # ═══════════════════════════════════════════════════
    # ETAPA 0: BUSCAR TURMAS DO EDUCA.MELHOR (se não foram especificadas)
    # ═══════════════════════════════════════════════════
    if not turmas_filtro and token and escola_id:
        turmas_educa = await buscar_turmas_educa(token, escola_id)
        if turmas_educa:
            turmas_filtro = []
            print(f"\n[TURMAS] Convertendo {len(turmas_educa)} turmas EDUCA → educadf:")
            for t in turmas_educa:
                nome_educa = t.get("turma") or t.get("nome") or ""
                if not nome_educa:
                    continue
                nome_educadf = educa_to_educadf(nome_educa)
                turmas_filtro.append(nome_educadf)
                print(f"  {nome_educa} → {nome_educadf}")
            print(f"[TURMAS] {len(turmas_filtro)} turmas serão sincronizadas\n")
        else:
            print("[TURMAS] AVISO: Não foi possível obter turmas da API. Sincronizando TODAS.")

    # ═══════════════════════════════════════════════════
    # ETAPA 1: SCRAPING
    # ═══════════════════════════════════════════════════
    print("\n" + "=" * 70)
    print("  ETAPA 1/2 — SCRAPING (educadf.se.df.gov.br)")
    print("=" * 70)

    resultados_scraping = await executar_scraping(
        turmas_filtro=turmas_filtro,
        headless=headless,
    )

    pdfs_ok = sum(1 for r in resultados_scraping if r.get("status") == "pdf_baixado")
    pdfs_falha = len(resultados_scraping) - pdfs_ok

    relatorio["etapa_scraping"] = {
        "total_turmas": len(resultados_scraping),
        "pdfs_baixados": pdfs_ok,
        "pdfs_falha": pdfs_falha,
        "detalhes": resultados_scraping,
    }

    if pdfs_ok == 0:
        relatorio["status"] = "falha_scraping"
        relatorio["duracao_total_s"] = round(time.time() - inicio, 1)
        print("\n[AGENTE] Nenhum PDF baixado. Abortando importacao.")
        return relatorio

    # ═══════════════════════════════════════════════════
    # ETAPA 2: IMPORTAÇÃO
    # ═══════════════════════════════════════════════════
    if apenas_scraping or not token or not escola_id:
        if not token:
            print("\n[AGENTE] Token nao fornecido — apenas scraping (sem importacao)")
        elif not escola_id:
            print("\n[AGENTE] escola_id nao fornecido — apenas scraping (sem importacao)")
        else:
            print("\n[AGENTE] Modo apenas_scraping ativado")

        relatorio["etapa_importacao"] = {
            "status": "nao_executada",
            "motivo": "Token/escola nao fornecidos" if not token else "Modo apenas scraping",
        }
        relatorio["status"] = "scraping_concluido"
    else:
        print("\n" + "=" * 70)
        print("  ETAPA 2/2 — IMPORTACAO (EDUCA.MELHOR)")
        print("=" * 70)

        # Filtra apenas os que tiveram PDF baixado
        pdfs_para_importar = [r for r in resultados_scraping if r.get("status") == "pdf_baixado"]

        resultados_import = importar_lote(pdfs_para_importar, token, escola_id, api_url=api_url)

        import_ok = sum(1 for r in resultados_import if r.get("status") == "sucesso")
        import_erro = sum(1 for r in resultados_import if r.get("status") == "erro")
        import_skip = sum(1 for r in resultados_import if r.get("status") == "skip")

        total_inseridos = sum(r.get("inseridos", 0) for r in resultados_import)
        total_reativados = sum(r.get("reativados", 0) for r in resultados_import)
        total_inativados = sum(r.get("inativados", 0) for r in resultados_import)

        relatorio["etapa_importacao"] = {
            "total_turmas": len(resultados_import),
            "sucesso": import_ok,
            "erro": import_erro,
            "skip": import_skip,
            "total_inseridos": total_inseridos,
            "total_reativados": total_reativados,
            "total_inativados": total_inativados,
            "detalhes": resultados_import,
        }

        if import_erro == 0:
            relatorio["status"] = "sucesso"
        elif import_ok > 0:
            relatorio["status"] = "parcial"
        else:
            relatorio["status"] = "falha_importacao"

    # ═══════════════════════════════════════════════════
    # RESUMO PRÉ-VERIFICAÇÃO
    # ═══════════════════════════════════════════════════
    duracao = round(time.time() - inicio, 1)
    relatorio["duracao_total_s"] = duracao

    relatorio["resumo"] = {
        "pdfs_baixados": pdfs_ok,
        "pdfs_falha": pdfs_falha,
        "importados": relatorio.get("etapa_importacao", {}).get("sucesso", 0),
        "erros_importacao": relatorio.get("etapa_importacao", {}).get("erro", 0),
        "alunos_inseridos": relatorio.get("etapa_importacao", {}).get("total_inseridos", 0),
        "alunos_reativados": relatorio.get("etapa_importacao", {}).get("total_reativados", 0),
        "alunos_inativados": relatorio.get("etapa_importacao", {}).get("total_inativados", 0),
        "duracao_s": duracao,
    }

    # ═══════════════════════════════════════════════════
    # ETAPA 3: VERIFICAÇÃO — CHECKLIST DO AGENTE
    # Consulta a API para confirmar que TODAS as turmas
    # têm alunos cadastrados. Isso garante confiança.
    # ═══════════════════════════════════════════════════
    if token and escola_id and not apenas_scraping:
        print("\n" + "=" * 70)
        print("  ETAPA 3/3 — VERIFICAÇÃO (CHECKLIST DO AGENTE)")
        print("=" * 70)

        verificacao = await verificar_turmas(
            token=token,
            escola_id=escola_id,
            turmas_esperadas=turmas_filtro,
            resultados_import=relatorio.get("etapa_importacao", {}).get("detalhes", []),
            api_url=api_url,
        )
        relatorio["etapa_verificacao"] = verificacao

        # Atualiza status se verificação falhou
        if verificacao.get("turmas_vazias", []):
            if relatorio["status"] == "sucesso":
                relatorio["status"] = "parcial"
            # Adiciona resumo de verificação
            relatorio["resumo"]["turmas_vazias"] = len(verificacao["turmas_vazias"])
            relatorio["resumo"]["turmas_ok"] = verificacao.get("turmas_ok", 0)
            relatorio["resumo"]["turmas_total"] = verificacao.get("turmas_total", 0)
        else:
            relatorio["resumo"]["turmas_vazias"] = 0
            relatorio["resumo"]["turmas_ok"] = verificacao.get("turmas_ok", 0)
            relatorio["resumo"]["turmas_total"] = verificacao.get("turmas_total", 0)

    # ═══════════════════════════════════════════════════
    # RELATORIO FINAL
    # ═══════════════════════════════════════════════════
    duracao = round(time.time() - inicio, 1)
    relatorio["duracao_total_s"] = duracao
    relatorio["resumo"]["duracao_s"] = duracao

    print("\n" + "=" * 70)
    print("  RELATORIO FINAL — AGENTE SINCRONIZADOR SEEDF")
    print("=" * 70)
    print(f"  Data: {data_execucao}")
    print(f"  Status: {relatorio['status'].upper()}")
    print(f"  Duracao: {duracao}s")
    print(f"  PDFs baixados: {pdfs_ok}/{pdfs_ok + pdfs_falha}")
    if relatorio.get("etapa_importacao", {}).get("total_turmas"):
        imp = relatorio["etapa_importacao"]
        print(f"  Importados: {imp['sucesso']}/{imp['total_turmas']}")
        print(f"  Alunos: +{imp.get('total_inseridos',0)} inseridos, "
              f"+{imp.get('total_reativados',0)} reativados, "
              f"-{imp.get('total_inativados',0)} inativados")
    if relatorio.get("etapa_verificacao"):
        verif = relatorio["etapa_verificacao"]
        turmas_vazias = verif.get("turmas_vazias", [])
        if turmas_vazias:
            print(f"  ⚠ VERIFICAÇÃO: {len(turmas_vazias)} turma(s) SEM ALUNOS:")
            for tv in turmas_vazias:
                print(f"    → {tv}")
        else:
            print(f"  ✅ VERIFICAÇÃO: Todas as {verif.get('turmas_ok', 0)} turmas têm alunos")
    print("=" * 70 + "\n")

    # Salva relatório em JSON
    relatorio_path = DOWNLOAD_DIR / f"relatorio_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(relatorio_path, "w", encoding="utf-8") as f:
        json.dump(relatorio, f, ensure_ascii=False, indent=2)
    print(f"[AGENTE] Relatorio salvo: {relatorio_path}")

    return relatorio


# ═══════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Agente Sincronizador SEEDF — Scraping + Importacao"
    )
    parser.add_argument("--turma", type=str, help="Turma especifica (formato educadf)")
    parser.add_argument("--turmas-file", type=str, help="Arquivo JSON com turmas (formato EDUCA.MELHOR)")
    parser.add_argument("--visible", action="store_true", help="Mostra navegador")
    parser.add_argument("--token", type=str, help="JWT token do EDUCA.MELHOR")
    parser.add_argument("--token-file", type=str, help="Arquivo com JWT token (evita problemas de shell escaping)")
    parser.add_argument("--escola", type=int, help="ID da escola no EDUCA.MELHOR")
    parser.add_argument("--apenas-scraping", action="store_true", help="So baixa PDFs, sem importar")
    parser.add_argument("--api-url", type=str, help="URL base da API EDUCA.MELHOR (override do .env)")
    args = parser.parse_args()

    # Monta lista de turmas (formato educadf)
    turmas = None
    if args.turma:
        turmas = [args.turma]
    elif args.turmas_file:
        try:
            turmas_file = Path(args.turmas_file)
            turmas_educa = json.loads(turmas_file.read_text(encoding='utf-8'))
            turmas = [educa_to_educadf(t) for t in turmas_educa if t]
            print(f"[CLI] {len(turmas)} turmas carregadas de {turmas_file.name}:")
            for t_educa, t_educadf in zip(turmas_educa, turmas):
                print(f"  {t_educa} → {t_educadf}")
            # Limpa arquivo temporário
            try:
                turmas_file.unlink()
            except:
                pass
        except Exception as e:
            print(f"[CLI] ERRO ao ler --turmas-file: {e}")
            turmas = None

    # Token: prioriza --token-file sobre --token
    token = args.token
    if args.token_file:
        try:
            token_path = Path(args.token_file)
            token = token_path.read_text(encoding='utf-8').strip()
            print(f"[CLI] Token carregado de arquivo ({len(token)} chars)")
            # Limpa arquivo temporário
            try:
                token_path.unlink()
            except:
                pass
        except Exception as e:
            print(f"[CLI] ERRO ao ler --token-file: {e}")
            token = args.token

    if not token:
        print("[CLI] ⚠ AVISO: Nenhum token fornecido — importação será PULADA.")

    relatorio = asyncio.run(sincronizar(
        turmas_filtro=turmas,
        headless=not args.visible,
        token=token,
        escola_id=args.escola,
        apenas_scraping=args.apenas_scraping,
        api_url=args.api_url,
    ))

    # Exit code baseado no status
    if relatorio["status"] in ("sucesso", "scraping_concluido"):
        exit(0)
    elif relatorio["status"] == "parcial":
        exit(0)
    else:
        exit(1)
