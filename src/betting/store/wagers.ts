import { and, eq } from "drizzle-orm";
import {
  AUTO_EXTEND_ON_BET_HOURS,
  AUTO_EXTEND_THRESHOLD_HOURS,
  STARTING_BALANCE,
} from "../config.js";
import db from "../db.js";
import { lmsrBuyShares, lmsrProb } from "../lmsr.js";
import { accounts, bets, ledger, marketTicks, wagers } from "../schema.js";
import type { Outcome } from "./bets.js";

export type Wager = {
  betId: number;
  discordId: string;
  outcome: Outcome;
  amount: number;
  shares: number; // LMSR shares; 0 on legacy pari-mutuel wagers
  placedAt: string;
};

/** All wagers on a bet. Used for pool display + payout math. */
export function getWagersForBet(betId: number): Wager[] {
  const rows = db.select().from(wagers).where(eq(wagers.betId, betId)).all();
  return rows.map((r) => ({
    betId: r.betId,
    discordId: r.discordId,
    outcome: r.outcome as Outcome,
    amount: r.amount,
    shares: r.shares,
    placedAt: r.placedAt,
  }));
}

/**
 * Lock in a wager. Atomic: deducts balance, writes ledger, inserts
 * wager row. Rejects if the bet is closed, the user already wagered
 * on this bet (see wagers PK), or the balance is insufficient.
 *
 * Lives in wagers.ts even though it writes accounts + ledger inline:
 * wager creation is the caller-facing concern, and all three writes
 * need to share a single transaction.
 */
export function placeWager(
  betId: number,
  discordId: string,
  outcome: Outcome,
  amount: number,
): void {
  if (amount <= 0) throw new Error("Amount must be positive");
  db.transaction((tx) => {
    const bet = tx.select().from(bets).where(eq(bets.id, betId)).get();
    if (!bet) throw new Error(`Bet ${betId} does not exist`);
    if (bet.status !== "open") throw new Error(`Bet ${betId} is not open`);

    const existing = tx
      .select({ betId: wagers.betId })
      .from(wagers)
      .where(and(eq(wagers.betId, betId), eq(wagers.discordId, discordId)))
      .get();
    if (existing) throw new Error("You've already wagered on this bet");

    // Inline balance debit (can't call adjustBalance — it opens its own
    // transaction). Same contract: no balance move without a ledger row.
    const guildId = bet.guildId;
    const account = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
      .get();
    const balance = account?.balance;
    if (balance == null) {
      // Lazy-create starting grant, then immediately check against it.
      tx.insert(accounts).values({ discordId, guildId, balance: STARTING_BALANCE }).run();
      tx.insert(ledger)
        .values({
          discordId,
          guildId,
          delta: STARTING_BALANCE,
          reason: "starting-grant",
          ref: null,
        })
        .run();
    }
    const current = balance ?? STARTING_BALANCE;
    if (current < amount) {
      throw new Error(`Insufficient balance: have ${current}, need ${amount}`);
    }
    tx.update(accounts)
      .set({ balance: current - amount })
      .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
      .run();
    tx.insert(ledger)
      .values({
        discordId,
        guildId,
        delta: -amount,
        reason: "bet-placed",
        ref: String(betId),
      })
      .run();

    // Compute LMSR shares and update running market state.
    const shares =
      bet.b > 0 ? lmsrBuyShares(bet.qYes, bet.qNo, bet.b, amount, outcome) : 0;

    // Build the bets update: always update LMSR state if needed, and
    // auto-extend the deadline when a wager lands close to expiry.
    const betsUpdate: Record<string, unknown> = {};
    const qYesAfter = bet.b > 0 && outcome === "yes" ? bet.qYes + shares : bet.qYes;
    const qNoAfter = bet.b > 0 && outcome === "no" ? bet.qNo + shares : bet.qNo;
    if (bet.b > 0) {
      betsUpdate.qYes = qYesAfter;
      betsUpdate.qNo = qNoAfter;
    }
    if (bet.expiresAt) {
      const expiresMs = new Date(`${bet.expiresAt}Z`).getTime();
      const thresholdMs = Date.now() + AUTO_EXTEND_THRESHOLD_HOURS * 3_600_000;
      if (expiresMs < thresholdMs) {
        const extended = new Date(Date.now() + AUTO_EXTEND_ON_BET_HOURS * 3_600_000)
          .toISOString()
          .replace("T", " ")
          .replace(/\..+$/, "");
        betsUpdate.expiresAt = extended;
      }
    }
    if (Object.keys(betsUpdate).length > 0) {
      tx.update(bets).set(betsUpdate).where(eq(bets.id, betId)).run();
    }

    tx.insert(wagers).values({ betId, discordId, outcome, amount, shares }).run();

    // Price-curve snapshot. Only LMSR markets have a price to log;
    // pari-mutuel (b=0) skips — there's no meaningful probability to
    // record and downstream chart queries are LMSR-only by design.
    if (bet.b > 0) {
      tx.insert(marketTicks)
        .values({
          betId,
          kind: "wager",
          discordId,
          outcome,
          shares,
          amount,
          qYesBefore: bet.qYes,
          qNoBefore: bet.qNo,
          qYesAfter,
          qNoAfter,
          b: bet.b,
          probYesAfter: lmsrProb(qYesAfter, qNoAfter, bet.b),
        })
        .run();
    }
  });
}
