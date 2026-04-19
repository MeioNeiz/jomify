import { desc, eq } from "drizzle-orm";
import db from "../db.js";
import { ledger } from "../schema.js";

export type LedgerRow = {
  id: number;
  steamId: string;
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
};

/** Recent ledger entries for a user, newest first. */
export function getRecentLedger(steamId: string, limit = 10): LedgerRow[] {
  return db
    .select()
    .from(ledger)
    .where(eq(ledger.steamId, steamId))
    .orderBy(desc(ledger.at))
    .limit(limit)
    .all();
}
