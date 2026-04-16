#!/usr/bin/env bash
# Talk to prod from your laptop. Everything SSHes to the VM.
#
# Log viewing:
#   ./scripts/bot.sh                       # live tail (Ctrl-C to quit)
#   ./scripts/bot.sh --once                # last N lines (default 50)
#   ./scripts/bot.sh -n 200                # live tail with 200 lines backlog
#   ./scripts/bot.sh --errors              # live-tail errors only
#   ./scripts/bot.sh --errors --since "1 day ago"
#   ./scripts/bot.sh --since "2 hours ago"
#
# Service control:
#   ./scripts/bot.sh --status              # one-shot health summary
#   ./scripts/bot.sh --stop                # stop prod bot
#   ./scripts/bot.sh --start               # start prod bot
#   ./scripts/bot.sh --restart             # restart prod bot
#   ./scripts/bot.sh --test-alert          # fire a /fail ping to Healthchecks
#
# Override host/user via env:
#   JOMIFY_HOST=1.2.3.4 ./scripts/bot.sh

set -euo pipefail

HOST="${JOMIFY_HOST:-132.145.34.57}"
SSH_USER="${JOMIFY_USER:-opc}"
N="50"
MODE="-f"
PRIORITY=""
SINCE=""
ACTION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) MODE="--no-pager"; shift ;;
    --errors) PRIORITY="-p err"; shift ;;
    --since) SINCE="--since \"$2\""; MODE="--no-pager"; shift 2 ;;
    --status) ACTION="status"; shift ;;
    --stop) ACTION="stop"; shift ;;
    --start) ACTION="start"; shift ;;
    --restart) ACTION="restart"; shift ;;
    --test-alert) ACTION="test-alert"; shift ;;
    -n) N="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

case "$ACTION" in
  status)
    ssh "$SSH_USER@$HOST" '
      echo "=== state ===";
      sudo systemctl is-active jomify;
      echo "=== uptime ===";
      sudo systemctl show jomify -p ActiveEnterTimestamp --value;
      echo "=== last 5 lines ===";
      sudo journalctl -u jomify -n 5 --no-pager -o cat
    '
    ;;
  stop)
    ssh "$SSH_USER@$HOST" "sudo systemctl stop jomify && sudo systemctl is-active jomify || true"
    ;;
  start)
    ssh "$SSH_USER@$HOST" "sudo systemctl start jomify && sudo systemctl is-active jomify"
    ;;
  restart)
    ssh "$SSH_USER@$HOST" "sudo systemctl restart jomify && sudo systemctl is-active jomify"
    ;;
  test-alert)
    # Reads HEALTHCHECK_URL from the VM's .env and hits the /fail endpoint.
    # Expect an email within a minute if Healthchecks is wired correctly.
    ssh "$SSH_USER@$HOST" '
      set -a; . /home/opc/jomify/.env; set +a
      if [[ -z "${HEALTHCHECK_URL:-}" ]]; then
        echo "HEALTHCHECK_URL not set in .env" >&2; exit 1
      fi
      echo "Firing fail ping to $HEALTHCHECK_URL/fail..."
      curl -sS -X POST "$HEALTHCHECK_URL/fail" && echo
    '
    ;;
  "")
    CMD="sudo journalctl -u jomify $MODE -n $N $PRIORITY $SINCE -o cat | ~/.bun/bin/bunx pino-pretty"
    ssh "$SSH_USER@$HOST" "$CMD"
    ;;
esac
