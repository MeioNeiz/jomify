// First-to markets: resolves YES the moment anyone in scope triggers
// the chosen stat milestone on a completed match. Scope is either the
// full guild's tracked players ("guild") or a hand-picked subset
// ("list"). Stats: `ace` (multi5k ≥ 1), `thirty-bomb` (totalKills ≥ 30),
// and `win-streak` (threshold consecutive wins after market open).
//
// Expiry handling: we DON'T add this kind to getExpiredOpenBets'
// exclusion list. That means the expiry watcher auto-cancels on
// deadline, refunding both sides. Functionally that's equivalent to a
// NO resolution here — nobody triggered, so nobody should profit from
// YES stakes — and it keeps this resolver simple.
//
// Creator self-dealing rule applies (creators shouldn't stake their
// own auto-resolvers on their own players); enforcement is a codebase-
// wide TODO, documented on the command handler.
//
// Future extension: a `vc` scope (only players currently in a voice
// channel) — deferred because Discord gateway voice state tracking
// isn't wired up yet.
import { getCurrentWinStreakAfter, getPlayerMatchStats } from "../../cs/store.js";
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

export type FirstToStat = "ace" | "thirty-bomb" | "win-streak";
export type FirstToScope = "guild" | "list";

export type FirstToArgs = {
  stat: FirstToStat;
  scope: FirstToScope;
  guildId: string;
  // Required if stat = win-streak. Ignored otherwise.
  threshold?: number;
  // Required if scope = list. Ignored otherwise.
  steamIds?: string[];
};

export function parseFirstToArgs(raw: unknown): FirstToArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.stat !== "ace" && o.stat !== "thirty-bomb" && o.stat !== "win-streak") {
    return null;
  }
  if (o.scope !== "guild" && o.scope !== "list") return null;
  if (typeof o.guildId !== "string") return null;
  const threshold = typeof o.threshold === "number" ? o.threshold : undefined;
  const steamIds = Array.isArray(o.steamIds)
    ? o.steamIds.filter((x): x is string => typeof x === "string")
    : undefined;
  if (o.stat === "win-streak" && (threshold === undefined || threshold < 2)) return null;
  if (o.scope === "list" && (!steamIds || steamIds.length === 0)) return null;
  return {
    stat: o.stat,
    scope: o.scope,
    guildId: o.guildId,
    threshold,
    steamIds,
  };
}

/**
 * Scope membership for a given (steamId, guildId) match event. Used by
 * the listener fast-path to decide whether a particular match belongs
 * to this market before running the condition check.
 */
export function isInScope(
  args: FirstToArgs,
  steamId: string,
  eventGuildId: string,
): boolean {
  if (args.guildId !== eventGuildId) return false;
  if (args.scope === "list") {
    return (args.steamIds ?? []).includes(steamId);
  }
  // scope = guild: the event already comes from a tracked player in
  // this guild (the CS listener only emits for tracked players), so
  // the guild match above is sufficient.
  return true;
}

/**
 * Given an already-fetched per-match stats row and the market args,
 * decide whether the match triggers the milestone. Pure — the listener
 * and the poller both feed it. Caller is responsible for the `sinceIso`
 * cut-off for win-streak (we re-read the DB for that one since streak
 * depth isn't in a single row).
 */
export function checkAceFromStats(stats: { multi5k?: number | null }): boolean {
  return (stats.multi5k ?? 0) >= 1;
}

export function checkThirtyBombFromStats(stats: {
  total_kills?: number | null;
  totalKills?: number | null;
}): boolean {
  const k = stats.total_kills ?? stats.totalKills ?? 0;
  return k >= 30;
}

