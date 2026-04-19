// Auto-resolvers keyed on the subject player's next match after the
// market opened. Three flavours: outcome (win → yes), Leetify rating
// threshold, and total kills threshold.
//
// All three share a single shape of args and a single lookup path —
// the CS store tells us the first saved match strictly after
// bet.createdAt for the given steamId. That read is cheap (indexed
// join) and idempotent, so we don't bother with resolver_state for
// these kinds. When the watcher saves a freshly-finished match the
// resolver sees it on the next poll tick; the event-bus fast-path can
// come later.
import { getFirstMatchAfter } from "../../cs/store.js";
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

type NextMatchArgs = {
  steamId: string;
  // Only used by rating-above + kills-above kinds.
  threshold?: number;
};

function parseArgs(raw: unknown): NextMatchArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.steamId !== "string") return null;
  const threshold = typeof o.threshold === "number" ? o.threshold : undefined;
  return { steamId: o.steamId, threshold };
}

function nextMatch(ctx: ResolverContext): ReturnType<typeof getFirstMatchAfter> {
  const args = parseArgs(ctx.args);
  if (!args) return null;
  // bet.createdAt is SQLite's space-separated format; getFirstMatchAfter
  // normalises via datetime() so either format compares correctly.
  return getFirstMatchAfter(args.steamId, ctx.bet.createdAt);
}

// Mirrors the outcome fallback the CS watcher uses — a finished match
// in the match_stats table has rounds_won vs rounds_lost on the self
// row, and that's sufficient to decide win/loss.
function outcomeFromMatch(
  match: NonNullable<ReturnType<typeof getFirstMatchAfter>>,
): "win" | "loss" | "tie" {
  const won = match.raw.rounds_won ?? 0;
  const lost = match.raw.rounds_lost ?? 0;
  if (won > lost) return "win";
  if (lost > won) return "loss";
  return "tie";
}

register({
  kind: "cs:next-match-win",
  describe: () => "Auto-resolves yes if their next match is a win.",
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const match = nextMatch(ctx);
    if (!match) return { kind: "pending" };
    const outcome = outcomeFromMatch(match);
    if (outcome === "tie") {
      return { kind: "cancel", note: `Next match tied on ${match.mapName} — refunded.` };
    }
    return {
      kind: "resolve",
      outcome: outcome === "win" ? "yes" : "no",
      note: `Next match ${outcome} on ${match.mapName}.`,
    };
  },
});

register({
  kind: "cs:next-match-rating-above",
  describe: (raw) => {
    const args = parseArgs(raw);
    if (!args || args.threshold === undefined)
      return "Auto-resolves on next-match rating";
    return `Auto-resolves yes if next-match rating ≥ ${args.threshold.toFixed(2)}`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parseArgs(ctx.args);
    if (!args || args.threshold === undefined) {
      return { kind: "cancel", note: "Missing threshold — refunded." };
    }
    const match = nextMatch(ctx);
    if (!match) return { kind: "pending" };
    const rating = match.raw.leetify_rating;
    if (typeof rating !== "number") {
      // Leetify occasionally publishes a match without a rating — treat
      // as a no-op cancel so stakers get their credits back.
      return { kind: "cancel", note: "Leetify rating unavailable — refunded." };
    }
    return {
      kind: "resolve",
      outcome: rating >= args.threshold ? "yes" : "no",
      note: `Next match rating ${rating.toFixed(2)} vs ≥ ${args.threshold.toFixed(2)}.`,
    };
  },
});

register({
  kind: "cs:next-match-kills-above",
  describe: (raw) => {
    const args = parseArgs(raw);
    if (!args || args.threshold === undefined) return "Auto-resolves on next-match kills";
    return `Auto-resolves yes if next-match kills > ${args.threshold}`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parseArgs(ctx.args);
    if (!args || args.threshold === undefined) {
      return { kind: "cancel", note: "Missing threshold — refunded." };
    }
    const match = nextMatch(ctx);
    if (!match) return { kind: "pending" };
    const kills = match.raw.total_kills;
    return {
      kind: "resolve",
      outcome: kills > args.threshold ? "yes" : "no",
      note: `Next match kills ${kills} vs > ${args.threshold}.`,
    };
  },
});
