// Open 1v1 coin-flip challenge store. Public embed + Accept / Cancel
// with stake held in escrow; anyone in the channel can accept. All
// balance moves go through the ledger, same contract as placeWager /
// resolveBet: no balance mutation without a matching ledger row, and
// the per-flip net across all participants is zero (stake moves
// challenger → winner; refund nets to zero).
//
// Status machine:
//   open → accepted  (someone accepts, coin flipped, winner paid;
//                     target_id is stamped with the accepter's id)
//   open → expired   (challenger cancels or deadline passes; stake
//                     refunded to challenger. The background watcher
//                     sweeps on a timer, and accept-after-expiry
//                     refunds-and-expires inline.)
//   (declined)       legacy status kept for historical rows only.
import { and, eq, lte, ne, or, sql } from "drizzle-orm";
import db from "../db.js";
import { InsufficientBalanceError } from "../errors.js";
import { accounts, flips, ledger } from "../schema.js";

export type FlipStatus = "open" | "accepted" | "declined" | "expired";
export type FlipSide = "heads" | "tails";

export type Flip = {
  id: number;
  guildId: string;
  challengerId: string;
  targetId: string | null;
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
  | { kind: "self" }
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
 * `flip-stake` ledger row in the same transaction. channelId is
 * stamped up front so the accept-by-/flip lookup can find it without
 * waiting for the message pointer. Throws on insufficient balance —
 * caller should pre-check for a friendlier error message, this is
 * belt-and-braces.
 */
export function openFlip(args: {
  guildId: string;
  challengerId: string;
  amount: number;
  expiresInMs: number;
  channelId?: string;
}): number {
  const { guildId, challengerId, amount, expiresInMs, channelId } = args;
  if (amount <= 0) throw new Error("Amount must be positive");

  return db.transaction((tx) => {
    const acct = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.discordId, challengerId), eq(accounts.guildId, guildId)))
      .get();
    const current = acct?.balance ?? 0;
    if (current < amount) {
      throw new InsufficientBalanceError(current, amount);
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
        targetId: null,
        amount,
        status: "open",
        expiresAt: nowSqlIso(expiresInMs),
        channelId: channelId ?? null,
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
 * Current open flip this user opened in the given guild. Used to
 * enforce the one-open-challenge rule before opening a new one.
 * Returns the newest if somehow more than one exists.
 */
export function getOpenFlipForChallenger(
  discordId: string,
  guildId: string,
): Flip | null {
  const row = db
    .select()
    .from(flips)
    .where(
      and(
        eq(flips.guildId, guildId),
        eq(flips.status, "open"),
        eq(flips.challengerId, discordId),
      ),
    )
    .orderBy(sql`${flips.id} DESC`)
    .get();
  return row ? toFlip(row) : null;
}

/**
 * Latest open flip in `channelId` not opened by `excludingUserId`.
 * Used by `/flip` (no amount) and the Accept button to pick a target.
 */
export function getLatestOpenFlipInChannel(
  channelId: string,
  excludingUserId: string,
): Flip | null {
  const row = db
    .select()
    .from(flips)
    .where(
      and(
        eq(flips.channelId, channelId),
        eq(flips.status, "open"),
        ne(flips.challengerId, excludingUserId),
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
 * when it reaps. channelId is already set at open time but we restamp
 * here for safety (and to cover older callers that don't pass it).
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
 * caller-supplied `side` (heads = challenger wins, tails = accepter
 * wins), credits the winner the full 2x stake, writes `flip-win` on
 * the winner's ledger, stamps target_id with the accepter's id, and
 * flips status to 'accepted'. Lazy-expires if the deadline has passed:
 * refunds the challenger and returns { kind: "expired" }. Refuses to
 * accept your own flip.
 */
export function acceptFlip(
  flipId: number,
  acceptorId: string,
  side: FlipSide,
): AcceptResult {
  return db.transaction((tx) => {
    const row = tx.select().from(flips).where(eq(flips.id, flipId)).get();
    if (!row) return { kind: "gone" };
    if (row.status !== "open") return { kind: "gone" };
    if (row.challengerId === acceptorId) return { kind: "self" };

    // Lazy expiry: treat as an expire-and-refund if the deadline has
    // passed. Keeps us correct even if the background watcher is down.
    if (row.expiresAt <= nowSqlIso(0)) {
      refundAndMark(tx, row, "expired");
      return { kind: "expired" };
    }

    const winnerId = side === "heads" ? row.challengerId : acceptorId;
    const loserId = side === "heads" ? acceptorId : row.challengerId;

    // The accepter wagered nothing up front — they need the funds now.
    // Short-circuit cleanly so the UI can show a friendly message and
    // the challenger's stake is refunded.
    const acceptorAcct = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.discordId, acceptorId), eq(accounts.guildId, row.guildId)))
      .get();
    const acceptorBalance = acceptorAcct?.balance ?? 0;
    if (acceptorBalance < row.amount) {
      refundAndMark(tx, row, "expired");
      return {
        kind: "insufficient-funds",
        balance: acceptorBalance,
        needed: row.amount,
      };
    }

    // Debit the accepter's stake and credit the winner the full pot.
    tx.update(accounts)
      .set({ balance: acceptorBalance - row.amount })
      .where(and(eq(accounts.discordId, acceptorId), eq(accounts.guildId, row.guildId)))
      .run();
    tx.insert(ledger)
      .values({
        discordId: acceptorId,
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
    // Challenger's row exists (stake debit created it); accepter's row
    // was just created above. Winner is one of the two — always there.
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
        targetId: acceptorId,
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
 * Cancel an open flip. Only callable by the challenger (caller enforces).
 * Refunds the stake and marks the flip 'expired'. Idempotent.
 */
export function cancelFlip(flipId: number): Flip | null {
  return db.transaction((tx) => {
    const row = tx.select().from(flips).where(eq(flips.id, flipId)).get();
    if (!row || row.status !== "open") return row ? toFlip(row) : null;
    refundAndMark(tx, row, "expired");
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
