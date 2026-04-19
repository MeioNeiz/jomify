import { eq } from "drizzle-orm";
import { STARTING_BALANCE } from "../config.js";
import db from "../db.js";
import { accounts, ledger } from "../schema.js";

export function getBalance(steamId: string): number {
  const row = db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.steamId, steamId))
    .get();
  return row?.balance ?? 0;
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
  steamId: string,
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
      .where(eq(accounts.steamId, steamId))
      .get();
    const startBalance = existing?.balance;
    if (startBalance == null) {
      tx.insert(accounts).values({ steamId, balance: STARTING_BALANCE }).run();
      tx.insert(ledger)
        .values({ steamId, delta: STARTING_BALANCE, reason: "starting-grant", ref: null })
        .run();
    }
    const current = startBalance ?? STARTING_BALANCE;
    const effectiveDelta = Math.max(delta, -current);
    const next = current + effectiveDelta;
    if (effectiveDelta === 0) return next; // no-op, skip the writes
    tx.update(accounts).set({ balance: next }).where(eq(accounts.steamId, steamId)).run();
    tx.insert(ledger).values({ steamId, delta: effectiveDelta, reason, ref }).run();
    return next;
  });
}
