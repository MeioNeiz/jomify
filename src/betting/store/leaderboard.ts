import { desc, eq, sql } from "drizzle-orm";
import db from "../db.js";
import { accounts, weeklyWins } from "../schema.js";

/** Live top-N balances for the in-flight week. */
export function getCurrentStandings(limit = 10): { steamId: string; balance: number }[] {
  return db
    .select({ steamId: accounts.steamId, balance: accounts.balance })
    .from(accounts)
    .orderBy(desc(accounts.balance))
    .limit(limit)
    .all();
}

/**
 * All-time weekly-wins tally: one row per steam id with the number of
 * weeks they finished rank=1. Uses weekly_wins rank=1 rows as the
 * ground truth — there's no separate counter column, so the archive
 * table is always authoritative.
 */
export function getAllTimeWins(limit = 10): { steamId: string; weeksWon: number }[] {
  return db
    .select({
      steamId: weeklyWins.steamId,
      weeksWon: sql<number>`COUNT(*)`.as("weeks_won"),
    })
    .from(weeklyWins)
    .where(eq(weeklyWins.rank, 1))
    .groupBy(weeklyWins.steamId)
    .orderBy(sql`weeks_won DESC`)
    .limit(limit)
    .all();
}
