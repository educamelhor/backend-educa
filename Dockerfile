# ================================================================
# EDUCA.MELHOR — Backend + Agente SEEDF (Python + Playwright)
# ================================================================
# Base: Debian slim (necessário para Playwright/Chromium)
FROM node:20-slim

# Instalar Python 3 + dependências do Playwright/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    # Dependências do Chromium (Playwright)
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libxshmfence1 libx11-xcb1 \
    # Fontes (necessário para renderizar PDFs corretamente)
    fonts-liberation fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

# Diretório da aplicação Node.js
WORKDIR /app

# ── Node.js ──────────────────────────────────────────
# Copia apenas manifests primeiro (cache eficiente)
COPY package*.json ./

# Instala dependências (sem npm ci, sem workspaces)
RUN npm install

# Copia o restante do código
COPY . .

# ── Python (Agente SEEDF) ────────────────────────────
# Instala dependências Python do agente
RUN pip3 install --break-system-packages \
    playwright>=1.40.0 \
    requests>=2.31.0 \
    python-dotenv>=1.0.0

# Instala o browser Chromium para Playwright
RUN python3 -m playwright install chromium

# Cria diretório de downloads do agente
RUN mkdir -p /app/educa-agent/downloads

# Porta interna usada pelo app
EXPOSE 3000

# Comando de execução
CMD ["npm", "run", "start"]
