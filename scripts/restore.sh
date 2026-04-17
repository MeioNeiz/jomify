#!/usr/bin/env bash
# Restore the production DB from the private backup repo.
# Run ON THE VM (not from laptop).
#
#   ./scripts/restore.sh               # latest backup
#   ./scripts/restore.sh 2026-04-17    # specific date
#
# Preserves the current DB as $DB_PATH.pre-restore-<timestamp> before
# overwriting, so you can roll back if the restore was wrong.

set -euo pipefail

BACKUP_REPO="${JOMIFY_BACKUP_REPO:-MeioNeiz/jomify-backups}"
BACKUP_DIR="$HOME/jomify-backups"
DB_PATH="$HOME/jomify/jomify.db"
TOKEN_FILE="$HOME/.jomify-backup-pat"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "Missing $TOKEN_FILE — where's the PAT?" >&2
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"
DATE="${1:-}"

# Sync the backup repo (clone or fetch latest).
if [[ ! -d "$BACKUP_DIR/.git" ]]; then
  git clone --quiet "https://${TOKEN}@github.com/${BACKUP_REPO}.git" "$BACKUP_DIR"
else
  git -C "$BACKUP_DIR" pull --quiet \
    "https://${TOKEN}@github.com/${BACKUP_REPO}.git" main
fi

# Select the backup file. Older snapshots are gzipped to save repo
# space — we accept either .db or .db.gz and decompress transparently.
if [[ -z "$DATE" ]]; then
  BACKUP_FILE="$(ls -1 "$BACKUP_DIR"/jomify-*.db "$BACKUP_DIR"/jomify-*.db.gz \
    2>/dev/null | sort | tail -1)"
else
  if [[ -f "$BACKUP_DIR/jomify-$DATE.db" ]]; then
    BACKUP_FILE="$BACKUP_DIR/jomify-$DATE.db"
  elif [[ -f "$BACKUP_DIR/jomify-$DATE.db.gz" ]]; then
    BACKUP_FILE="$BACKUP_DIR/jomify-$DATE.db.gz"
  else
    BACKUP_FILE=""
  fi
fi

if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "No backup found${DATE:+ for date $DATE}" >&2
  echo "Available:" >&2
  ls -1 "$BACKUP_DIR"/jomify-*.db "$BACKUP_DIR"/jomify-*.db.gz 2>/dev/null \
    || echo "  (none)" >&2
  exit 1
fi

echo "This will REPLACE"
echo "  $DB_PATH"
echo "with"
echo "  $BACKUP_FILE"
read -r -p "Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

echo "Stopping bot..."
sudo systemctl stop jomify

# Snapshot the current DB before overwrite.
if [[ -f "$DB_PATH" ]]; then
  SNAPSHOT="${DB_PATH}.pre-restore-$(date -u +%Y-%m-%dT%H%M%SZ)"
  cp "$DB_PATH" "$SNAPSHOT"
  echo "Previous DB preserved at $SNAPSHOT"
fi

if [[ "$BACKUP_FILE" == *.gz ]]; then
  gunzip -c "$BACKUP_FILE" > "$DB_PATH"
else
  cp "$BACKUP_FILE" "$DB_PATH"
fi

echo "Starting bot..."
sudo systemctl start jomify
sleep 2
STATE="$(sudo systemctl is-active jomify)"
echo "Service is: $STATE"

if [[ "$STATE" != "active" ]]; then
  echo "Bot failed to start! Check journalctl -u jomify" >&2
  exit 1
fi

echo "Restored successfully."
