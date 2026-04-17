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
  printf '%s\n' '*.db binary' '*.db.gz binary' > .gitattributes
fi

# Consistent snapshot — safe with concurrent writers, uses SQLite's
# native online backup API.
BACKUP_FILE="jomify-$(date -u +%F).db"
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Retention policy (tapered GFS-style):
#   0–7 days   : keep every daily (~7 files)
#   8–90 days  : keep one per ISO week (~12 files)
#   91–365 days: keep one per calendar month (~9 files)
#   >365 days  : delete
# Steady state: ~28 files ≈ 20 MB. Cheap in a private repo, plenty of
# rollback granularity close to now, coarse history out to a year.
WEEK_CAP_DAYS=90
MONTH_CAP_DAYS=365
declare -A week_kept
declare -A month_kept
NOW=$(date -u +%s)
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  # Strip both .db and .db.gz so date parsing works regardless of
  # compression state.
  date_str="${file##*/jomify-}"
  date_str="${date_str%.db.gz}"
  date_str="${date_str%.db}"
  age=$(( (NOW - $(date -u -d "$date_str" +%s)) / 86400 ))

  if (( age <= 7 )); then
    continue  # recent dailies — keep all
  fi

  if (( age > MONTH_CAP_DAYS )); then
    rm -f "$file"
    continue
  fi

  if (( age <= WEEK_CAP_DAYS )); then
    week=$(date -u -d "$date_str" +%G-W%V)
    if [[ -n "${week_kept[$week]:-}" ]]; then
      rm -f "$file"
    else
      week_kept[$week]="$file"
    fi
  else
    month=$(date -u -d "$date_str" +%Y-%m)
    if [[ -n "${month_kept[$month]:-}" ]]; then
      rm -f "$file"
    else
      month_kept[$month]="$file"
    fi
  fi
done < <(ls -1 jomify-*.db jomify-*.db.gz 2>/dev/null | sort -r)

# Compress everything except today's snapshot. Today's stays raw so
# restoring the latest is a straight `cp`. Older files rarely get
# restored; gzip brings each one down ~3-5x. Uses -f to overwrite any
# stale .gz artefacts left by a failed prior run.
TODAY_FILE="jomify-$(date -u +%F).db"
for file in jomify-*.db; do
  [[ "$file" == "$TODAY_FILE" ]] && continue
  [[ -f "$file" ]] || continue
  gzip -f "$file"
done

git add -A
if git diff --cached --quiet; then
  echo "no changes"
  exit 0
fi

git commit -q -m "backup $(date -u +%F)"

TOKEN="$(cat "$TOKEN_FILE")"
git push -q "https://${TOKEN}@github.com/${BACKUP_REPO}.git" main
echo "pushed $BACKUP_FILE"
