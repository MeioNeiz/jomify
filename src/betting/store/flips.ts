// 1v1 coin-flip challenge store. Public embed + Accept / Decline with
// stake held in escrow. All balance moves go through the ledger, same
// contract as placeWager / resolveBet: no balance mutation without a
// matching ledger row, and the per-flip net across all participants
// is zero (stake moves challenger → winner; refund nets to zero).
//
// Status machine:
//   open → accepted  (target clicked Accept, coin flipped, winner paid)
//   open → declined  (target clicked Decline; stake refunded to challenger)
//   open → expired   (lazy: Accept after expiry refunds instead; the
//                     background watcher also sweeps these)
import { and, eq, lte, or, sql } from "drizzle-orm";
import db from "../db.js";
import { accounts, flips, ledger } from "../schema.js";

export type FlipStatus = "open" | "accepted" | "declined" | "expired";
export type FlipSide = "heads" | "tails";

export type Flip = {
  id: number;
  guildId: string;
  challengerId: string;
  targetId: string;
  amount: number;
  status: FlipStatus;
  winnerId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string;
  channelId: string | null;
  messageId: string | null;
};

export type AcceptResult =
  | { kind: "won"; winnerId: string; loserId: string; side: FlipSide; amount: number }
  | { kind: "expired" }
  | { kind: "gone" }
  | { kind: "insufficient-funds"; balance: number; needed: number };

type FlipRow = typeof flips.$inferSelect;

function toFlip(row: FlipRow): Flip {
  return {
    id: row.id,
    guildId: row.guildId,
    challengerId: row.challengerId,
    targetId: row.targetId,
    amount: row.amount,
    status: row.status as FlipStatus,
    winnerId: row.winnerId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    expiresAt: row.expiresAt,
    channelId: row.channelId,
    messageId: row.messageId,
  };
}

function nowSqlIso(offsetMs: number): string {
  // Match the existing `datetime('now')` format — UTC, second precision.
  return new Date(Date.now() + offsetMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\..+$/, "");
}

/**
 * Open a flip. Debits the challenger immediately and writes a
 * `flip-stake` ledger row in the same transaction. Throws on
 * insufficient balance — caller should pre-check for a friendlier
 * error message, this is belt-and-braces.
 */
export function openFlip(args: {
  guildId: string;
  challengerId: string;
  targetId: string;
  amount: number;
  expiresInMs: number;
}): number {
  const { guildId, challengerId, targetId, amount, expiresInMs } = args;
  if (amount <= 0) throw new Error("Amount must be positive");
  if (challengerId === targetId) throw new Error("Can't flip yourself");

  return db.transaction((tx) => {
    const acct = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.discordId, challengerId), eq(accounts.guildId, guildId)))
      .get();
    const current = acct?.balance ?? 0;
    if (current < amount) {
      throw new Error(`Insufficient balance: have ${current}, need ${amount}`);
    }
    tx.update(accounts)
      .set({ balance: current - amount })
      .where(and(eq(accounts.discordId, challengerId), eq(accounts.guildId, guildId)))
      .run();

    const row = tx
      .insert(flips)
      .values({
        guildId,
        challengerId,
        targetId,
        amount,
        status: "open",
        expiresAt: nowSqlIso(expiresInMs),
      })
      .returning({ id: flips.id })
      .get();

    tx.insert(ledger)
      .values({
        discordId: challengerId,
        guildId,
        delta: -amount,
        reason: "flip-stake",
        ref: String(row.id),
      })
      .run();

    return row.id;
  });
}

export function getFlip(id: number): Flip | null {
  const row = db.select().from(flips).where(eq(flips.id, id)).get();
  return row ? toFlip(row) : null;
}

/**
 * Current open flip in which `discordId` is either challenger or
 * target, scoped to this guild. Used to enforce the one-open-challenge
 * rule before opening a new one. Returns the newest open flip if
 * somehow more than one exists.
 */
export function getOpenFlipForUser(discordId: string, guildId: string): Flip | null {
  const row = db
    .select()
    .from(flips)
    .where(
      and(
        eq(flips.guildId, guildId),
        eq(flips.status, "open"),
        or(eq(flips.challengerId, discordId), eq(flips.targetId, discordId)),
      ),
    )
    .orderBy(sql`${flips.id} DESC`)
    .get();
  return row ? toFlip(row) : null;
}

/** Last accepted flip this user was in. Used for the 60s cooldown. */
export function getLastAcceptedFlipForUser(
  discordId: string,
  guildId: string,
): Flip | null {
  const row = db
    .select()
    .from(flips)
    .where(
      and(
        eq(flips.guildId, guildId),
        eq(flips.status, "accepted"),
        or(eq(flips.challengerId, discordId), eq(flips.targetId, discordId)),
      ),
    )
    .orderBy(sql`${flips.resolvedAt} DESC`)
    .get();
  return row ? toFlip(row) : null;
}

/**
 * Stamp the Discord message pointer on the flip. Called right after the
 * initial embed post so the expiry sweeper can edit the same message
 * when it reaps.
 */
export function setFlipMessage(
  flipId: number,
  channelId: string,
  messageId: string,
): void {
  db.update(flips).set({ channelId, messageId }).where(eq(flips.id, flipId)).run();
}

/**
 * Accept the flip. Rolls the coin inside the transaction using the
 * caller-supplied `side` (heads = challenger wins, tails = target
 * wins), credits the winner the full 2x stake, writes `flip-win` on
 * the winner's ledger, and flips status to 'accepted'. Lazy-expires
 * if the deadline has passed: refunds the challenger and returns
 * { kind: "expired" }.
 */
