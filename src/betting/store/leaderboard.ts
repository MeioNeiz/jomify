import { desc, eq, sql } from "drizzle-orm";
import db from "../db.js";
import { accounts, weeklyWins } from "../schema.js";

/** Live top-N balances for the in-flight week. */
export function getCurrentStandings(
  limit = 10,
): { discordId: string; balance: number }[] {
  return db
    .select({ discordId: accounts.discordId, balance: accounts.balance })
    .from(accounts)
    .orderBy(desc(accounts.balance))
    .limit(limit)
    .all();
}

/**
 * All-time weekly-wins tally: one row per discord id with the number of
 * weeks they finished rank=1. Uses weekly_wins rank=1 rows as the
 * ground truth — there's no separate counter column, so the archive
 * table is always authoritative.
 */
export function getAllTimeWins(limit = 10): { discordId: string; weeksWon: number }[] {
  return db
    .select({
      discordId: weeklyWins.discordId,
      weeksWon: sql<number>`COUNT(*)`.as("weeks_won"),
    })
    .from(weeklyWins)
    .where(eq(weeklyWins.rank, 1))
    .groupBy(weeklyWins.discordId)
    .orderBy(sql`weeks_won DESC`)
    .limit(limit)
    .all();
}
