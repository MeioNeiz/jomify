// Premier rating milestone market: resolves YES as soon as the player's
// post-match Premier rating reaches or exceeds the target in any match
// after the market opened, and NO at the deadline otherwise.
//
// Premier ratings are stamped onto match_stats.premier_after by the CS
// watcher. Markets created before any Premier data is recorded will stay
// pending until a qualifying match lands. Excluded from the auto-cancel
// sweep (see getExpiredOpenBets) so this resolver can apply the NO verdict
// itself.
import { getMatchWithPremierAbove } from "../../cs/store.js";
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

type PremierMilestoneArgs = { steamId: string; target: number };

function parseArgs(raw: unknown): PremierMilestoneArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.steamId !== "string" || typeof o.target !== "number") return null;
  return { steamId: o.steamId, target: o.target };
}

register({
  kind: "cs:premier-milestone",
  describe: (raw) => {
    const args = parseArgs(raw);
    if (!args) return "Auto-resolves on Premier milestone.";
    return `YES if Premier rating reaches ${args.target.toLocaleString()} before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parseArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };

    const hit = getMatchWithPremierAbove(args.steamId, ctx.bet.createdAt, args.target);
    if (hit) {
      return {
        kind: "resolve",
        outcome: "yes",
        note: `Premier reached ${hit.premier.toLocaleString()} (≥ ${args.target.toLocaleString()}) on ${hit.mapName}.`,
      };
    }

    if (ctx.bet.expiresAt) {
      const expiry = new Date(`${ctx.bet.expiresAt}Z`);
      if (ctx.now >= expiry) {
        return {
          kind: "resolve",
          outcome: "no",
          note: `Deadline passed without reaching Premier ${args.target.toLocaleString()}.`,
        };
      }
    }

    return { kind: "pending" };
  },
});
