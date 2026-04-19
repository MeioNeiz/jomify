# Jomify

CS2 stats Discord bot. Hosted on Oracle Cloud Free Tier, auto-deployed
from GitHub, backed up nightly.

## Commands

### Player stats
- `/stats [user]` — current Leetify/Premier/rating card
- `/compare user2 [user1] [focus]` — head-to-head (focus = `ratings`/`combat`/`utility`/`h2h`/`form`)
- `/maps [user]` — map win rates
- `/leaderboard` — Premier rankings with change arrows
- `/carry [user]` — who has contributed Premier rating to this player
  (RAPM-style over-performance × outcome weight)

### Group commands
- `/team maps` — map win rates when tracked players queue together
- `/team carry` — guild-wide carry rankings
- `/flash` — team-vs-enemy flash rates, plus best flash game
- `/kobe` — per-match grenade usage and HE damage
- `/shame [user] [focus]` — worst recent game (last 48 h)
- `/sus [user]` — cheat-detection z-scores + inventory signals

### Utility
- `/float url` — decode a CS2 inspect link locally (float, seed, stickers)
- `/inv [user]` — inventory with market links, prices in GBP
- `/track add/remove/list/all` — add players to tracking
- `/link steamid [user]` — link Discord → Steam
- `/import steamids` — bulk import Steam IDs
- `/jomify setchannel channel` — where to post match alerts

## Architecture

- **Bun + TypeScript** runtime
- **SQLite** (Drizzle ORM) at `jomify.db`, WAL journal mode
- **discord.js** Gateway client (no inbound ports needed)
- **Leetify API** — primary data source, with circuit breaker + snapshot
  fallback so commands stay useful during Leetify outages
- **CSFloat API** — skin prices in `/inv`
- **[@csfloat/cs2-inspect-serializer](https://github.com/csfloat/cs-inspect-serializer)**
  — local inspect-link decoding, no round-trip
- **Healthchecks.io** — heartbeat + error notifications by email
- **Stale-while-revalidate** pattern: commands render from local snapshot
  immediately, refresh in the background, edit the message if data changed

## Setup

### Local (dev)

```bash
cp .env.example .env   # DISCORD_TOKEN, DISCORD_CLIENT_ID, LEETIFY_API_KEY,
                       # CSFLOAT_API_KEY (optional), DEV_GUILD_ID (optional),
                       # HEALTHCHECK_URL (optional)
bun install
bun run register       # push slash commands to Discord
bun run dev            # watch-mode
```

### Production (Oracle Cloud Free Tier)

One-time setup on the VM (`opc` user, Oracle Linux):

```bash
sudo dnf install -y git unzip sqlite
curl -fsSL https://bun.sh/install | bash
source ~/.bash_profile
# bun's in /home/opc/.bun/bin — SELinux blocks that path from systemd
sudo cp /home/opc/.bun/bin/bun /usr/local/bin/bun
sudo chcon -t bin_t /usr/local/bin/bun

git clone <your-repo-url> ~/jomify
cd ~/jomify
bun install
nano .env              # populate prod credentials

sudo cp deploy/jomify.service /etc/systemd/system/
sudo cp deploy/jomify-backup.service /etc/systemd/system/
sudo cp deploy/jomify-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jomify jomify-backup.timer
echo 'opc ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart jomify' \
  | sudo tee /etc/sudoers.d/jomify
```

Then add `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` as GitHub
repository secrets and the auto-deploy workflow will take it from there.

## Operations

All from the dev laptop — no manual SSH needed for routine work.

```bash
./scripts/bot.sh                           # live log tail
./scripts/bot.sh --status                  # quick health summary
./scripts/bot.sh --errors --since "1 day ago"
./scripts/bot.sh --restart / --stop / --start
./scripts/bot.sh --backup-now [tag]        # ad-hoc backup
./scripts/bot.sh --restore [date]          # restore from backup repo
./scripts/bot.sh --test-alert              # fire a fail ping
```

### Deploy

`git push` on `main` triggers two GitHub Actions workflows:
- **CI** — `bun run typecheck && lint && knip && test`
- **Deploy** — SSH to the VM, `git pull`, `bun install`, restart systemd

Pre-commit (husky) runs the same check suite locally so bad commits
don't leave your machine.

### Backups

Daily SQLite snapshot pushed to a private GitHub repo (`jomify-backups`)
via systemd timer at 04:00 UTC. Retention:

| Age | Cadence |
|-----|---------|
| 0–7 days | every daily |
| 8–90 days | one per ISO week |
| 91–365 days | one per calendar month |
| >365 days | deleted |

Today's daily is uncompressed; everything else is gzipped. Tagged
(ad-hoc) backups are always compressed and never auto-pruned.

Restore any snapshot (latest or a specific date) with `./scripts/bot.sh
--restore`.

### Monitoring

- **Healthchecks.io** pings every watcher cycle — email if the bot
  stalls or the VM goes down past the grace window.
- **`log.error`** fires a `/fail` ping — immediate email on any error.
- Logs forwarded to `journalctl -u jomify`; stream with
  `./scripts/bot.sh` or filter errors with `--errors --since`.

## Repo layout

```
src/
  commands/       slash command handlers (one file per command)
  store/          SQLite via Drizzle — accounts, matches, carry, maps…
  leetify/        Leetify API client (circuit breaker, cache)
  alerts.ts       rank-up / big-game / streak notifications
  analyse.ts      z-scores for /sus
  helpers.ts      shared render helpers (signed, kdRatio, freshnessSuffix…)
  inventory.ts    Steam + CSFloat inventory pricing
  refresh.ts      refreshPlayers (profile + recent matches)
  watcher.ts      rotating background loop
  weekly.ts       scheduled weekly leaderboard
  schema.ts       Drizzle table definitions
  db.ts           SQLite handle + migrations
scripts/
  bot.sh          one-stop VM control (logs, status, restart, backup, restore)
  backup.sh       runs on the VM (daily + ad-hoc)
  restore.sh      runs on the VM (handles compressed + plain backups)
  db.ts           ad-hoc SQL query tool (bun scripts/db.ts '<sql>')
  logs.ts         (removed — absorbed into bot.sh)
deploy/
  jomify.service           main systemd unit
  jomify-backup.service    backup job unit
  jomify-backup.timer      daily 04:00 UTC + 10 min jitter
tests/
  new-features.test.ts  main coverage (matches, streaks, maps, carry…)
  store.test.ts         baseline store operations
  helpers.test.ts       small helpers + requireGuild
```

## Dev cheat sheet

```bash
bun run typecheck               # tsc --noEmit
bun run lint                    # biome check
bun run lint:fix                # biome --write
bun run knip                    # dead-code / dep audit
bun run check                   # typecheck + lint + knip
bun test                        # full suite
bun run src/cli.ts <command>    # exercise a command without Discord
bun scripts/db.ts '<sql>'       # read-only SQLite query
```
