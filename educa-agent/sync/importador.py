"""
sync/importador.py — Envia PDFs baixados para a API do EDUCA.MELHOR
Chama POST /api/alunos/importar-pdf com cada PDF, usando token JWT.
"""

import sys
import io
import requests
from pathlib import Path

if hasattr(sys.stdout, 'buffer') and getattr(sys.stdout, 'encoding', '').lower() != 'utf-8':
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    except:
        pass

sys.path.insert(0, str(Path(__file__).parent.parent))
from config import EDUCA_API_URL


def importar_pdf(pdf_path: str, turma_nome: str, token: str, escola_id: int, api_url: str | None = None) -> dict:
    """
    Envia um PDF para POST /api/alunos/importar-pdf.
    
    Args:
        pdf_path: Caminho absoluto do PDF baixado
        turma_nome: Nome da turma no formato EDUCA.MELHOR (ex: "7º ANO A")
        token: JWT token de autenticação
        escola_id: ID da escola no EDUCA.MELHOR
        api_url: URL base da API (override do config.py)
    
    Returns:
        dict com resultado da importação
    """
    base_url = api_url or EDUCA_API_URL
    url = f"{base_url}/alunos/importar-pdf"
    
    result = {
        "turma": turma_nome,
        "status": "pendente",
        "localizados": 0,
        "inseridos": 0,
        "reativados": 0,
        "jaExistiam": 0,
        "inativados": 0,
        "error": None,
    }
    
    p = Path(pdf_path)
    if not p.exists():
        result["status"] = "erro"
        result["error"] = f"Arquivo nao encontrado: {pdf_path}"
        return result
    
    try:
        print(f"  [IMPORT] POST {url} ({turma_nome})...")
        
        headers = {
            "Authorization": f"Bearer {token}",
            "x-escola-id": str(escola_id),
        }
        
        # O arquivo precisa ter nome no formato turma.pdf para o backend
        # identificar a turma pelo originalname se turmaNome não for enviado
        files = {
            "file": (f"{turma_nome}.pdf", open(pdf_path, "rb"), "application/pdf")
        }
        
        data = {
            "turmaNome": turma_nome,
        }
        
        resp = requests.post(url, headers=headers, files=files, data=data, timeout=60)
        
        if resp.status_code == 200:
            body = resp.json()
            result["status"] = "sucesso"
            result["localizados"] = body.get("localizados", 0)
            result["inseridos"] = body.get("inseridos", 0)
            result["reativados"] = body.get("reativados", 0)
            result["jaExistiam"] = body.get("jaExistiam", 0)
            result["inativados"] = body.get("inativados", 0)
            
            # Alunos ausentes no PDF (possíveis transferências)
            pendentes = body.get("pendentesInativacao", [])
            result["pendentesInativacao"] = len(pendentes)
            
            print(f"  [IMPORT] OK: loc={result['localizados']} ins={result['inseridos']} "
                  f"reat={result['reativados']} exist={result['jaExistiam']}")
            if pendentes:
                print(f"  [IMPORT] ⚠ {len(pendentes)} aluno(s) ausente(s) no PDF (pendentes inativação manual)")
        elif resp.status_code == 404:
            body = resp.json()
            result["status"] = "erro"
            result["error"] = body.get("message", f"Turma '{turma_nome}' nao encontrada no EDUCA.MELHOR")
            print(f"  [IMPORT] TURMA NAO ENCONTRADA: {result['error']}")
        else:
            result["status"] = "erro"
            try:
                body = resp.json()
                result["error"] = body.get("message", f"HTTP {resp.status_code}")
            except:
                result["error"] = f"HTTP {resp.status_code}: {resp.text[:200]}"
            print(f"  [IMPORT] ERRO: {result['error']}")
    
    except requests.exceptions.Timeout:
        result["status"] = "erro"
        result["error"] = "Timeout na chamada (60s)"
        print(f"  [IMPORT] TIMEOUT")
    
    except requests.exceptions.ConnectionError as e:
        result["status"] = "erro"
        result["error"] = f"Conexao recusada: {e}"
        print(f"  [IMPORT] CONEXAO RECUSADA")
    
    except Exception as e:
        result["status"] = "erro"
        result["error"] = str(e)
        print(f"  [IMPORT] ERRO: {e}")
    
    return result


def importar_lote(resultados_scraping: list[dict], token: str, escola_id: int, api_url: str | None = None) -> list[dict]:
    """
    Importa um lote de PDFs para o EDUCA.MELHOR.
    
    Args:
        resultados_scraping: Lista de dicts retornados pelo scraper
        token: JWT de autenticação
        escola_id: ID da escola
    
    Returns:
        Lista de dicts com resultados de importação
    """
    print(f"\n{'=' * 60}")
    print(f"  IMPORTANDO {len(resultados_scraping)} PDFs para EDUCA.MELHOR")
    print(f"{'=' * 60}\n")
    
    resultados_import = []
    
    for i, r in enumerate(resultados_scraping, start=1):
        turma = r.get("turma_educa", "?")
        pdf_path = r.get("pdf_path")
        
        if r.get("status") != "pdf_baixado" or not pdf_path:
            print(f"[{i}/{len(resultados_scraping)}] {turma} -> SKIP (sem PDF)")
            resultados_import.append({
                "turma": turma,
                "status": "skip",
                "error": "PDF nao disponivel",
            })
            continue
        
        print(f"[{i}/{len(resultados_scraping)}] {turma}...")
        res = importar_pdf(pdf_path, turma, token, escola_id, api_url=api_url)
        resultados_import.append(res)
    
    # Resumo
    ok = sum(1 for r in resultados_import if r["status"] == "sucesso")
    erros = sum(1 for r in resultados_import if r["status"] == "erro")
    skip = sum(1 for r in resultados_import if r["status"] == "skip")
    
    total_ins = sum(r.get("inseridos", 0) for r in resultados_import)
    total_reat = sum(r.get("reativados", 0) for r in resultados_import)
    total_inat = sum(r.get("inativados", 0) for r in resultados_import)
    
    print(f"\n{'=' * 60}")
    print(f"  RELATORIO DE IMPORTACAO")
    print(f"  Turmas: {len(resultados_import)} (OK: {ok} | Erro: {erros} | Skip: {skip})")
    print(f"  Alunos: inseridos={total_ins} reativados={total_reat} inativados={total_inat}")
    print(f"{'=' * 60}\n")
    
    return resultados_import
