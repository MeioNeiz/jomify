import { desc, eq } from "drizzle-orm";
import db from "../db.js";
import { ledger } from "../schema.js";

export type LedgerRow = {
  id: number;
  discordId: string;
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
};

/** Recent ledger entries for a user, newest first. */
export function getRecentLedger(discordId: string, limit = 10): LedgerRow[] {
  return db
    .select()
    .from(ledger)
    .where(eq(ledger.discordId, discordId))
    .orderBy(desc(ledger.at))
    .limit(limit)
    .all();
}
