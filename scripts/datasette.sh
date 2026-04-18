#!/usr/bin/env bash
# Open an SSH tunnel to prod's datasette service and launch it in your
# browser. Runs in the foreground — Ctrl-C closes the tunnel.
#
# Datasette itself runs as a systemd unit on prod bound to 127.0.0.1,
# so this script is the only way to reach it from your laptop. SELinux
# context for ~/.local/bin is already set (chcon -t bin_t) so the
# service restarts cleanly across reboots.

set -euo pipefail

HOST="${JOMIFY_HOST:-132.145.34.57}"
SSH_USER="${JOMIFY_USER:-opc}"
LOCAL_PORT="${DATASETTE_PORT:-8001}"
REMOTE_PORT=8001
URL="http://localhost:${LOCAL_PORT}"

open_browser() {
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe start "$URL" >/dev/null 2>&1 &
  else
    echo "Open $URL in your browser."
  fi
}

echo "Opening tunnel: localhost:${LOCAL_PORT} -> ${HOST}:${REMOTE_PORT}"
echo "Browse: ${URL}"
( sleep 1 && open_browser ) &
exec ssh -N -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "${SSH_USER}@${HOST}"
