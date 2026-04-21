import { and, desc, eq, sql } from "drizzle-orm";
import { DISPUTE_COST } from "../config.js";
import db from "../db.js";
import { accounts, bets, disputes, disputeVotes, ledger, wagers } from "../schema.js";
import type { Outcome } from "./bets.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DisputeStatus = "open" | "resolved";
export type DisputeAction = "keep" | "flip" | "cancel";
export type Vote = "overturn" | "keep";

export type Dispute = {
  id: number;
  betId: number;
  openerDiscordId: string;
  reason: string;
  status: DisputeStatus;
  finalAction: DisputeAction | null;
  finalOutcome: Outcome | null;
  resolverDiscordId: string | null;
  openedAt: string;
  resolvedAt: string | null;
  channelId: string | null;
  messageId: string | null;
};

function rowToDispute(row: typeof disputes.$inferSelect): Dispute {
  return {
    id: row.id,
    betId: row.betId,
    openerDiscordId: row.openerDiscordId,
    reason: row.reason,
    status: row.status as DisputeStatus,
    finalAction: (row.finalAction as DisputeAction | null) ?? null,
    finalOutcome: (row.finalOutcome as Outcome | null) ?? null,
    resolverDiscordId: row.resolverDiscordId,
    openedAt: row.openedAt,
    resolvedAt: row.resolvedAt,
    channelId: row.channelId,
    messageId: row.messageId,
  };
}

/**
 * True iff the user has skin in this market — either created it or
 * placed a wager on it. Used to gate both "Report" and "Vote" actions
 * so drive-by voters don't swing disputes they aren't party to.
 */
export function isInvolvedInBet(betId: number, discordId: string): boolean {
  const bet = db
    .select({ creator: bets.creatorDiscordId })
    .from(bets)
    .where(eq(bets.id, betId))
    .get();
  if (!bet) return false;
  if (bet.creator === discordId) return true;
  const wager = db
    .select({ betId: wagers.betId })
    .from(wagers)
    .where(and(eq(wagers.betId, betId), eq(wagers.discordId, discordId)))
    .get();
  return !!wager;
}

/**
 * Open a new dispute on a resolved market. Atomic: deducts
 * DISPUTE_COST from the opener (clamped at balance), writes the
 * dispute row, returns it. Rejects with a human-readable message on
 * the usual guards (bet must be resolved, one open dispute per bet,
 * opener must be involved + solvent).
 */
export function openDispute(
  betId: number,
  openerDiscordId: string,
  reason: string,
): Dispute {
  return db.transaction((tx) => {
    const bet = tx.select().from(bets).where(eq(bets.id, betId)).get();
    if (!bet) throw new Error(`Market #${betId} doesn't exist.`);
    if (bet.status !== "resolved") {
      throw new Error(`Market #${betId} isn't resolved, so there's nothing to dispute.`);
    }
    const existing = tx
      .select({ id: disputes.id })
      .from(disputes)
      .where(and(eq(disputes.betId, betId), eq(disputes.status, "open")))
      .get();
    if (existing) {
      throw new Error(`Market #${betId} already has an open dispute.`);
    }

    // Involvement check (creator OR has a wager on this bet).
    const isCreator = bet.creatorDiscordId === openerDiscordId;
    const hasWager = tx
      .select({ betId: wagers.betId })
      .from(wagers)
      .where(and(eq(wagers.betId, betId), eq(wagers.discordId, openerDiscordId)))
      .get();
    if (!isCreator && !hasWager) {
      throw new Error("Only people involved in this market can dispute it.");
    }

    // Debit dispute cost (no clamp — opener must be solvent).
    const guildId = bet.guildId;
    const acct = tx
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.discordId, openerDiscordId), eq(accounts.guildId, guildId)))
      .get();
    const balance = acct?.balance ?? 0;
    if (balance < DISPUTE_COST) {
      throw new Error(
        `Opening a dispute costs ${DISPUTE_COST} shekels — you have ${balance}.`,
      );
    }
    tx.update(accounts)
      .set({ balance: balance - DISPUTE_COST })
      .where(and(eq(accounts.discordId, openerDiscordId), eq(accounts.guildId, guildId)))
      .run();
    tx.insert(ledger)
      .values({
        discordId: openerDiscordId,
        guildId,
        delta: -DISPUTE_COST,
        reason: "dispute-open",
        ref: String(betId),
      })
      .run();

    const row = tx
      .insert(disputes)
      .values({
        betId,
        openerDiscordId,
        reason,
        status: "open",
      })
      .returning()
      .get();
    return rowToDispute(row);
  });
}

