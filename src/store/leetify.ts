import { eq, sql } from "drizzle-orm";
import db from "../db.js";
import { leetifyUnknown } from "../schema.js";

// Users not on Leetify stay marked for this long before we try again
// (in case they sign up).
const RECHECK_HOURS = 24;

export function markLeetifyUnknown(steamId: string): void {
  db.insert(leetifyUnknown)
    .values({ steamId })
    .onConflictDoUpdate({
      target: leetifyUnknown.steamId,
      set: { lastChecked: sql`datetime('now')` },
    })
    .run();
}

export function clearLeetifyUnknown(steamId: string): void {
  db.delete(leetifyUnknown).where(eq(leetifyUnknown.steamId, steamId)).run();
}

export function isLeetifyUnknown(steamId: string): boolean {
  const row = db
    .select({
      fresh: sql<number>`CASE WHEN last_checked > datetime('now', ${`-${RECHECK_HOURS} hours`}) THEN 1 ELSE 0 END`,
    })
    .from(leetifyUnknown)
    .where(eq(leetifyUnknown.steamId, steamId))
    .get();
  return row?.fresh === 1;
}
