import { asc, eq } from "drizzle-orm";
import db from "../db.js";
import { marketTicks } from "../schema.js";
import type { Outcome } from "./bets.js";

export type TickKind = "wager" | "sell" | "resolve" | "cancel";

export type Tick = {
  id: number;
  betId: number;
  occurredAt: string;
  kind: TickKind;
  discordId: string;
  outcome: Outcome | null;
  shares: number;
  amount: number;
  qYesBefore: number;
  qNoBefore: number;
  qYesAfter: number;
  qNoAfter: number;
  b: number;
  probYesAfter: number;
};

function toTick(r: typeof marketTicks.$inferSelect): Tick {
  return {
    id: r.id,
    betId: r.betId,
    occurredAt: r.occurredAt,
    kind: r.kind as TickKind,
    discordId: r.discordId,
    outcome: (r.outcome ?? null) as Outcome | null,
    shares: r.shares,
    amount: r.amount,
    qYesBefore: r.qYesBefore,
    qNoBefore: r.qNoBefore,
    qYesAfter: r.qYesAfter,
    qNoAfter: r.qNoAfter,
    b: r.b,
    probYesAfter: r.probYesAfter,
  };
}

/** All price-changing ticks for a bet, oldest first — for chart queries. */
export function getTicksForBet(betId: number): Tick[] {
  const rows = db
    .select()
    .from(marketTicks)
    .where(eq(marketTicks.betId, betId))
    .orderBy(asc(marketTicks.occurredAt), asc(marketTicks.id))
    .all();
  return rows.map(toTick);
}

// Per-user tick history (guild-scoped via `bets`) lives in git history —
// re-add if we start surfacing personal trade logs. Kept out of the code
// while unused so knip stays happy.
