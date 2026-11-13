#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
sudo apt-get update -qq
sudo apt-get install -y ffmpeg libcap2-bin
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)' ||
  { echo 'Instala Node.js 22.13 o superior.' >&2; exit 1; }
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
if [ ! -f .env ]; then
  sed 's/^PORT=3000$/PORT=80/' .env.example > .env
fi
sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(command -v node)")"
command -v pm2 >/dev/null || sudo npm install -g pm2
pm2 startOrRestart deploy/ecosystem.config.cjs
pm2 save
sudo env "PATH=$PATH" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME"
