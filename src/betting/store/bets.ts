import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { LMSR_B, LMSR_RAKE } from "../config.js";
import db from "../db.js";
import { lmsrInitShares } from "../lmsr.js";
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
  expiresAt: string | null;
  channelId: string | null;
  messageId: string | null;
  resolverKind: string | null;
  resolverArgs: string | null;
  resolverState: string | null;
  // LMSR market-maker state. b=0 = legacy pari-mutuel market.
  initialProb: number;
  b: number;
  qYes: number;
  qNo: number;
  // Challenge market: null on regular markets.
  challengeTargetDiscordId: string | null;
  challengeAcceptBy: string | null;
};

export type CreateBetOptions = {
  resolverKind?: string;
  resolverArgs?: unknown;
  // Creator's initial probability estimate (0 < p < 1). Defaults to 0.5.
  initialProb?: number;
  // Challenge market: target Discord user + window (default 30 min).
  challengeTargetDiscordId?: string;
  challengeAcceptByMinutes?: number;
};

export function createBet(
  guildId: string,
  creatorDiscordId: string,
  question: string,
  expiresAt: string | null = null,
  options: CreateBetOptions = {},
): number {
  const resolverArgs =
    options.resolverArgs === undefined ? null : JSON.stringify(options.resolverArgs);
  const initialProb = options.initialProb ?? 0.5;
  const { qYes, qNo } = lmsrInitShares(initialProb, LMSR_B);
  const challengeAcceptBy = options.challengeTargetDiscordId
    ? new Date(Date.now() + (options.challengeAcceptByMinutes ?? 30) * 60_000)
        .toISOString()
        .replace("T", " ")
        .replace(/\..+$/, "")
    : null;
  const row = db
    .insert(bets)
    .values({
      guildId,
      question,
      creatorDiscordId,
      status: "open",
      expiresAt,
      resolverKind: options.resolverKind ?? null,
      resolverArgs,
      resolverState: null,
      initialProb,
      b: LMSR_B,
      qYes,
      qNo,
      challengeTargetDiscordId: options.challengeTargetDiscordId ?? null,
      challengeAcceptBy,
    })
    .returning({ id: bets.id })
    .get();
  return row.id;
}

/** Persist the resolver's scratchpad after a poll tick. */
export function setResolverState(betId: number, state: unknown): void {
  db.update(bets)
    .set({ resolverState: state === null ? null : JSON.stringify(state) })
    .where(eq(bets.id, betId))
    .run();
}

/** Open bets with an auto-resolver attached. Drives the poller. */
export function getOpenResolverBets(): Bet[] {
  const rows = db
    .select()
    .from(bets)
    .where(and(eq(bets.status, "open"), isNotNull(bets.resolverKind)))
    .all();
  return rows.map(toBet);
}

type BetRow = typeof bets.$inferSelect;

function toBet(row: BetRow): Bet {
  return {
    id: row.id,
    guildId: row.guildId,
    question: row.question,
    creatorDiscordId: row.creatorDiscordId,
    status: row.status as BetStatus,
    winningOutcome: (row.winningOutcome as Outcome | null) ?? null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    expiresAt: row.expiresAt,
    channelId: row.channelId,
    messageId: row.messageId,
    resolverKind: row.resolverKind,
    resolverArgs: row.resolverArgs,
    resolverState: row.resolverState,
    initialProb: row.initialProb,
    b: row.b,
    qYes: row.qYes,
    qNo: row.qNo,
    challengeTargetDiscordId: row.challengeTargetDiscordId,
    challengeAcceptBy: row.challengeAcceptBy,
  };
}

export function getBet(id: number): Bet | null {
  const row = db.select().from(bets).where(eq(bets.id, id)).get();
  return row ? toBet(row) : null;
}

/**
 * Push the market's deadline forward. Pass null to remove the expiry
 * entirely. Throws if the bet doesn't exist or is already closed.
 */
export function extendBet(betId: number, newExpiresAt: string | null): void {
  db.transaction((tx) => {
    const bet = tx.select().from(bets).where(eq(bets.id, betId)).get();
    if (!bet) throw new Error(`Bet ${betId} does not exist`);
    if (bet.status !== "open") throw new Error(`Bet ${betId} is not open`);
    tx.update(bets).set({ expiresAt: newExpiresAt }).where(eq(bets.id, betId)).run();
  });
}

