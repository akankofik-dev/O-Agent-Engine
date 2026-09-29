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

printf 'Installing O Agent in %s\n' "$ROOT"
node "$ROOT/scripts/get-browser.js"

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="o-agent.service"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME"
# The unit used to be octop-browser-automation.service. Renaming it is the right
# name and the wrong moment to drop it silently: an already-installed machine has
# the old unit linked AND enabled, and leaving it there gives two units that both
# want port 8787 — the second one loses the bind and restart-loops. So the old
# name is retired explicitly, before the new one is written.
OLD_SERVICE_NAME="octop-browser-automation.service"
OLD_SERVICE_FILE="$SERVICE_DIR/$OLD_SERVICE_NAME"
NODE_BIN="$(command -v node)"
mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=O Agent
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
  if [ -e "$OLD_SERVICE_FILE" ] || systemctl --user cat "$OLD_SERVICE_NAME" >/dev/null 2>&1; then
    printf 'Retiring the old %s\n' "$OLD_SERVICE_NAME"
    systemctl --user disable --now "$OLD_SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "$OLD_SERVICE_FILE"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    systemctl --user reset-failed "$OLD_SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  systemctl --user enable --now "$SERVICE_NAME"
  printf '\nO Agent is running at http://127.0.0.1:8787\n'
  printf 'Readiness: curl -fsS http://127.0.0.1:8787/api/ready\n'
else
  printf '\nCreated %s\n' "$SERVICE_FILE"
  printf 'Start manually: node %q server.js\n' "$ROOT"
fi