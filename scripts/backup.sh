#!/usr/bin/env bash
# Daily SQLite backup to a private GitHub repo.
#
# Runs on the VM via systemd timer (deploy/jomify-backup.timer).
# Requires:
#   - $HOME/.jomify-backup-pat  : fine-grained PAT with write access to BACKUP_REPO
#   - $BACKUP_REPO below        : your private backup repo slug (user/repo)
#
# Files live at $HOME/jomify-backups/ as jomify-YYYY-MM-DD.db, pruned to
# $RETAIN_DAYS. SQLite's `.backup` is safe while the bot has the DB open.

set -euo pipefail

BACKUP_REPO="${JOMIFY_BACKUP_REPO:-MeioNeiz/jomify-backups}"
BACKUP_DIR="$HOME/jomify-backups"
DB_PATH="$HOME/jomify/jomify.db"
TOKEN_FILE="$HOME/.jomify-backup-pat"
RETAIN_DAYS=30

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "Missing $TOKEN_FILE — create a GitHub PAT and save it there." >&2
  exit 1
fi
if [[ ! -f "$DB_PATH" ]]; then
  echo "No database at $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
cd "$BACKUP_DIR"

# Initialise on first run.
if [[ ! -d .git ]]; then
  git init -q -b main
  git config user.email "backup@jomify.local"
  git config user.name  "jomify-backup"
  echo "*.db binary" > .gitattributes
fi

# Consistent snapshot — safe with concurrent writers, uses SQLite's
# native online backup API.
BACKUP_FILE="jomify-$(date -u +%F).db"
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Prune anything older than RETAIN_DAYS.
find . -maxdepth 1 -name 'jomify-*.db' -mtime +"$RETAIN_DAYS" -delete

git add -A
if git diff --cached --quiet; then
  echo "no changes"
  exit 0
fi

git commit -q -m "backup $(date -u +%F)"

TOKEN="$(cat "$TOKEN_FILE")"
git push -q "https://${TOKEN}@github.com/${BACKUP_REPO}.git" main
echo "pushed $BACKUP_FILE"
