"""
config.py — Configuração centralizada do Agente Sincronizador SEEDF
Carrega variáveis de ambiente do .env e expõe constantes usadas pelos módulos.
"""

import os
import re
from pathlib import Path
from dotenv import load_dotenv

# Carrega .env do diretório do projeto
load_dotenv(Path(__file__).parent / ".env")

# ═══════════════════════════════════════════════════
# Credenciais educadf.se.df.gov.br
# ═══════════════════════════════════════════════════
EDUCADF_URL = "https://educadf.se.df.gov.br"
EDUCADF_MATRICULA = os.getenv("EDUCADF_MATRICULA", "")
EDUCADF_SENHA = os.getenv("EDUCADF_SENHA", "")

# ═══════════════════════════════════════════════════
# Filtros padrão para a tela Ficha do Estudante
# ═══════════════════════════════════════════════════
FILTRO_REDE_ENSINO = os.getenv("EDUCADF_REDE_ENSINO", "SECRETARIA DE EDUCAÇÃO DO DF")
FILTRO_REGIONAL = os.getenv("EDUCADF_REGIONAL", "CRE - PLANALTINA")
FILTRO_UNIDADE_ESCOLAR = os.getenv("EDUCADF_UNIDADE_ESCOLAR", "CENTRO DE ENSINO FUNDAMENTAL 04 DE PLANALTINA - COLÉGIO CÍVICO-MILITAR DO DISTRITO FEDERAL")
FILTRO_ANO_LETIVO = os.getenv("EDUCADF_ANO_LETIVO", "2026")

# ═══════════════════════════════════════════════════
# API EDUCA.MELHOR
# ═══════════════════════════════════════════════════
EDUCA_API_URL = os.getenv("EDUCA_API_URL", "https://sistemaeducamelhor.com.br/api")

# ═══════════════════════════════════════════════════
# Colunas a DESMARCAR no educadf (uma única vez)
# ═══════════════════════════════════════════════════
COLUNAS_DESMARCAR = ["PENDÊNCIAS", "SITUAÇÃO", "AÇÕES"]

# ═══════════════════════════════════════════════════
# Diretório temporário para PDFs baixados
# ═══════════════════════════════════════════════════
DOWNLOAD_DIR = Path(__file__).parent / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)


def educadf_to_educa(turma_educadf: str) -> str:
    """
    Converte nome de turma do formato educadf para o formato EDUCA.MELHOR.
    
    educadf:       "7º Ano - A"
    EDUCA.MELHOR:  "7º ANO A"
    
    Regras:
    1. Remove o hífen com espaços ao redor (" - " → " ")
    2. Converte para UPPERCASE
    3. Normaliza espaços extras
    """
    nome = turma_educadf.strip()
    nome = nome.replace(" - ", " ")           # "7º Ano - A" → "7º Ano A"
    nome = nome.upper()                       # "7º Ano A" → "7º ANO A"
    nome = re.sub(r"\s+", " ", nome).strip()  # normaliza espaços
    return nome


def educa_to_educadf(turma_educa: str) -> str:
    """
    Converte nome de turma do formato EDUCA.MELHOR para o formato educadf.
    
    EDUCA.MELHOR:  "7º ANO A"
    educadf:       "7º Ano - A"
    
    Regras:
    1. Title case no "ANO" → "Ano"
    2. Insere " - " antes da última letra (a turma)
    3. Mantém o ordinal (º/ª) inalterado
    """
    nome = turma_educa.strip()
    # Ex: "7º ANO A" → match groups: ("7º", "ANO", "A")
    m = re.match(r"^(\d+[ºª])\s+(\w+)\s+(.+)$", nome)
    if m:
        serie, tipo, letra = m.groups()
        return f"{serie} {tipo.title()} - {letra}"
    return nome  # fallback: retorna como está
