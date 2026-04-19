#!/usr/bin/env bash
# Pull the latest datasette-metadata.yaml onto prod and restart the
# service. Run after editing ops/datasette-metadata.yaml and pushing
# to main — GH Actions auto-deploys the bot, but it doesn't touch
# datasette's metadata since datasette is its own systemd unit.
#
# Usage: ./scripts/datasette-reload.sh

set -euo pipefail

HOST="${JOMIFY_HOST:-132.145.34.57}"
SSH_USER="${JOMIFY_USER:-opc}"

ssh "$SSH_USER@$HOST" '
  set -e
  cd ~/jomify
  echo "=== pulling latest ==="
  git pull --ff-only
  echo "=== restarting datasette-jomify ==="
  sudo systemctl restart datasette-jomify
  sleep 2
  sudo systemctl is-active datasette-jomify
  echo "=== canned queries loaded ==="
  curl -s http://127.0.0.1:8001/jomify.json \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(\"\\n\".join(\"  - \" + q[\"name\"] for q in d.get(\"queries\", [])))"
'