export function acceptFlip(flipId: number, side: FlipSide): AcceptResult {
  return db.transaction((tx) => {
    const row = tx.select().from(flips).where(eq(flips.id, flipId)).get();
    if (!row) return { kind: "gone" };
    if (row.status !== "open") return { kind: "gone" };

    // Lazy expiry: treat as an expire-and-refund if the deadline has
    // passed. Keeps us correct even if the background watcher is down.
    if (row.expiresAt <= nowSqlIso(0)) {
      refundAndMark(tx, row, "expired");
      return { kind: "expired" };
    }

    const winnerId = side === "heads" ? row.challengerId : row.targetId;
    const loserId = side === "heads" ? row.targetId : row.challengerId;

    // The target wagered nothing up front — they need the funds now.
    // Short-circuit cleanly so the UI can show a friendly message and
    // the challenger's stake is refunded.
    const targetAcct = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.discordId, row.targetId), eq(accounts.guildId, row.guildId)))
      .get();
    const targetBalance = targetAcct?.balance ?? 0;
    if (targetBalance < row.amount) {
      refundAndMark(tx, row, "declined");
      return {
        kind: "insufficient-funds",
        balance: targetBalance,
        needed: row.amount,
      };
    }

    // Debit the loser's stake and credit the winner the full pot.
    tx.update(accounts)
      .set({ balance: targetBalance - row.amount })
      .where(and(eq(accounts.discordId, row.targetId), eq(accounts.guildId, row.guildId)))
      .run();
    tx.insert(ledger)
      .values({
        discordId: row.targetId,
        guildId: row.guildId,
        delta: -row.amount,
        reason: "flip-stake",
        ref: String(flipId),
      })
      .run();

    const winnerAcct = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.discordId, winnerId), eq(accounts.guildId, row.guildId)))
      .get();
    const winnerBalance = winnerAcct?.balance ?? 0;
    // The challenger's row already exists (stake debit created it).
    // The target's row exists for the same reason if they were debited
    // just above. Winner is one of the two — the row is always there.
    tx.update(accounts)
      .set({ balance: winnerBalance + row.amount * 2 })
      .where(and(eq(accounts.discordId, winnerId), eq(accounts.guildId, row.guildId)))
      .run();
    tx.insert(ledger)
      .values({
        discordId: winnerId,
        guildId: row.guildId,
        delta: row.amount * 2,
        reason: "flip-win",
        ref: String(flipId),
      })
      .run();

    tx.update(flips)
      .set({
        status: "accepted",
        winnerId,
        resolvedAt: sql`(datetime('now'))`,
      })
      .where(eq(flips.id, flipId))
      .run();

    return {
      kind: "won",
      winnerId,
      loserId,
      side,
      amount: row.amount,
    };
  });
}

/**
 * Decline the challenge. Refunds the challenger's stake and marks the
 * flip 'declined'. Idempotent: no-op on already-closed flips.
 */
export function declineFlip(flipId: number): Flip | null {
  return db.transaction((tx) => {
    const row = tx.select().from(flips).where(eq(flips.id, flipId)).get();
    if (!row || row.status !== "open") return row ? toFlip(row) : null;
    refundAndMark(tx, row, "declined");
    const after = tx.select().from(flips).where(eq(flips.id, flipId)).get();
    return after ? toFlip(after) : null;
  });
}

/**
 * Mark an open flip as expired and refund the challenger. Called by
 * the background sweeper. Idempotent.
 */
export function expireFlip(flipId: number): Flip | null {
  return db.transaction((tx) => {
    const row = tx.select().from(flips).where(eq(flips.id, flipId)).get();
    if (!row || row.status !== "open") return row ? toFlip(row) : null;
    refundAndMark(tx, row, "expired");
    const after = tx.select().from(flips).where(eq(flips.id, flipId)).get();
    return after ? toFlip(after) : null;
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function refundAndMark(tx: Tx, row: FlipRow, status: "declined" | "expired"): void {
  const acct = tx
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(
      and(eq(accounts.discordId, row.challengerId), eq(accounts.guildId, row.guildId)),
    )
    .get();
  // The stake debit always created the account row; fall back to 0
  // defensively (e.g. admin nuked the wallet mid-flight).
  const current = acct?.balance ?? 0;
  tx.update(accounts)
    .set({ balance: current + row.amount })
    .where(
      and(eq(accounts.discordId, row.challengerId), eq(accounts.guildId, row.guildId)),
    )
    .run();
  tx.insert(ledger)
    .values({
      discordId: row.challengerId,
      guildId: row.guildId,
      delta: row.amount,
      reason: "flip-refund",
      ref: String(row.id),
    })
    .run();
  tx.update(flips)
    .set({ status, resolvedAt: sql`(datetime('now'))` })
    .where(eq(flips.id, row.id))
    .run();
}

/**
 * Open flips whose deadline has passed. Returned with the message
 * pointer so the sweeper can edit the original embed after reaping.
 */
export function getExpiredOpenFlips(): Array<{
  id: number;
  channelId: string | null;
  messageId: string | null;
}> {
  return db
    .select({
      id: flips.id,
      channelId: flips.channelId,
      messageId: flips.messageId,
    })
    .from(flips)
    .where(and(eq(flips.status, "open"), lte(flips.expiresAt, sql`datetime('now')`)))
    .all();
}
