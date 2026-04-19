// Win-streak market: resolves YES when the player achieves N consecutive
// wins in matches that finished after the market opened, NO at the deadline.
//
// Streak is computed fresh on each poll by walking match_stats in reverse
// chronological order — no dependency on the player_streaks table, so the
// result is scoped to post-market matches only. Excluded from auto-cancel
// sweep so this resolver applies the NO verdict at expiry itself.
import { getCurrentWinStreakAfter } from "../../cs/store.js";
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

type WinStreakArgs = { steamId: string; count: number };

function parseArgs(raw: unknown): WinStreakArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.steamId !== "string" || typeof o.count !== "number") return null;
  return { steamId: o.steamId, count: o.count };
}

register({
  kind: "cs:win-streak",
  describe: (raw) => {
    const args = parseArgs(raw);
    if (!args) return "Auto-resolves on win streak.";
    return `YES if they win ${args.count} matches in a row before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parseArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };

    const streak = getCurrentWinStreakAfter(args.steamId, ctx.bet.createdAt);
    if (streak >= args.count) {
      return {
        kind: "resolve",
        outcome: "yes",
        note: `${args.count}-win streak achieved (current: ${streak}).`,
      };
    }

    if (ctx.bet.expiresAt) {
      const expiry = new Date(`${ctx.bet.expiresAt}Z`);
      if (ctx.now >= expiry) {
        return {
          kind: "resolve",
          outcome: "no",
          note: `Deadline passed — ${streak}/${args.count} consecutive wins.`,
        };
      }
    }

    return { kind: "pending" };
  },
});
