#!/usr/bin/env bash
# Pull a current copy of prod's jomify.db to the local machine for
# DBeaver (or any other SQLite client) to inspect.
#
# Checkpoints the WAL on prod first so the copied file reflects the
# latest writes — SQLite defaults to "passive" checkpoints, which
# means naive scp'ing the .db alone can miss recent data.
#
# Default destination is the Windows user folder (DBeaver on Windows
# reads from there cleanly). Override via DEST env var:
#   DEST=~/jomify-prod.db ./scripts/sync-db.sh
#
# Remote defaults match scripts/bot.sh. Same overrides work here:
#   JOMIFY_HOST=1.2.3.4 ./scripts/sync-db.sh

set -euo pipefail

HOST="${JOMIFY_HOST:-132.145.34.57}"
SSH_USER="${JOMIFY_USER:-opc}"
DEST="${DEST:-/mnt/c/Users/JacobMaschler/jomify-prod.db}"
REMOTE_PATH="/home/${SSH_USER}/jomify/jomify.db"

echo "Checkpointing WAL on prod..."
ssh "$SSH_USER@$HOST" "sqlite3 $REMOTE_PATH 'PRAGMA wal_checkpoint(FULL);'" >/dev/null

echo "Copying $REMOTE_PATH -> $DEST..."
scp -q "$SSH_USER@$HOST:$REMOTE_PATH" "$DEST"

bytes=$(stat -c%s "$DEST" 2>/dev/null || wc -c <"$DEST")
echo "Done — $(numfmt --to=iec "$bytes" 2>/dev/null || echo "$bytes bytes")"
echo "If DBeaver had it open, reconnect to pick up the new data."
