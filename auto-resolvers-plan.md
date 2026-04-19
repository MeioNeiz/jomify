# Auto-resolvers + market mirroring plan

Pick-up doc for task #5. Covers programmatic market resolution (CS +
stocks), mirroring external prediction markets with shekels, and a
social join/challenge mechanic so activity is visible and contagious.

## Goal

Markets that close themselves. Today a creator has to remember to
resolve; dispute flow covers bad-faith rulings but most markets sit
open forever because nobody comes back to press a button. A resolver
is a rule that, given world state, tells us:

- keep waiting, or
- resolve yes / no, or
- cancel & refund.

Plus: let people bet against real Polymarket / Kalshi markets using
shekels, so the conversation extends past CS into events anyone can
argue about.

## Schema

Add three nullable columns to `bets`:

```sql
ALTER TABLE bets ADD COLUMN resolver_kind TEXT;    -- 'cs-next-match-win', 'stock-above', 'polymarket-mirror', …
ALTER TABLE bets ADD COLUMN resolver_args TEXT;    -- JSON blob, kind-specific
ALTER TABLE bets ADD COLUMN resolver_state TEXT;   -- JSON blob, kind-specific progress (last check, cached upstream state)
CREATE INDEX idx_bets_resolver ON bets (resolver_kind) WHERE resolver_kind IS NOT NULL;
```

- `resolver_kind` is the registry key. `NULL` = manual market (today's
  default, unchanged).
- `resolver_args` is static config captured at creation (steamId,
  ticker, Polymarket slug, threshold, etc.).
- `resolver_state` is mutable scratchpad (last-seen upstream status,
  seen-matches set, etc.) so resolvers can be idempotent across polls.

## Resolver interface

```ts
// src/betting/resolvers/index.ts
export type ResolverVerdict =
  | { kind: "pending"; nextState?: unknown }   // still waiting; optionally update resolver_state
  | { kind: "resolve"; outcome: "yes" | "no"; note?: string }
  | { kind: "cancel"; note?: string };         // e.g. underlying market cancelled upstream

export type ResolverContext = {
  bet: Bet;                   // includes resolver_args parsed + resolver_state parsed
  now: Date;
  fetch: typeof fetch;        // injected so tests can mock
};

export type Resolver = {
  kind: string;
  check: (ctx: ResolverContext) => Promise<ResolverVerdict>;
  /** Optional: render a one-line preview for the market embed. */
  describe?: (args: unknown) => string;
};

export function register(resolver: Resolver): void;
export function lookup(kind: string): Resolver | null;
```

Each kind lives in its own file under `src/betting/resolvers/` and
self-registers at import time, same pattern as `registerComponent`.

## Poller

`src/betting/resolvers/watcher.ts` — ticks every 60 s:

1. Query open, non-expired bets with `resolver_kind IS NOT NULL`.
2. For each, look up the registered resolver and invoke `check(ctx)`.
3. On `pending` with `nextState`: update `resolver_state` only.
4. On `resolve`: call `resolveBet(betId, outcome)`; note goes into the
   market's resolution embed.
5. On `cancel`: call `cancelBet(betId)`; note prefixes the cancel
   reason.
6. Always refresh the market's Discord message after a mutation
   (same pattern as the expiry watcher — reuse `renderMarketView` +
   stored channel_id/message_id).

One `setInterval` for all resolvers; per-resolver errors are logged
and isolated so one flaky upstream doesn't block the rest.

## Kinds to ship

### CS

Piggyback on the existing `cs:match-completed` event where possible —
cheaper + more timely than polling Leetify.

| Kind                          | Args                             | Verdict rule                                                |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `cs:next-match-win`           | `{ steamId }`                    | First match after market open: yes if win, no if loss       |
| `cs:next-match-rating-above`  | `{ steamId, threshold }`         | First match: yes if rating ≥ threshold, no otherwise        |
| `cs:next-match-kills-above`   | `{ steamId, threshold }`         | First match: yes if total_kills > threshold                 |
| `cs:premier-milestone`        | `{ steamId, target }`            | yes the moment `snapshots.premier ≥ target`; no at expiry   |
| `cs:win-streak`               | `{ steamId, count }`             | yes when `player_streaks.streakType='win' AND count ≥ N`    |
| `cs:clutch-count`             | `{ steamId, count, windowDays }` | yes when N clutches land inside the window                  |

