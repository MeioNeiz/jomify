import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

const now = sql`(datetime('now'))`;

// One wallet per Discord account. Balances are integer credits (no
// decimals) to keep payouts exact and avoid floating-point drift.
// Betting is a Discord-facing feature, so identity is Discord's — the
// CS listener translates steam_id → discord_id via linked_accounts
// before calling in.
export const accounts = sqliteTable("accounts", {
  discordId: text("discord_id").primaryKey(),
  balance: integer("balance").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

// A market is always binary yes/no for v1. `guild_id` scopes
// `/market list` so servers can't see each other's pots.
// `creator_discord_id` is the only account allowed to resolve for v1
// (admin override lands later). `channel_id` + `message_id` are
// captured after the initial post so the expiry watcher can edit the
// original message to show the cancelled state. `expires_at` is the
// auto-cancel deadline; null means no expiry (resolved manually).
export const bets = sqliteTable(
  "bets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    question: text("question").notNull(),
    creatorDiscordId: text("creator_discord_id").notNull(),
    // 'open' | 'resolved' | 'cancelled'
    status: text("status").notNull(),
    // 'yes' | 'no' — only set once resolved.
    winningOutcome: text("winning_outcome"),
    createdAt: text("created_at").notNull().default(now),
    resolvedAt: text("resolved_at"),
    expiresAt: text("expires_at"),
    channelId: text("channel_id"),
    messageId: text("message_id"),
    // Auto-resolver wiring. Null on manual markets (today's default).
    // `resolverKind` is the registry key; `resolverArgs` is the static
    // JSON config captured at creation; `resolverState` is a mutable
    // scratchpad the resolver uses to stay idempotent across polls.
    resolverKind: text("resolver_kind"),
    resolverArgs: text("resolver_args"),
    resolverState: text("resolver_state"),
    // LMSR market-maker state. b=0 means legacy pari-mutuel market.
    // initialProb is the creator's starting estimate; qYes/qNo are the
    // running share counts updated on every wager.
    initialProb: real("initial_prob").notNull().default(0.5),
    b: integer("b").notNull().default(0),
    qYes: real("q_yes").notNull().default(0),
    qNo: real("q_no").notNull().default(0),
  },
  (t) => [
    index("idx_bets_guild_status").on(t.guildId, t.status),
    index("idx_bets_expires").on(t.expiresAt),
    index("idx_bets_resolver").on(t.resolverKind),
  ],
);

// One wager per (bet, discord_id). Prevents a user from hedging both
// sides on the same bet — keeps pari-mutuel math simple and stops
// "loss-farming" exploits against the match-based grant.
export const wagers = sqliteTable(
  "wagers",
  {
    betId: integer("bet_id")
      .notNull()
      .references(() => bets.id),
    discordId: text("discord_id").notNull(),
    outcome: text("outcome").notNull(), // 'yes' | 'no'
    amount: integer("amount").notNull(),
    // LMSR shares received at bet time. Each share pays 1 shekel (minus rake)
    // if this outcome resolves. 0 on legacy pari-mutuel wagers.
    shares: real("shares").notNull().default(0),
    placedAt: text("placed_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.betId, t.discordId] }),
    index("idx_wagers_bet").on(t.betId),
  ],
);

// Weekly-reset leaderboard archive. One row per (week, placer) — rank
// is 1-indexed, balance_snapshot is the balance right before the reset
// wiped everything back to STARTING_BALANCE. `weeks_won` per player is
// derived from COUNT(*) WHERE rank=1, no separate counter column.
export const weeklyWins = sqliteTable(
  "weekly_wins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    weekEnding: text("week_ending").notNull(),
    discordId: text("discord_id").notNull(),
    rank: integer("rank").notNull(),
    balanceSnapshot: integer("balance_snapshot").notNull(),
  },
  (t) => [index("idx_weekly_wins_week").on(t.weekEnding)],
);

// A dispute challenges a resolved market. Opening one costs
// DISPUTE_COST shekels and posts a vote panel so other involved
// parties can weigh in. Resolution is gated on Discord's ManageGuild
// permission — admin picks keep/flip/cancel and the store reverses
// the original payouts before re-applying the corrected outcome.
export const disputes = sqliteTable(
  "disputes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    betId: integer("bet_id")
      .notNull()
      .references(() => bets.id),
    openerDiscordId: text("opener_discord_id").notNull(),
    reason: text("reason").notNull(),
    // 'open' | 'resolved'
    status: text("status").notNull(),
    // 'keep' | 'flip' | 'cancel' — set when status flips to resolved.
    finalAction: text("final_action"),
    // 'yes' | 'no' — set only when finalAction is 'flip' or 'keep'.
    finalOutcome: text("final_outcome"),
    resolverDiscordId: text("resolver_discord_id"),
    openedAt: text("opened_at").notNull().default(now),
    resolvedAt: text("resolved_at"),
    channelId: text("channel_id"),
    messageId: text("message_id"),
  },
  (t) => [
    index("idx_disputes_bet").on(t.betId),
    index("idx_disputes_status").on(t.status),
  ],
);

// One vote per (dispute, discord_id). Re-voting overwrites. Gated at
// the handler level to users who are involved in the underlying bet
// (creator or a wager-holder).
export const disputeVotes = sqliteTable(
  "dispute_votes",
  {
    disputeId: integer("dispute_id")
      .notNull()
      .references(() => disputes.id),
    discordId: text("discord_id").notNull(),
    // 'overturn' | 'keep'
    vote: text("vote").notNull(),
    votedAt: text("voted_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.disputeId, t.discordId] })],
);

// Append-only audit trail for every balance mutation. Every adjust…
// write lands one row here in the same transaction, so the account
// balance is always reconstructable by summing the ledger.
export const ledger = sqliteTable(
  "ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    discordId: text("discord_id").notNull(),
    delta: integer("delta").notNull(),
    // 'starting-grant' | 'match' | 'bet-placed' | 'bet-payout' | 'bet-refund'
    reason: text("reason").notNull(),
    // Optional reference: bet id (for bet-*), match id (for match).
    ref: text("ref"),
    at: text("at").notNull().default(now),
  },
  (t) => [index("idx_ledger_discord_at").on(t.discordId, t.at)],
);
