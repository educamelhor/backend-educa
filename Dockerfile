# Base estável
FROM node:20-alpine

# Diretório da aplicação
WORKDIR /app

# Copia apenas manifests primeiro (cache eficiente)
COPY package*.json ./

# Instala dependências (sem npm ci, sem workspaces)
RUN npm install

# Copia o restante do código
COPY . .

# Porta interna usada pelo app
EXPOSE 3000

# Comando de execução
CMD ["npm", "run", "start"]
