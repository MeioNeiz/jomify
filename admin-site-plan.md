# Admin site plan

Pick-up doc for the Jomify admin site (tasks #3 + #4). Written after
the dispute flow landed (commit `a3618c8`). Goal: unblock future
sessions so the next person (future-me) doesn't re-plan.

## Goal

A small web UI for managing disputes, balances, markets, and the
audit trail. Discord commands stay the primary surface; the site is
for the things Discord is bad at: scanning tables, one-click admin
rulings on a queue of disputes, browsing the ledger, spotting
suspicious balance activity.

**Not** a replacement for Discord commands. Read-heavy first; write
actions only where a form genuinely beats a slash command.

## Tech stack

| Piece       | Pick                         | Why                                             |
| ----------- | ---------------------------- | ----------------------------------------------- |
| Runtime     | Bun                          | Already on the box; no new install              |
| HTTP        | Hono                         | Tiny, TypeScript-first, native on Bun           |
| Templating  | Hono JSX (`hono/jsx`)        | Server-rendered, no client framework to learn   |
| Styling     | Tailwind via CDN             | Zero tooling; good enough for an admin UI       |
| Sessions    | Signed cookies (Hono helper) | No session store needed; HMAC with env secret   |
| DB          | bun:sqlite direct            | Same files as the bot, separate handles         |

No React / Svelte / Next. If a page needs interactivity, reach for
htmx or a ~30-line vanilla script, not a framework.

## Repo layout

```
admin/
├── index.ts            # Hono app entry (listens on ADMIN_PORT)
├── auth.ts             # Discord OAuth + session cookies
├── middleware.ts       # requireAdmin, CSRF, audit logging
├── routes/
│   ├── dashboard.tsx   # /
│   ├── markets.tsx     # /markets, /markets/:id
│   ├── disputes.tsx    # /disputes, /disputes/:id (+ resolve form)
│   ├── users.tsx       # /users, /users/:discordId (+ adjust form)
│   └── ledger.tsx      # /ledger paginated
└── views/
    ├── layout.tsx      # shell: nav, user chip, flash messages
    └── components.tsx  # tables, badges, buttons
```

No new top-level framework. Shares `src/betting/store/*` and
`src/db.ts` for reads AND writes (SQLite WAL handles two writers on
the same box fine — already proven by the watcher + main bot process).

## Hosting + deployment

- Separate systemd unit `jomify-admin.service` running `bun run admin/index.ts`.
- Listens on `127.0.0.1:${ADMIN_PORT}` (default `8080`).
- nginx proxies a subdomain → `localhost:8080` with TLS (reuse the
  existing Let's Encrypt cert or provision a new one).
- Same repo, same deploy workflow: `.github/workflows/deploy.yml`
  already does `git pull && bun install && bun run register &&
  systemctl restart jomify`. Add `systemctl restart jomify-admin`
  after the bot restart.
- Env vars (add to the same `.env` the bot reads):
  - `ADMIN_PORT=8080`
  - `ADMIN_SESSION_SECRET=<long random>`
  - `ADMIN_GUILD_ID=<discord guild id>` — the guild whose ManageGuild
    permission gates the site. Default to `DEV_GUILD_ID` if unset.
  - `DISCORD_CLIENT_SECRET=<from Discord developer portal>` — new;
    OAuth flow needs it.
  - `ADMIN_BASE_URL=https://admin.whatever` — used for OAuth redirect.

## Auth

Discord OAuth2 authorization code flow. Standard.

1. `GET /login` → 302 to
   `https://discord.com/oauth2/authorize?client_id=…&scope=identify%20guilds.members.read&redirect_uri=…&response_type=code`.
2. `GET /auth/callback?code=…` →
   - POST to `https://discord.com/api/oauth2/token` with the code.
   - GET `/users/@me/guilds/:guildId/member` with the access token
     (scope `guilds.members.read` gives this).
   - Check `member.permissions & MANAGE_GUILD` bitmask.
   - If yes: set signed session cookie `{ discordId, username, exp: now + 1h }`.
   - If no: render a "not authorised" page (don't reveal much).
3. Every request uses `requireAdmin` middleware: verify cookie, refresh
   expiry, populate `c.var.user`.
4. `GET /logout` clears the cookie.

Session cookie: HMAC-SHA256 signed with `ADMIN_SESSION_SECRET`,
`HttpOnly`, `Secure`, `SameSite=Lax`. Format:
`<base64url payload>.<base64url hmac>`. Sliding 1-hour expiry.

## Routes

### Read-only (task #3)

| Route                         | Purpose                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `GET /`                       | Dashboard: open markets count, open disputes queue (front and centre), recent cancel/resolve activity, top balances |
| `GET /markets`                | Table of markets. Filters: status (open/resolved/cancelled), guild, creator. Sort by created_at desc |
| `GET /markets/:id`            | Market detail: question, pool, wagers list, ledger rows referencing this bet, dispute history |
| `GET /disputes`               | Queue view — open disputes first, one-click through to resolve form. Resolved disputes below |
| `GET /disputes/:id`           | Full dispute: bet context, opener reason, vote tally with voters, resolution form (task #4) |
| `GET /users`                  | User table: discord id, username (from Discord API cache), balance, wager count, disputes opened |
| `GET /users/:discordId`       | User detail: balance, recent ledger (paginated), open wagers, disputes opened/voted-on, manual adjust form (task #4) |
| `GET /ledger?page=…&reason=…` | Paginated ledger browser. Filters: reason, discord_id, ref, date range            |

### Write actions (task #4)

| Route                             | Handler                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST /disputes/:id/resolve`      | Body: `action={keep,flip-yes,flip-no,cancel}`. Calls `reopenBet` + `resolveBet`/`cancelBet` + `markDisputeResolved`. Refreshes the Discord messages via the bot's client (see "Cross-process refresh" below) |
| `POST /users/:discordId/adjust`   | Body: `delta` (signed int), `reason` (required string, max 80 chars). Calls `adjustBalance`. Records the admin id + reason in a new `admin_actions` table |
| `POST /markets/:id/cancel`        | Admin cancel of any market (not tied to a dispute). Calls `cancelBet`. Audit-logged               |

Forms use double-submit CSRF: cookie `csrf=<random>` + hidden field
with the same value, server verifies match.

## Cross-process refresh

The bot owns the Discord connection. When the admin site resolves a
dispute, the market message and dispute panel still need re-rendering
in Discord. Options:

1. **Ignore** — let the DB be authoritative; the messages re-render
   next time anyone clicks a button. Stale for a bit.
2. **Poll** — bot polls a new `admin_actions` table every 10 s and
   refreshes affected messages. Simple, adds lag.
3. **IPC** — admin posts to a bot-internal HTTP endpoint (`POST
   http://127.0.0.1:3001/refresh`) saying "refresh market #N / dispute
   #M". Instant, adds a port.

**Pick (3)** — the bot exposes a loopback-only endpoint on a new
`INTERNAL_PORT`. Only accepts requests from `127.0.0.1`. Admin site
calls it after any write. Clean separation.

## Audit log

New table `admin_actions`:

```sql
CREATE TABLE admin_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  admin_id     TEXT NOT NULL,        -- discord id of the admin
  action       TEXT NOT NULL,        -- 'dispute-resolve', 'balance-adjust', 'market-cancel'
  target       TEXT NOT NULL,        -- bet id / dispute id / user id
  details      TEXT NOT NULL         -- JSON blob with params
);
CREATE INDEX idx_admin_actions_at ON admin_actions (at);
CREATE INDEX idx_admin_actions_admin ON admin_actions (admin_id);
```

Every write handler inserts one row in the same transaction as the
store mutation. Dashboard shows the last 10 admin actions.

Lives in the **betting** DB since most writes target it.

## Open questions

- **Domain** — `admin.<something>.dev`? Needs DNS + cert. Alternative:
  a path on an existing site reverse-proxied to :8080. Simpler to
  provision is a subdomain with a fresh cert.
- **Guild scope** — one guild's ManageGuild, or a configurable list?
  Start with one (`ADMIN_GUILD_ID`); generalise if multi-tenant ever
  matters.
- **User display names** — Discord OAuth gives the logged-in user's
  name, but listing other users requires fetching via the bot (which
  has guild members cached). Options: fetch via the bot's IPC
  endpoint, or store a `discord_usernames` cache populated on every
  interaction. Punt to a later pass — show raw `<@snowflake>` for v1
  and let the browser render via Discord's oembed if possible.
- **Pagination defaults** — 50 rows per page feels right for ledger,
  25 for markets/users.

## Task breakdown

Replace existing tasks #3 and #4 with these:

**#3 Admin site scaffold (read-only)**
- 3.1 Add Hono dep, `admin/index.ts` entry, `ADMIN_PORT` env var
- 3.2 Auth: OAuth callback, session cookies, `requireAdmin` middleware
- 3.3 Layout + nav + tailwind shell
- 3.4 Dashboard (`/`) + markets list + market detail
- 3.5 Disputes list + detail (read-only panel, no resolve yet)
- 3.6 Users list + detail (read-only, no adjust yet)
- 3.7 Ledger browser with filters + pagination
- 3.8 systemd unit, nginx config, deploy workflow update

**#4 Admin site write actions**
- 4.1 `admin_actions` table + migration
- 4.2 CSRF middleware (double-submit cookie)
- 4.3 Dispute resolve form + handler
- 4.4 Balance adjust form + handler
- 4.5 Market cancel form + handler
- 4.6 Cross-process refresh: bot exposes `/refresh` on INTERNAL_PORT; admin calls after writes
- 4.7 Dashboard recent-admin-actions widget

## Scope notes

- Skip: user CRUD (Discord owns identity), multi-admin-role perms
  beyond ManageGuild, fancy charts, WebSockets, anything a CLI could
  do faster.
- Favour: one-click queue-driven dispute resolution, clean ledger
  search, the audit log. Those are what Discord is bad at and what
  the site has to be good at.
