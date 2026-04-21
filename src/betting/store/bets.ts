import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  bFromStake,
  DEFAULT_CREATOR_STAKE,
  LMSR_RAKE,
  MIN_CREATOR_STAKE,
  perTraderBonus,
  STARTING_BALANCE,
  TRADER_BONUS_CAP,
} from "../config.js";
import db from "../db.js";
import { lmsrInitShares } from "../lmsr.js";
import { accounts, bets, ledger, wagers } from "../schema.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  // Creator-as-LP escrow. 0 on legacy rows.
  creatorStake: number;
  creatorSettled: number;
};

export type CreateBetOptions = {
  resolverKind?: string;
  resolverArgs?: unknown;
  // Creator's initial probability estimate (0 < p < 1). Defaults to 0.5.
  initialProb?: number;
  // Challenge market: target Discord user + window (default 30 min).
  challengeTargetDiscordId?: string;
  challengeAcceptByMinutes?: number;
  // Creator-LP stake. Plain integer ≥ MIN_CREATOR_STAKE. Defaults to
  // DEFAULT_CREATOR_STAKE.
  stake?: number;
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
  const stake = options.stake ?? DEFAULT_CREATOR_STAKE;
  if (!Number.isInteger(stake) || stake < MIN_CREATOR_STAKE) {
    throw new Error(`Stake must be an integer ≥ ${MIN_CREATOR_STAKE}`);
  }
  const b = bFromStake(stake);
  const { qYes, qNo } = lmsrInitShares(initialProb, b);
  const challengeAcceptBy = options.challengeTargetDiscordId
    ? new Date(Date.now() + (options.challengeAcceptByMinutes ?? 30) * 60_000)
        .toISOString()
        .replace("T", " ")
        .replace(/\..+$/, "")
    : null;
  return db.transaction((tx) => {
    // Lazy-create the creator's wallet so first-time creators land on
    // STARTING_BALANCE + starting-grant before we debit the stake.
    const existing = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.discordId, creatorDiscordId), eq(accounts.guildId, guildId)))
      .get();
    if (existing == null) {
      tx.insert(accounts)
        .values({ discordId: creatorDiscordId, guildId, balance: STARTING_BALANCE })
        .run();
      tx.insert(ledger)
        .values({
          discordId: creatorDiscordId,
          guildId,
          delta: STARTING_BALANCE,
          reason: "starting-grant",
          ref: null,
        })
        .run();
    }
    const current = existing?.balance ?? STARTING_BALANCE;
    if (current < stake) {
      throw new Error(`Insufficient balance: have ${current}, need ${stake} to stake`);
    }
    tx.update(accounts)
      .set({ balance: current - stake })
      .where(and(eq(accounts.discordId, creatorDiscordId), eq(accounts.guildId, guildId)))
      .run();
    const row = tx
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
        b,
        qYes,
        qNo,
        challengeTargetDiscordId: options.challengeTargetDiscordId ?? null,
        challengeAcceptBy,
        creatorStake: stake,
        creatorSettled: 0,
      })
      .returning({ id: bets.id })
      .get();
    tx.insert(ledger)
      .values({
        discordId: creatorDiscordId,
        guildId,
        delta: -stake,
        reason: "creator-stake",
        ref: String(row.id),
      })
      .run();
    return row.id;
  });
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
    creatorStake: row.creatorStake,
    creatorSettled: row.creatorSettled,
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

export type CreatorStats = {
  marketsCreated: number;
  stakeDeployed: number;
  lifetimeSettle: number;
  lifetimeBonus: number;
  netPnL: number;
};

/**
 * Creator-LP lifetime stats for a user in a guild. Backs `/creator-stats`
 * and the admin P&L column. Aggregates the three LP ledger reasons
 * instead of walking bets — cheaper and always agrees with balance.
 */