export function getDispute(disputeId: number): Dispute | null {
  const row = db.select().from(disputes).where(eq(disputes.id, disputeId)).get();
  return row ? rowToDispute(row) : null;
}

export function getOpenDisputeForBet(betId: number): Dispute | null {
  const row = db
    .select()
    .from(disputes)
    .where(and(eq(disputes.betId, betId), eq(disputes.status, "open")))
    .orderBy(desc(disputes.openedAt))
    .limit(1)
    .get();
  return row ? rowToDispute(row) : null;
}

export function setDisputeMessage(
  disputeId: number,
  channelId: string,
  messageId: string,
): void {
  db.update(disputes)
    .set({ channelId, messageId })
    .where(eq(disputes.id, disputeId))
    .run();
}

/** Upsert a vote. Re-voting overwrites the previous vote for this user. */
export function voteOnDispute(disputeId: number, discordId: string, vote: Vote): void {
  db.transaction((tx) => {
    tx.delete(disputeVotes)
      .where(
        and(eq(disputeVotes.disputeId, disputeId), eq(disputeVotes.discordId, discordId)),
      )
      .run();
    tx.insert(disputeVotes).values({ disputeId, discordId, vote }).run();
  });
}

export type VoteTally = {
  overturn: number;
  keep: number;
  voters: Array<{ discordId: string; vote: Vote }>;
};

export function getDisputeVotes(disputeId: number): VoteTally {
  const rows = db
    .select({ discordId: disputeVotes.discordId, vote: disputeVotes.vote })
    .from(disputeVotes)
    .where(eq(disputeVotes.disputeId, disputeId))
    .all();
  let overturn = 0;
  let keep = 0;
  for (const r of rows) {
    if (r.vote === "overturn") overturn++;
    else if (r.vote === "keep") keep++;
  }
  return {
    overturn,
    keep,
    voters: rows.map((r) => ({ discordId: r.discordId, vote: r.vote as Vote })),
  };
}

/**
 * Mark a dispute resolved. The opener's filing fee is refunded in the
 * same transaction iff the action is `flip` or `cancel` — i.e. the
 * dispute was upheld. On `keep` the fee is forfeit. The underlying
 * bet adjustment (reopenBet + resolveBet/cancelBet) is applied by the
 * caller, kept separate so each function has a single concern.
 */
export function markDisputeResolved(
  disputeId: number,
  action: DisputeAction,
  outcome: Outcome | null,
  resolverDiscordId: string,
): void {
  db.transaction((tx) => {
    const d = tx.select().from(disputes).where(eq(disputes.id, disputeId)).get();
    if (!d) throw new Error(`Dispute #${disputeId} doesn't exist.`);
    tx.update(disputes)
      .set({
        status: "resolved",
        finalAction: action,
        finalOutcome: outcome,
        resolverDiscordId,
        resolvedAt: sql`(datetime('now'))`,
      })
      .where(eq(disputes.id, disputeId))
      .run();
    if (action === "flip" || action === "cancel") {
      refundDisputeFee(tx, d.betId, d.openerDiscordId, disputeId);
    }
  });
}

function refundDisputeFee(
  tx: Tx,
  betId: number,
  openerDiscordId: string,
  disputeId: number,
): void {
  const bet = tx
    .select({ guildId: bets.guildId })
    .from(bets)
    .where(eq(bets.id, betId))
    .get();
  if (!bet) return;
  const guildId = bet.guildId;
  const acct = tx
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(and(eq(accounts.discordId, openerDiscordId), eq(accounts.guildId, guildId)))
    .get();
  // openDispute's debit always created the row; fall back to 0 defensively.
  const current = acct?.balance ?? 0;
  tx.update(accounts)
    .set({ balance: current + DISPUTE_COST })
    .where(and(eq(accounts.discordId, openerDiscordId), eq(accounts.guildId, guildId)))
    .run();
  tx.insert(ledger)
    .values({
      discordId: openerDiscordId,
      guildId,
      delta: DISPUTE_COST,
      reason: "dispute-fee-refund",
      ref: String(disputeId),
    })
    .run();
}
