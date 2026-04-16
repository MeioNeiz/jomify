#!/usr/bin/env bash
# Stream prod logs from the Oracle VM with pino-pretty formatting.
#   ./scripts/logs.sh             # live tail (Ctrl-C to quit)
#   ./scripts/logs.sh --once      # last 100 lines, non-blocking
#   ./scripts/logs.sh -n 200      # live tail with 200 lines of backlog
#
# Override host/user via env:
#   JOMIFY_HOST=1.2.3.4 ./scripts/logs.sh

set -euo pipefail

HOST="${JOMIFY_HOST:-132.145.34.57}"
SSH_USER="${JOMIFY_USER:-opc}"
N="50"
MODE="-f"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) MODE="--no-pager"; shift ;;
    -n) N="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

ssh "$SSH_USER@$HOST" \
  "sudo journalctl -u jomify $MODE -n $N -o cat | ~/.bun/bin/bunx pino-pretty"
