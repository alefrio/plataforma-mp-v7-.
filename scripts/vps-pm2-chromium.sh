#!/usr/bin/env bash
# Executar no Ubuntu (VPS), na pasta do projeto ou passar o caminho como 1º argumento.
# Ex.: bash scripts/vps-pm2-chromium.sh
# Ex.: bash scripts/vps-pm2-chromium.sh /var/www/plataforma-mp-v7
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

echo "==> Pasta do projeto: $ROOT"

echo "==> Dependências de sistema (Chromium / Puppeteer / headless)"
sudo apt-get update -y
sudo apt-get install -y \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  wget \
  xdg-utils \
  lsb-release

# Ubuntu 24.04+: alguns pacotes usam sufixo t64 — instalar equivalentes se faltar
if ! dpkg -l libasound2 &>/dev/null && apt-cache show libasound2t64 &>/dev/null; then
  sudo apt-get install -y libasound2t64 || true
fi

# Navegador Chromium do sistema (útil para Puppeteer com executablePath)
if apt-cache show chromium-browser &>/dev/null; then
  sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium || true
elif apt-cache show chromium &>/dev/null; then
  sudo apt-get install -y chromium || true
fi

echo "==> npm install"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

echo "==> PM2 (entrada correta: server/index.js, não index.js na raiz)"
if ! command -v pm2 &>/dev/null; then
  echo "PM2 não encontrado. Instale: sudo npm install -g pm2"
  exit 1
fi

pm2 delete plataforma-mp 2>/dev/null || true
pm2 start server/index.js --name plataforma-mp
pm2 save

echo "==> Concluído. Ver estado: pm2 status"
echo "    Logs: pm2 logs plataforma-mp"
echo "    Arranque no boot (uma vez): pm2 startup && copie/cole o comando que o PM2 mostrar"