function describeArgs(args: FirstToArgs): string {
  const scopeLabel =
    args.scope === "guild"
      ? "any tracked player"
      : `one of ${args.steamIds?.length} players`;
  if (args.stat === "ace") {
    return `YES if ${scopeLabel} lands an ace before deadline; NO/refund at deadline.`;
  }
  if (args.stat === "thirty-bomb") {
    return `YES if ${scopeLabel} drops 30+ kills in a match before deadline; NO/refund at deadline.`;
  }
  return `YES if ${scopeLabel} hits a ${args.threshold}-win streak before deadline; NO/refund at deadline.`;
}

/**
 * Polling fallback. Walks every steamId in scope, inspects their most
 * recent saved matches, and fires YES if any of them satisfied the
 * condition after the market opened. The listener normally beats this
 * to the punch, but the poller covers gaps (bot restart, listener skip,
 * scope = guild with a newly-tracked player).
 */
register({
  kind: "cs:first-to",
  describe: (raw) => {
    const args = parseFirstToArgs(raw);
    if (!args) return "Auto-resolves on the first player to hit the milestone.";
    return describeArgs(args);
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parseFirstToArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };

    // Who's in scope? For `list`, the market named them at creation.
    // For `guild`, we re-read tracked players every poll so someone
    // added mid-market still counts. The import is lazy to sidestep a
    // cycle at module-init time.
    const steamIds = await resolveScopeSteamIds(args);
    if (steamIds.length === 0) return { kind: "pending" };

    const since = ctx.bet.createdAt;

    for (const steamId of steamIds) {
      const hit = await findFirstHit(steamId, args, since);
      if (hit) {
        return {
          kind: "resolve",
          outcome: "yes",
          note: hit.note,
        };
      }
    }

    // No hit yet. Expiry is handled by getExpiredOpenBets' auto-cancel
    // sweep (refund both sides), which is the simpler equivalent of a
    // NO resolution for this market kind.
    return { kind: "pending" };
  },
});

async function resolveScopeSteamIds(args: FirstToArgs): Promise<string[]> {
  if (args.scope === "list") return args.steamIds ?? [];
  const { getTrackedPlayers } = await import("../../cs/store.js");
  return getTrackedPlayers(args.guildId);
}

async function findFirstHit(
  steamId: string,
  args: FirstToArgs,
  sinceIso: string,
): Promise<{ note: string } | null> {
  if (args.stat === "win-streak" && args.threshold !== undefined) {
    const streak = getCurrentWinStreakAfter(steamId, sinceIso);
    if (streak >= args.threshold) {
      return { note: `${steamId} on a ${streak}-win streak.` };
    }
    return null;
  }

  // ace / thirty-bomb: scan post-market matches for the steamId and
  // check the stats row for the condition. `getPlayerMatchStats` is
  // indexed and ordered desc with `raw` already parsed. We filter to
  // post-market matches by finishedAt string compare, normalising both
  // sides to SQLite's space-separated, fraction-stripped shape so
  // Leetify's ISO-T-with-Z sorts correctly against bet.createdAt.
  const recent = getPlayerMatchStats(steamId, 50);
  const threshold = normaliseIso(sinceIso);
  for (const row of recent) {
    if (normaliseIso(row.finishedAt) <= threshold) continue;
    const raw = row.raw;
    if (!raw) continue;
    if (args.stat === "ace" && checkAceFromStats(raw)) {
      return { note: `${steamId} aced on ${row.mapName}.` };
    }
    if (args.stat === "thirty-bomb" && checkThirtyBombFromStats(raw)) {
      return {
        note: `${steamId} went ${raw.total_kills ?? 30}+ on ${row.mapName}.`,
      };
    }
  }
  return null;
}

function normaliseIso(ts: string): string {
  // Both 'YYYY-MM-DD HH:MM:SS' (SQLite) and 'YYYY-MM-DDTHH:MM:SS...Z'
  // (Leetify) sort correctly after replacing 'T' with ' ' and
  // stripping trailing Z / fractional seconds.
  return ts.replace("T", " ").replace(/\..+$/, "").replace(/Z$/, "").trim();
}
