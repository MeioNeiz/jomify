import { and, desc, eq } from "drizzle-orm";
import db from "../db.js";
import { ledger } from "../schema.js";

export type LedgerRow = {
  id: number;
  discordId: string;
  guildId: string;
  delta: number;
  reason: string;
  ref: string | null;
  at: string;
};

/** Recent ledger entries for a user in a guild, newest first. */
export function getRecentLedger(
  discordId: string,
  guildId: string,
  limit = 10,
): LedgerRow[] {
  return db
    .select()
    .from(ledger)
    .where(and(eq(ledger.discordId, discordId), eq(ledger.guildId, guildId)))
    .orderBy(desc(ledger.at))
    .limit(limit)
    .all();
}
