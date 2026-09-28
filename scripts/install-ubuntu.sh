#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MIN=20

fail() { printf 'install error: %s\n' "$1" >&2; exit 1; }

as_root() {
  if (( EUID == 0 )); then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "root access is required to install Ubuntu packages; install Node.js ${NODE_MIN}+ and Chrome libraries manually, then rerun."
  fi
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    printf '0'
    return
  fi
  node -p "process.versions.node.split('.')[0]"
}

if (( $(node_major) < NODE_MIN )); then
  command -v apt-get >/dev/null 2>&1 || fail "Node.js ${NODE_MIN}+ is required, and this installer only bootstraps Ubuntu through apt-get."
  printf 'Installing Node.js %s and Chrome runtime libraries\n' "$NODE_MIN"
  as_root apt-get update
  as_root apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | as_root bash -
  as_root apt-get install -y nodejs
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
(( NODE_MAJOR >= NODE_MIN )) || fail "Node.js ${NODE_MIN}+ is required; found $(node --version)."

as_root apt-get install -y \
  libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libcups2 \
  libgtk-3-0 libpango-1.0-0 libcairo2 fonts-liberation xdg-utils

printf 'Installing Octop Browser Automation in %s\n' "$ROOT"
node "$ROOT/scripts/get-browser.js"

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/octop-browser-automation.service"
NODE_BIN="$(command -v node)"
mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Octop Browser Automation
After=network-online.target

[Service]
Type=simple
WorkingDirectory="$ROOT"
ExecStart="$NODE_BIN" "$ROOT/server.js"
Restart=on-failure
RestartSec=3
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=HEADLESS=1

[Install]
WantedBy=default.target
EOF

if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
  systemctl --user enable --now octop-browser-automation.service
  printf '\nOctop is running at http://127.0.0.1:8787\n'
  printf 'Readiness: curl -fsS http://127.0.0.1:8787/api/ready\n'
else
  printf '\nCreated %s\n' "$SERVICE_FILE"
  printf 'Start manually: node %q server.js\n' "$ROOT"
fi