/** Open bets in a guild, newest first. */
export function listOpenBets(guildId: string): Bet[] {
  const rows = db
    .select()
    .from(bets)
    .where(and(eq(bets.guildId, guildId), eq(bets.status, "open")))
    .orderBy(desc(bets.createdAt))
    .all();
  return rows.map(toBet);
}

/**
 * Persist the Discord message that hosts the interactive market view.
 * Called right after the initial post so the expiry watcher can edit
 * the same message when the market auto-cancels.
 */
export function setBetMessage(betId: number, channelId: string, messageId: string): void {
  db.update(bets).set({ channelId, messageId }).where(eq(bets.id, betId)).run();
}

/**
 * Open markets whose expires_at has passed. Used by the expiry watcher
 * to drive auto-cancel. Returns the message pointer so the watcher can
 * re-render the original post after cancelling.
 */
export function getExpiredOpenBets(): Array<{
  id: number;
  channelId: string | null;
  messageId: string | null;
}> {
  return db
    .select({
      id: bets.id,
      channelId: bets.channelId,
      messageId: bets.messageId,
    })
    .from(bets)
    .where(
      and(
        eq(bets.status, "open"),
        isNotNull(bets.expiresAt),
        sql`${bets.expiresAt} <= datetime('now')`,
        // Resolvers that manage their own deadline (resolve NO at expiry rather
        // than cancel) are excluded from auto-cancel so they can fire one last
        // check on the next tick and apply the NO verdict themselves.
        sql`(resolver_kind IS NULL OR resolver_kind NOT IN (
          'cs:rating-goal', 'cs:premier-milestone', 'cs:win-streak', 'cs:clutch-count',
          'stock:price-above', 'stock:price-below', 'stock:pct-move',
          'crypto:price-above', 'crypto:price-below', 'crypto:pct-move'
        ))`,
      ),
    )
    .all();
}

/**
 * Resolve a bet to the given outcome.
 *
 * LMSR markets (b > 0): each winner receives floor(shares × (1 − rake))
 * shekels. The house covers any gap between payouts due and actual stakes
 * collected; this gap is bounded at b × ln(2) ≈ 20.8 shekels for b=30.
 * A 2% rake on winning shares partially offsets the subsidy over time.
 *
 * Legacy pari-mutuel markets (b = 0): original proportional-split logic,
 * unchanged so existing open markets settle correctly.
 *
 * In both cases, if no one picked the winning side all losers are refunded.
 */
export function resolveBet(betId: number, winningOutcome: Outcome): void {
  db.transaction((tx) => {
    const bet = tx.select().from(bets).where(eq(bets.id, betId)).get();
    if (!bet) throw new Error(`Bet ${betId} does not exist`);
    if (bet.status !== "open") throw new Error(`Bet ${betId} is not open`);

    const rows = tx.select().from(wagers).where(eq(wagers.betId, betId)).all();
    const winners = rows.filter((w) => w.outcome === winningOutcome);
    const losers = rows.filter((w) => w.outcome !== winningOutcome);

    const guildId = bet.guildId;
    function credit(discordId: string, amount: number, reason: string) {
      const acct = tx
        .select({ balance: accounts.balance })
        .from(accounts)
        .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
        .get();
      const current = acct?.balance ?? 0;
      tx.update(accounts)
        .set({ balance: current + amount })
        .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
        .run();
      tx.insert(ledger)
        .values({ discordId, guildId, delta: amount, reason, ref: String(betId) })
        .run();
    }

    if (winners.length === 0) {
      for (const w of losers) credit(w.discordId, w.amount, "bet-refund");
    } else if (bet.b > 0) {
      // LMSR: each winner gets floor(shares × (1 − rake)) shekels.
      // House absorbs any shortfall (bounded by b × ln(2)).
      for (const w of winners) {
        const payout = Math.floor(w.shares * (1 - LMSR_RAKE));
        if (payout > 0) credit(w.discordId, payout, "bet-payout");
      }
    } else {
      // Legacy pari-mutuel: winners split the loser pool proportionally.
      const winnerPool = winners.reduce((s, w) => s + w.amount, 0);
      const loserPool = losers.reduce((s, w) => s + w.amount, 0);
      for (const w of winners) {
        const winnings =
          winnerPool > 0 ? Math.floor((w.amount * loserPool) / winnerPool) : 0;
        credit(w.discordId, w.amount + winnings, "bet-payout");
      }
    }

    tx.update(bets)
      .set({ status: "resolved", winningOutcome, resolvedAt: sql`(datetime('now'))` })
      .where(eq(bets.id, betId))
      .run();
  });
}

