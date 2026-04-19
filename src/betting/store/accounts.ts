import { eq } from "drizzle-orm";
import { STARTING_BALANCE } from "../config.js";
import db from "../db.js";
import { accounts, ledger } from "../schema.js";

export function getBalance(discordId: string): number {
  const row = db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.discordId, discordId))
    .get();
  return row?.balance ?? 0;
}

/**
 * Lazy-create the wallet with STARTING_BALANCE and a matching
 * starting-grant ledger row. Idempotent: a no-op when the account
 * already exists. Callers that just need the account to exist (e.g.
 * `/bet balance` on a first-time user) should prefer this over
 * adjustBalance(id, 0, …) for intent clarity.
 */
export function ensureAccount(discordId: string): void {
  db.transaction((tx) => {
    const existing = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.discordId, discordId))
      .get();
    if (existing) return;
    tx.insert(accounts).values({ discordId, balance: STARTING_BALANCE }).run();
    tx.insert(ledger)
      .values({ discordId, delta: STARTING_BALANCE, reason: "starting-grant", ref: null })
      .run();
  });
}

/**
 * Mutate balance + append one ledger row in the same transaction. No
 * balance ever changes without an audit row, so summing the ledger
 * must equal the accounts row — tests can assert this invariant.
 *
 * Floors at 0: a negative delta that would drive the balance below
 * zero is clamped to whatever would land at 0, and the ledger row
 * reflects the clamped delta (not the requested one). So penalty
 * grants from the CS listener never throw even on a broke player.
 *
 * Callers that need a hard "can't afford" check (e.g. `/bet place`)
 * should check getBalance before calling — placeWager does this
 * inline inside its own transaction.
 */
export function adjustBalance(
  discordId: string,
  delta: number,
  reason: string,
  ref: string | null = null,
): number {
  return db.transaction((tx) => {
    // ensureAccount inline — avoids a second transaction and keeps the
    // mutation atomic for the caller.
    const existing = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.discordId, discordId))
      .get();
    const startBalance = existing?.balance;
    if (startBalance == null) {
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
    const current = startBalance ?? STARTING_BALANCE;
    const effectiveDelta = Math.max(delta, -current);
    const next = current + effectiveDelta;
    if (effectiveDelta === 0) return next; // no-op, skip the writes
    tx.update(accounts)
      .set({ balance: next })
      .where(eq(accounts.discordId, discordId))
      .run();
    tx.insert(ledger).values({ discordId, delta: effectiveDelta, reason, ref }).run();
    return next;
  });
}
