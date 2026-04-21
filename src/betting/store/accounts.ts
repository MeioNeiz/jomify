import { and, eq } from "drizzle-orm";
import { STARTING_BALANCE } from "../config.js";
import db from "../db.js";
import { accounts, ledger } from "../schema.js";

export type TransferResult =
  | { kind: "ok"; senderBalance: number; recipientBalance: number }
  | { kind: "insufficient-funds"; balance: number; needed: number };

export function getBalance(discordId: string, guildId: string): number {
  const row = db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
    .get();
  return row?.balance ?? 0;
}

/**
 * Lazy-create the wallet with STARTING_BALANCE and a matching
 * starting-grant ledger row. Idempotent: a no-op when the account
 * already exists. Callers that just need the account to exist (e.g.
 * `/bet balance` on a first-time user) should prefer this over
 * adjustBalance(id, guildId, 0, …) for intent clarity.
 */
export function ensureAccount(discordId: string, guildId: string): void {
  db.transaction((tx) => {
    const existing = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
      .get();
    if (existing) return;
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
  guildId: string,
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
      .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
      .get();
    const startBalance = existing?.balance;
    if (startBalance == null) {
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
    const current = startBalance ?? STARTING_BALANCE;
    const effectiveDelta = Math.max(delta, -current);
    const next = current + effectiveDelta;
    if (effectiveDelta === 0) return next; // no-op, skip the writes
    tx.update(accounts)
      .set({ balance: next })
      .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
      .run();
    tx.insert(ledger)
      .values({ discordId, guildId, delta: effectiveDelta, reason, ref })
      .run();
    return next;
  });
}

/**
 * Move `amount` from `senderId` to `recipientId` in one transaction with
 * two ledger rows (`give-sent` / `give-received`). Both accounts are
 * lazy-initialised if missing, same as adjustBalance. Returns the new
 * balances on success, or an insufficient-funds result with no writes.
 */
export function transferBalance(
  senderId: string,
  recipientId: string,
  guildId: string,
  amount: number,
  ref: string | null = null,
): TransferResult {
  if (amount <= 0) throw new Error("Amount must be positive");
  if (senderId === recipientId) throw new Error("Can't transfer to yourself");
  return db.transaction((tx) => {
    const ensure = (discordId: string): number => {
      const existing = tx
        .select({ balance: accounts.balance })
        .from(accounts)
        .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
        .get();
      if (existing) return existing.balance;
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
      return STARTING_BALANCE;
    };
    const senderBal = ensure(senderId);
    if (senderBal < amount) {
      return { kind: "insufficient-funds", balance: senderBal, needed: amount };
    }
    const recipientBal = ensure(recipientId);
    tx.update(accounts)
      .set({ balance: senderBal - amount })
      .where(and(eq(accounts.discordId, senderId), eq(accounts.guildId, guildId)))
      .run();
    tx.update(accounts)
      .set({ balance: recipientBal + amount })
      .where(and(eq(accounts.discordId, recipientId), eq(accounts.guildId, guildId)))
      .run();
    tx.insert(ledger)
      .values({
        discordId: senderId,
        guildId,
        delta: -amount,
        reason: "give-sent",
        ref,
      })
      .run();
    tx.insert(ledger)
      .values({
        discordId: recipientId,
        guildId,
        delta: amount,
        reason: "give-received",
        ref,
      })
      .run();
    return {
      kind: "ok",
      senderBalance: senderBal - amount,
      recipientBalance: recipientBal + amount,
    };
  });
}