/**
 * Reverse every payout / refund / cancel ledger row for this bet and
 * flip its status back to open. Used by the dispute admin flow so we
 * can re-apply a corrected resolution from a clean slate.
 *
 * Balance floor: if a user spent their (now-reversed) winnings, we
 * claw back only as much as their current balance allows — the
 * shortfall stays forgiven. Each reversal writes a `bet-reverse`
 * ledger row with the clamped delta, preserving the sum-of-ledger =
 * balance invariant.
 */
export function reopenBet(betId: number): void {
  db.transaction((tx) => {
    const bet = tx.select().from(bets).where(eq(bets.id, betId)).get();
    if (!bet) throw new Error(`Bet ${betId} does not exist`);
    if (bet.status === "open") return;

    const guildId = bet.guildId;
    const rows = tx
      .select()
      .from(ledger)
      .where(
        and(
          eq(ledger.ref, String(betId)),
          inArray(ledger.reason, ["bet-payout", "bet-refund", "bet-cancel"]),
        ),
      )
      .all();
    for (const r of rows) {
      const acct = tx
        .select({ balance: accounts.balance })
        .from(accounts)
        .where(and(eq(accounts.discordId, r.discordId), eq(accounts.guildId, guildId)))
        .get();
      const current = acct?.balance ?? 0;
      // Want to apply -r.delta. Floor at 0: clamp to -current.
      const reversed = Math.max(-r.delta, -current);
      if (reversed === 0) continue;
      tx.update(accounts)
        .set({ balance: current + reversed })
        .where(and(eq(accounts.discordId, r.discordId), eq(accounts.guildId, guildId)))
        .run();
      tx.insert(ledger)
        .values({
          discordId: r.discordId,
          guildId,
          delta: reversed,
          reason: "bet-reverse",
          ref: String(betId),
        })
        .run();
    }
    tx.update(bets)
      .set({ status: "open", winningOutcome: null, resolvedAt: null })
      .where(eq(bets.id, betId))
      .run();
  });
}

/**
 * Refund every wager and mark the market cancelled. Idempotent — a
 * double-cancel (e.g. the watcher racing a manual cancel) short-
 * circuits without touching balances. Called by the expiry watcher
 * when a market's deadline passes without a resolution.
 */
export function cancelBet(betId: number): void {
  db.transaction((tx) => {
    const bet = tx.select().from(bets).where(eq(bets.id, betId)).get();
    if (!bet) throw new Error(`Bet ${betId} does not exist`);
    if (bet.status !== "open") return;

    const guildId = bet.guildId;
    const rows = tx.select().from(wagers).where(eq(wagers.betId, betId)).all();
    for (const w of rows) {
      const acct = tx
        .select({ balance: accounts.balance })
        .from(accounts)
        .where(and(eq(accounts.discordId, w.discordId), eq(accounts.guildId, guildId)))
        .get();
      const current = acct?.balance ?? 0;
      tx.update(accounts)
        .set({ balance: current + w.amount })
        .where(and(eq(accounts.discordId, w.discordId), eq(accounts.guildId, guildId)))
        .run();
      tx.insert(ledger)
        .values({
          discordId: w.discordId,
          guildId,
          delta: w.amount,
          reason: "bet-cancel",
          ref: String(betId),
        })
        .run();
    }
    tx.update(bets)
      .set({ status: "cancelled", resolvedAt: sql`(datetime('now'))` })
      .where(eq(bets.id, betId))
      .run();
  });
}