Implementation note: "next-match-*" resolvers subscribe to the event
bus *and* check on poll — subscribing is instant but the poll covers
races where the bot was down when the match completed.

`resolver_state` for next-match kinds: `{ createdAtIso }` so the
resolver ignores matches that completed *before* the market opened.

### Stocks

API pick: **Alpha Vantage** (free tier, 25 req/day). Generous enough
for a handful of markets polled every 15 min. If we scale up, switch
to Polygon.io (5 req/min free).

Env: `ALPHA_VANTAGE_KEY`.

| Kind                 | Args                                     | Verdict rule                              |
| -------------------- | ---------------------------------------- | ----------------------------------------- |
| `stock:price-above`  | `{ ticker, target, byIso }`              | yes if close > target by `byIso`, else no |
| `stock:price-below`  | `{ ticker, target, byIso }`              | yes if close < target by `byIso`, else no |
| `stock:pct-move`     | `{ ticker, pct, byIso, direction }`      | yes if % move ≥ pct in direction by date  |

Poll cadence: every 15 min during market hours, hourly outside. Cache
the last-seen quote in `resolver_state` to avoid burning the free-tier
quota.

### External mirrors (the interesting one)

Mirror a Polymarket or Kalshi market. Ours tracks theirs 1:1. When
theirs resolves, ours does too. People bet with shekels.

| Kind                    | Args                          | Source                                                                |
| ----------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `external:polymarket`   | `{ slug }`                    | `https://gamma-api.polymarket.com/markets?slug=…` (public, no key)    |
| `external:kalshi`       | `{ ticker }`                  | Kalshi API (free tier, needs login token)                             |

Polymarket response includes `closed`, `archived`, `resolvedOutcome`
('Yes' / 'No' / 'Unresolved'). Map their outcome → ours.

Edge cases:
- Market voided upstream → `cancel` verdict.
- Resolution delayed → stay pending.
- Upstream 404s for a while → keep pending, don't cancel on a blip
  (only cancel if upstream explicitly says so).

## UX

### Creation

New subcommands under `/market` so the resolver picker is
discoverable:

- `/market cs-next-match player: outcome:win|rating-above|kills-above [threshold:] duration:`
- `/market cs-premier player: target: duration:`
- `/market stock ticker: direction:above|below price: by:`
- `/market mirror source:polymarket|kalshi ref:`

Each handler:
1. Validates args (ticker exists, slug is reachable, steamId tracked).
2. For mirrors, **fetches once up front** and shows a preview embed
   with the upstream question + current yes/no odds, plus a Confirm
   button. Stops the "I created a market for the wrong event" failure.
3. Calls `createBet` with `resolver_kind` + `resolver_args`, same as
   the manual path otherwise.

### Display

Market embed adds one line under the question when `resolver_kind` is
set:

```
Pool: 🟢 15 yes · 🔴 8 no (23 total)
Auto-resolves: Dom's next match (win)        ← from resolver.describe()
Created by @jom · Closes in 3 hours
```

For mirrors, also include the upstream link:

```
Mirrors polymarket.com/event/<slug> — their resolution flips ours.
```

Resolve buttons hidden when `resolver_kind` is set (no manual creator
override — admins can still step in via the dispute flow).

## Social: challenges + activity

Two additions. Independent of auto-resolvers but same task since
they're about making markets *feel alive*.

### Challenge markets

`/market challenge user:@bob question: my-side:yes|no amount:`:

1. Creates a market with the creator's wager already placed.
2. Stores `challenge_target_discord_id` + `challenge_accept_by` on the
   bet (new nullable columns).
3. Posts with an extra line: `⚔️ <@bob> has been challenged —
   accept within 30 minutes.`
