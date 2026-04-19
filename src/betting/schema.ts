import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

// A bet is always binary yes/no for v1. `guild_id` scopes `/bet list`
// so servers can't see each other's pots. `creator_discord_id` is the
// only account allowed to resolve for v1 (admin override lands later).
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
  },
  (t) => [index("idx_bets_guild_status").on(t.guildId, t.status)],
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
