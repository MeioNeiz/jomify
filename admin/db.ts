// Re-exports the betting DB connection for admin use.
// Also exposes logAdminAction so every write handler can audit
// in one call without knowing the table directly.
import { desc } from "drizzle-orm";
import db from "../src/betting/db.js";
import { adminActions } from "../src/betting/schema.js";

export { db };

export type AdminActionKind =
  | "dispute-resolve"
  | "balance-adjust"
  | "market-cancel"
  | "market-create"
  | "market-reopen-cancel"
  | "market-reopen-flip";

export function logAdminAction(
  adminId: string,
  action: AdminActionKind,
  target: string,
  details: Record<string, unknown>,
): void {
  db.insert(adminActions)
    .values({ adminId, action, target, details: JSON.stringify(details) })
    .run();
}

export function recentAdminActions(limit = 10) {
  return db.select().from(adminActions).orderBy(desc(adminActions.at)).limit(limit).all();
}
