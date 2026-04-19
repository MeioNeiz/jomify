import { and, desc, eq, sql } from "drizzle-orm";
import db from "../db.js";
import { accounts, bets, ledger, wagers } from "../schema.js";

export type Outcome = "yes" | "no";
export type BetStatus = "open" | "resolved" | "cancelled";

export type Bet = {
  id: number;
  guildId: string;
  question: string;
  creatorDiscordId: string;
  status: BetStatus;
  winningOutcome: Outcome | null;
  createdAt: string;
  resolvedAt: string | null;
};

export function createBet(
  guildId: string,
  creatorDiscordId: string,
  question: string,
): number {
  const row = db
    .insert(bets)
    .values({ guildId, question, creatorDiscordId, status: "open" })
    .returning({ id: bets.id })
    .get();
  return row.id;
}

export function getBet(id: number): Bet | null {
  const row = db.select().from(bets).where(eq(bets.id, id)).get();
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guildId,
    question: row.question,
    creatorDiscordId: row.creatorDiscordId,
    status: row.status as BetStatus,
    winningOutcome: (row.winningOutcome as Outcome | null) ?? null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

/** Open bets in a guild, newest first. */
export function listOpenBets(guildId: string): Bet[] {
  const rows = db
    .select()
    .from(bets)
    .where(and(eq(bets.guildId, guildId), eq(bets.status, "open")))
    .orderBy(desc(bets.createdAt))
    .all();
  return rows.map((row) => ({
    id: row.id,
    guildId: row.guildId,
    question: row.question,
    creatorDiscordId: row.creatorDiscordId,
    status: row.status as BetStatus,
    winningOutcome: (row.winningOutcome as Outcome | null) ?? null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  }));
}

/**
 * Resolve a bet to the given outcome and pay out winners pari-mutuel:
 * each winner gets their stake back plus a proportional slice of the
 * losing pool. Edge cases:
 *   - no winners → losers are refunded (bet behaves as a no-op)
 *   - no losers → winners just get their stake back
 *
 * Integer math: the losing pool is distributed by integer floor, so a
 * small remainder (at most winners_count − 1 credits) stays in the
 * house. Acceptable for v1; revisit if users complain about rounding.
 *
 * Lives in bets.ts even though it writes to accounts + ledger + wagers
 * inline: the whole payout must share one transaction for atomicity,
 * so the bet-lifecycle module owns the reads into sibling tables.
 */
export function resolveBet(betId: number, winningOutcome: Outcome): void {
  db.transaction((tx) => {
    const bet = tx.select().from(bets).where(eq(bets.id, betId)).get();
    if (!bet) throw new Error(`Bet ${betId} does not exist`);
    if (bet.status !== "open") throw new Error(`Bet ${betId} is not open`);

    const rows = tx.select().from(wagers).where(eq(wagers.betId, betId)).all();
    const winners = rows.filter((w) => w.outcome === winningOutcome);
    const losers = rows.filter((w) => w.outcome !== winningOutcome);
    const winnerPool = winners.reduce((s, w) => s + w.amount, 0);
    const loserPool = losers.reduce((s, w) => s + w.amount, 0);

    if (winners.length === 0) {
      // No one picked the winning side — refund losers rather than
      // burning their stakes.
      for (const w of losers) {
        const acct = tx
          .select({ balance: accounts.balance })
          .from(accounts)
          .where(eq(accounts.discordId, w.discordId))
          .get();
        const current = acct?.balance ?? 0;
        tx.update(accounts)
          .set({ balance: current + w.amount })
          .where(eq(accounts.discordId, w.discordId))
          .run();
        tx.insert(ledger)
          .values({
            discordId: w.discordId,
            delta: w.amount,
            reason: "bet-refund",
            ref: String(betId),
          })
          .run();
      }
    } else {
      for (const w of winners) {
        // Share of loser pool proportional to this wager's share of
        // the winner pool. Integer floor — remainder stays in the house.
        const winnings =
          winnerPool > 0 ? Math.floor((w.amount * loserPool) / winnerPool) : 0;
        const payout = w.amount + winnings;
        const acct = tx
          .select({ balance: accounts.balance })
          .from(accounts)
          .where(eq(accounts.discordId, w.discordId))
          .get();
        const current = acct?.balance ?? 0;
        tx.update(accounts)
          .set({ balance: current + payout })
          .where(eq(accounts.discordId, w.discordId))
          .run();
        tx.insert(ledger)
          .values({
            discordId: w.discordId,
            delta: payout,
            reason: "bet-payout",
            ref: String(betId),
          })
          .run();
      }
    }

    tx.update(bets)
      .set({
        status: "resolved",
        winningOutcome,
        resolvedAt: sql`(datetime('now'))`,
      })
      .where(eq(bets.id, betId))
      .run();
  });
}
