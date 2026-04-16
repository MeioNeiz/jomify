#!/usr/bin/env bash
# Stream prod logs from the Oracle VM with pino-pretty formatting.
#   ./scripts/logs.sh                       # live tail (Ctrl-C to quit)
#   ./scripts/logs.sh --once                # last 100 lines, non-blocking
#   ./scripts/logs.sh -n 200                # live tail with 200 lines backlog
#   ./scripts/logs.sh --errors              # live-tail errors only
#   ./scripts/logs.sh --errors --once       # all errors in the journal
#   ./scripts/logs.sh --since "2 hours ago" # window; implies --once
#   ./scripts/logs.sh --since yesterday --errors
#   ./scripts/logs.sh --status              # quick service health check
#
# Override host/user via env:
#   JOMIFY_HOST=1.2.3.4 ./scripts/logs.sh

set -euo pipefail

HOST="${JOMIFY_HOST:-132.145.34.57}"
SSH_USER="${JOMIFY_USER:-opc}"
N="50"
MODE="-f"
PRIORITY=""
SINCE=""

STATUS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) MODE="--no-pager"; shift ;;
    --errors) PRIORITY="-p err"; shift ;;
    --since) SINCE="--since \"$2\""; MODE="--no-pager"; shift 2 ;;
    --status) STATUS=1; shift ;;
    -n) N="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ $STATUS -eq 1 ]]; then
  ssh "$SSH_USER@$HOST" '
    echo "=== state ==="
    sudo systemctl is-active jomify
    echo "=== uptime ==="
    sudo systemctl show jomify -p ActiveEnterTimestamp --value
    echo "=== last 5 lines ==="
    sudo journalctl -u jomify -n 5 --no-pager -o cat
  '
  exit 0
fi

CMD="sudo journalctl -u jomify $MODE -n $N $PRIORITY $SINCE -o cat | ~/.bun/bin/bunx pino-pretty"
ssh "$SSH_USER@$HOST" "$CMD"
