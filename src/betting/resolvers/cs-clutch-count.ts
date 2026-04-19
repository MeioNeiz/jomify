// Clutch-count market: resolves YES when the player accumulates N multikill
// plays (3k, 4k, or 5k) across matches after the market opened. NO at the
// deadline if the total is never reached. Excluded from auto-cancel.
import { getClutchCountAfter } from "../../cs/store.js";
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

type ClutchCountArgs = { steamId: string; count: number };

function parseArgs(raw: unknown): ClutchCountArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.steamId !== "string" || typeof o.count !== "number") return null;
  return { steamId: o.steamId, count: o.count };
}

register({
  kind: "cs:clutch-count",
  describe: (raw) => {
    const args = parseArgs(raw);
    if (!args) return "Auto-resolves on clutch plays.";
    return `YES if ${args.count} multikill plays (3k+) land before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parseArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };

    const current = getClutchCountAfter(args.steamId, ctx.bet.createdAt);
    if (current >= args.count) {
      return {
        kind: "resolve",
        outcome: "yes",
        note: `${args.count} multikill plays reached (${current} total).`,
      };
    }

    if (ctx.bet.expiresAt) {
      const expiry = new Date(`${ctx.bet.expiresAt}Z`);
      if (ctx.now >= expiry) {
        return {
          kind: "resolve",
          outcome: "no",
          note: `Deadline passed — ${current}/${args.count} multikill plays.`,
        };
      }
    }

    return { kind: "pending" };
  },
});