4. During the window, the Bet No button (opposite side) is pre-
   labelled for `<@bob>` with the suggested equal amount. Others can
   still bet, but it reads as bob's to take first.
5. After `challenge_accept_by` expires: line turns into `Challenge
   expired — open to everyone.` Nothing else changes; the market
   keeps running.

### Activity pings

Toggleable via `/market config activity:on|off` per guild. When on:

- A new market posts to the notify channel (already works because
  `/market create` lives in the guild channel).
- Every *first-of-its-kind* bet (first yes, first no) posts a small
  reply: `Bob took the first YES position on market #1 — who's
  countering?` with a `Counter` button that opens the opposite-side
  modal prefilled with an equal amount.
- Subsequent bets are silent to avoid spam.

All of this lives on the market's existing thread/message so the
channel doesn't become a ticker tape.

## Security + rate limits

- Alpha Vantage / Polygon / Polymarket / Kalshi tokens live in `.env`
  next to `LEETIFY_API_KEY`.
- Per-source rate limits enforced in the resolver: track last-fetch
  timestamp in `resolver_state`; skip if called too soon.
- Stocks: don't poll during exchange holidays (cache holiday list
  once from upstream if they expose one, else a static JSON).
- External mirrors: hash the upstream response; skip DB write if
  unchanged to keep resolver_state quiet.

## Open questions

- **Who picks the resolver at create time?** Only guild admins, or
  anyone? A bad resolver (typo in steamId) wastes the pool. Probably
  safer to gate creation of `resolver_kind != null` markets on
  ManageGuild permission, at least until it's proven. Manual markets
  stay open to everyone.
- **Mirror odds display** — show Polymarket's implied probability (or
  current yes price) on our embed, or just the question? Showing
  their odds is informative but might telegraph a lopsided book and
  suppress our own pool. Start without; add if it feels missing.
- **CS win prediction vs post-fact resolution** — currently CS bets
  are post-fact (market resolves after the match). A live in-match
  market (bet mid-game on the current round winner) would need a
  separate infrastructure. Skip for v1.
- **Cross-asset arbitrage** — if we mirror Polymarket with shekels,
  players could theoretically build pari-mutuel strategies across our
  pool vs theirs. Fine for fun, but worth noting as a "feature" in
  the embed description so people don't feel rugged when the mirror
  closes at an unexpected time.

## Task breakdown

Replace existing task #5 with these:

**#5.1 Resolver abstraction + schema**
- Columns on bets, Drizzle schema, migration via ALTER
- Resolver registry + types
- Poller with per-resolver error isolation
- Market embed shows the resolver description + "auto-resolves" line

**#5.2 CS resolvers**
- Piggyback on `cs:match-completed` for next-match-* kinds
- Poll-based for premier-milestone + win-streak
- `/market cs-next-match` + `/market cs-premier` subcommands

**#5.3 Stock resolvers**
- Alpha Vantage client (cached, rate-limited)
- Price-above / price-below / pct-move kinds
- `/market stock` subcommand

**#5.4 External mirror — Polymarket**
- Gamma API client
- Mirror resolver kind + state-diff-based updates
- `/market mirror source:polymarket ref:slug` subcommand with preview
- Link in the embed to the upstream market

**#5.5 External mirror — Kalshi**
- Kalshi API client (auth required)
- Kalshi mirror kind
- Same subcommand flow

**#5.6 Challenge markets**
- `challenge_target_discord_id` + `challenge_accept_by` columns
- `/market challenge` subcommand
- Embed copy + expiry side-effect (flip to public)

**#5.7 Activity pings**
- Guild config: `activity_pings BOOLEAN`
- Listener on bet placement: post once on first-yes / first-no
- `Counter` button that pre-fills the opposite-side modal

## Scope notes

- Skip: combinatorial markets (A wins AND B doesn't), market makers,
  order books, limit orders, anything with non-binary outcomes.
- Favour: resolvers that tie to data we already have (CS watcher,
  snapshots table, player_streaks). Upstream-dependent ones are worth
  having but are strictly secondary — ship CS first.
