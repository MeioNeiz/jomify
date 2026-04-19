import { and, eq } from "drizzle-orm";
import {
  AUTO_EXTEND_ON_BET_HOURS,
  AUTO_EXTEND_THRESHOLD_HOURS,
  STARTING_BALANCE,
} from "../config.js";
import db from "../db.js";
import { lmsrBuyShares } from "../lmsr.js";
import { accounts, bets, ledger, wagers } from "../schema.js";
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
    const account = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.discordId, discordId))
      .get();
    const balance = account?.balance;
    if (balance == null) {
      // Lazy-create starting grant, then immediately check against it.
      tx.insert(accounts).values({ discordId, balance: STARTING_BALANCE }).run();
      tx.insert(ledger)
        .values({
          discordId,
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
      .where(eq(accounts.discordId, discordId))
      .run();
    tx.insert(ledger)
      .values({ discordId, delta: -amount, reason: "bet-placed", ref: String(betId) })
      .run();

    // Compute LMSR shares and update running market state.
    const shares =
      bet.b > 0 ? lmsrBuyShares(bet.qYes, bet.qNo, bet.b, amount, outcome) : 0;

    // Build the bets update: always update LMSR state if needed, and
    // auto-extend the deadline when a wager lands close to expiry.
    const betsUpdate: Record<string, unknown> = {};
    if (bet.b > 0) {
      betsUpdate.qYes = outcome === "yes" ? bet.qYes + shares : bet.qYes;
      betsUpdate.qNo = outcome === "no" ? bet.qNo + shares : bet.qNo;
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
  });
}
