// Longer-term "rating milestone" market: resolves YES as soon as the
// player posts a Leetify rating >= threshold in any match after the
// market opened, and NO at the deadline if they never do.
//
// Unlike cs-next-match-rating-above (single next match), this watches
// indefinitely and owns its own deadline resolution — the expiry watcher
// excludes this kind so it doesn't auto-cancel.
import { getMatchWithRatingAbove } from "../../cs/store.js";
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

type RatingGoalArgs = { steamId: string; threshold: number };

function parseArgs(raw: unknown): RatingGoalArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.steamId !== "string" || typeof o.threshold !== "number") return null;
  return { steamId: o.steamId, threshold: o.threshold };
}

register({
  kind: "cs:rating-goal",
  describe: (raw) => {
    const args = parseArgs(raw);
    if (!args) return "Auto-resolves on rating milestone.";
    return `YES if rating ≥ ${args.threshold.toFixed(2)} before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parseArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };

    const hit = getMatchWithRatingAbove(args.steamId, ctx.bet.createdAt, args.threshold);
    if (hit) {
      const rating = (hit.raw.leetify_rating as number | undefined)?.toFixed(2) ?? "?";
      return {
        kind: "resolve",
        outcome: "yes",
        note: `Rating ${rating} ≥ ${args.threshold.toFixed(2)} on ${hit.mapName}.`,
      };
    }

    if (ctx.bet.expiresAt) {
      const expiry = new Date(`${ctx.bet.expiresAt}Z`);
      if (ctx.now >= expiry) {
        return {
          kind: "resolve",
          outcome: "no",
          note: `Deadline passed without reaching rating ≥ ${args.threshold.toFixed(2)}.`,
        };
      }
    }

    return { kind: "pending" };
  },
});