export function getCreatorStats(discordId: string, guildId: string): CreatorStats {
  const stakeDeployedRow = db
    .select({
      total: sql<number>`COALESCE(SUM(-${ledger.delta}), 0)`,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.discordId, discordId),
        eq(ledger.guildId, guildId),
        eq(ledger.reason, "creator-stake"),
      ),
    )
    .get();
  const settleRow = db
    .select({
      total: sql<number>`COALESCE(SUM(${ledger.delta}), 0)`,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.discordId, discordId),
        eq(ledger.guildId, guildId),
        eq(ledger.reason, "creator-settle"),
      ),
    )
    .get();
  const bonusRow = db
    .select({
      total: sql<number>`COALESCE(SUM(${ledger.delta}), 0)`,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.discordId, discordId),
        eq(ledger.guildId, guildId),
        eq(ledger.reason, "creator-trader-bonus"),
      ),
    )
    .get();
  const marketsRow = db
    .select({
      n: sql<number>`COUNT(*)`,
    })
    .from(bets)
    .where(
      and(
        eq(bets.guildId, guildId),
        eq(bets.creatorDiscordId, discordId),
        sql`${bets.creatorStake} > 0`,
      ),
    )
    .get();
  const stakeDeployed = stakeDeployedRow?.total ?? 0;
  const lifetimeSettle = settleRow?.total ?? 0;
  const lifetimeBonus = bonusRow?.total ?? 0;
  return {
    marketsCreated: marketsRow?.n ?? 0,
    stakeDeployed,
    lifetimeSettle,
    lifetimeBonus,
    netPnL: lifetimeSettle + lifetimeBonus - stakeDeployed,
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
          'cs:premier-milestone', 'cs:win-streak', 'cs:clutch-count',
          'stock:price-above', 'stock:price-below', 'stock:pct-move',
          'crypto:price-above', 'crypto:price-below', 'crypto:pct-move'
        ))`,
      ),
    )
    .all();
}

/** Credit helper scoped to a transaction + bet — inline so the same
 * transaction owns both the balance mutation and the audit row. */
function creditInTx(
  tx: Tx,
  guildId: string,
  discordId: string,
  amount: number,
  reason: string,
  ref: string,
): void {
  const acct = tx
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
    .get();
  const current = acct?.balance ?? 0;
  if (acct == null) {
    tx.insert(accounts).values({ discordId, guildId, balance: amount }).run();
  } else {
    tx.update(accounts)
      .set({ balance: current + amount })
      .where(and(eq(accounts.discordId, discordId), eq(accounts.guildId, guildId)))
      .run();
  }
  tx.insert(ledger).values({ discordId, guildId, delta: amount, reason, ref }).run();
}

/**
 * Creator-LP settlement. Pays the creator their trading P&L (stake ±
 * LMSR shortfall/rake) and the engagement bonus from protocol reserve.
 * No-op on legacy rows (creator_stake = 0) so old house-subsidy markets
 * are untouched. Idempotent via creator_settled — reopen clears the
 * flag so re-resolve can replay cleanly.
 */
function settleCreator(
  tx: Tx,
  bet: BetRow,
  mode: "cancel" | "resolve",
  winningOutcome: Outcome | null,
): void {
  if (bet.creatorSettled) return;
  if (bet.creatorStake === 0) return;

  const ws = tx.select().from(wagers).where(eq(wagers.betId, bet.id)).all();

  // Trading P&L: on cancel every wager is refunded so the pool nets
  // to zero and the creator just gets their stake back. On resolve the
  // pool minus winner payouts lands as the creator's take — bounded
  // below by 0 as the LMSR max-loss guarantee.
  let tradingPnL: number;
  if (mode === "cancel") {
    tradingPnL = bet.creatorStake;
  } else {
    const totalStakes = ws.reduce((s, w) => s + w.amount, 0);
    const totalPayouts = ws
      .filter((w) => w.outcome === winningOutcome)
      .reduce((s, w) => s + Math.floor(w.shares * (1 - LMSR_RAKE)), 0);
    tradingPnL = Math.max(0, bet.creatorStake + totalStakes - totalPayouts);
  }

  if (tradingPnL > 0) {
    creditInTx(
      tx,
      bet.guildId,
      bet.creatorDiscordId,
      tradingPnL,
      "creator-settle",
      String(bet.id),
    );
  }

  const uniqueTraders = new Set(ws.map((w) => w.discordId)).size;
  const bonus = Math.floor(
    Math.min(uniqueTraders, TRADER_BONUS_CAP) * perTraderBonus(bet.creatorStake),
  );
  if (bonus > 0) {
    creditInTx(
      tx,
      bet.guildId,
      bet.creatorDiscordId,
      bonus,
      "creator-trader-bonus",
      String(bet.id),
    );
  }

  tx.update(bets).set({ creatorSettled: 1 }).where(eq(bets.id, bet.id)).run();
}

/**
 * Resolve a bet to the given outcome.
 *
 * Creator-LP markets (creator_stake > 0): winners receive
 * floor(shares × (1 − rake)) shekels. Losers lose — creator pockets
 * the pool minus payouts as trading P&L (bounded by the stake).
 * Per-trader engagement bonus added from protocol reserve.
 *
 * Legacy LMSR (b > 0, no creator stake): same LMSR payout path but
 * losers are refunded when no one picked the winning side (old
 * house-subsidy behaviour preserved for already-open markets).
 *
 * Legacy pari-mutuel (b = 0): original proportional-split logic.
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
    const credit = (discordId: string, amount: number, reason: string) =>
      creditInTx(tx, guildId, discordId, amount, reason, String(betId));

    if (bet.creatorStake > 0) {
      // Creator-LP LMSR: winners get floor(shares × (1 − rake)).
      // Losers (including the all-loser-side case) keep nothing —
      // the pool flows to the creator via settleCreator.
      for (const w of winners) {
        const payout = Math.floor(w.shares * (1 - LMSR_RAKE));
        if (payout > 0) credit(w.discordId, payout, "bet-payout");
      }
    } else if (winners.length === 0) {
      for (const w of losers) credit(w.discordId, w.amount, "bet-refund");
    } else if (bet.b > 0) {
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

    settleCreator(tx, bet, "resolve", winningOutcome);

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
          inArray(ledger.reason, [
            "bet-payout",
            "bet-refund",
            "bet-cancel",
            "creator-settle",
            "creator-trader-bonus",
          ]),
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
    // Clear the settled flag so the next resolve/cancel re-runs
    // settleCreator with the corrected outcome.
    tx.update(bets)
      .set({
        status: "open",
        winningOutcome: null,
        resolvedAt: null,
        creatorSettled: 0,
      })
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
      creditInTx(tx, guildId, w.discordId, w.amount, "bet-cancel", String(betId));
    }
    settleCreator(tx, bet, "cancel", null);
    tx.update(bets)
      .set({ status: "cancelled", resolvedAt: sql`(datetime('now'))` })
      .where(eq(bets.id, betId))
      .run();
  });
}
