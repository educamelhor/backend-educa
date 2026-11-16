# ================================================================
# EDUCA.MELHOR — Backend + Agente SEEDF (Python + Playwright)
# ================================================================
# Base: Debian slim (necessário para Playwright/Chromium)
FROM node:20-slim

# Instalar Python 3 + dependências do Playwright/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    # Dependências do Chromium e do driver Node embutido do Playwright (libatomic1)
    libatomic1 \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libxshmfence1 libx11-xcb1 \
    # Fontes (necessário para renderizar PDFs corretamente)
    fonts-liberation fonts-noto-core \
    # Dependências do Tectonic (compilador LaTeX)
    fontconfig libssl3 curl wget \
    && rm -rf /var/lib/apt/lists/*

# Instala Tectonic — compilador LaTeX moderno (binário único ~25MB)
RUN wget -qO /tmp/tectonic.tar.gz \
    https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz \
    && tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/tectonic \
    && rm /tmp/tectonic.tar.gz

# Diretórios para jobs e pré-aquecimento do cache LaTeX/Tectonic (zero download de pacotes em runtime)
RUN mkdir -p /tmp/latex-jobs /tmp/tectonic-cache \
    && node -e 'require("fs").writeFileSync("/tmp/warmup.tex", ["\\documentclass{article}","\\usepackage{fontspec}","\\IfFontExistsTF{Liberation Serif}{\\setmainfont{Liberation Serif}}{}","\\usepackage[a4paper,lmargin=1.45cm,rmargin=1.45cm,tmargin=1.35cm,bmargin=1.90cm,headheight=15pt]{geometry}","\\usepackage{multicol,array,tikz,fancyhdr,xcolor,graphicx,amsmath,amssymb,mathtools}","\\usepackage[shortlabels]{enumitem}","\\usetikzlibrary{calc}","\\definecolor{corDestaque}{HTML}{FF7F00}","\\pagestyle{fancy}\\fancyhf{}","\\fancyhead[L]{\\begin{tikzpicture}[overlay, remember picture]\\draw[draw=black, line width=2.25pt] ($(current page.north west) + (0.95cm,-0.85cm)$) rectangle ($(current page.south east) + (-0.95cm,1.40cm)$);\\node[anchor=center] at ($(current page.south) + (0cm,0.68cm)$) {PROVAO - 9o ANO};\\end{tikzpicture}}","\\renewcommand{\\headrulewidth}{0pt}\\renewcommand{\\footrulewidth}{0pt}","\\begin{document}","\\begin{multicols*}{2}","\\leavevmode{\\bfseries QUESTAO 01}\\hspace{0.22cm}{\\color{corDestaque}\\leaders\\hrule height 8.6pt depth 2.0pt\\hfill\\kern0pt}\\par\\vspace{2pt}","Teste LaTeX $\\lambda = \\frac{v}{f}$.","\\begin{enumerate}[label=\\alph*),leftmargin=*]\\item Opcao A\\item Opcao B\\end{enumerate}","\\end{multicols*}","\\end{document}"].join("\n"), "utf8")' \
    && (TECTONIC_CACHE_DIR=/tmp/tectonic-cache /usr/local/bin/tectonic /tmp/warmup.tex || echo "[WARN] Tectonic warmup adiado para runtime") \
    && rm -f /tmp/warmup.* \
    && chmod -R 777 /tmp/latex-jobs /tmp/tectonic-cache

# Diretório da aplicação Node.js
WORKDIR /app

# ── Node.js & Playwright (camadas cacheadas antes do código) ──
# Copia apenas manifests primeiro (cache eficiente)
COPY package*.json ./

# Instala dependências (sem npm ci, sem workspaces)
RUN npm install

# Instala Chromium do Playwright para o Node.js (cacheado enquanto package.json não mudar)
RUN npx playwright install chromium

# ── Python (Agente SEEDF — cacheado antes do código) ─────────
# Instala dependências Python do agente
RUN pip3 install --break-system-packages \
    playwright>=1.40.0 \
    requests>=2.31.0 \
    python-dotenv>=1.0.0

# Instala o browser Chromium para Playwright Python
RUN python3 -m playwright install chromium

# Copia o restante do código da aplicação (camada rápida)
COPY . .

# Cria diretório de downloads do agente
RUN mkdir -p /app/educa-agent/downloads

# Porta interna usada pelo app
EXPOSE 3000

# Comando de execução
CMD ["npm", "run", "start"]
