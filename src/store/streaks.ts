import { eq, sql } from "drizzle-orm";
import db from "../db.js";
import { playerStreaks } from "../schema.js";

export interface PlayerStreak {
  steamId: string;
  streakType: "win" | "loss";
  streakCount: number;
  lastAlertedCount: number;
}

const nowExpr = sql`datetime('now')`;

export function getPlayerStreak(steamId: string): PlayerStreak | null {
  const row = db
    .select()
    .from(playerStreaks)
    .where(eq(playerStreaks.steamId, steamId))
    .get();
  if (!row) return null;
  return {
    steamId: row.steamId,
    streakType: row.streakType as "win" | "loss",
    streakCount: row.streakCount,
    lastAlertedCount: row.lastAlertedCount,
  };
}

export function updatePlayerStreak(
  steamId: string,
  outcome: "win" | "loss" | "tie",
): PlayerStreak {
  const current = getPlayerStreak(steamId);

  if (outcome === "tie") {
    db.insert(playerStreaks)
      .values({
        steamId,
        streakType: "win",
        streakCount: 0,
        lastAlertedCount: 0,
        updatedAt: nowExpr as unknown as string,
      })
      .onConflictDoUpdate({
        target: playerStreaks.steamId,
        set: {
          streakType: "win",
          streakCount: 0,
          lastAlertedCount: 0,
          updatedAt: nowExpr as unknown as string,
        },
      })
      .run();
    return { steamId, streakType: "win", streakCount: 0, lastAlertedCount: 0 };
  }

  const [newCount, lastAlerted] =
    current && current.streakType === outcome
      ? [current.streakCount + 1, current.lastAlertedCount]
      : [1, 0];

  db.insert(playerStreaks)
    .values({
      steamId,
      streakType: outcome,
      streakCount: newCount,
      lastAlertedCount: lastAlerted,
      updatedAt: nowExpr as unknown as string,
    })
    .onConflictDoUpdate({
      target: playerStreaks.steamId,
      set: {
        streakType: outcome,
        streakCount: newCount,
        lastAlertedCount: lastAlerted,
        updatedAt: nowExpr as unknown as string,
      },
    })
    .run();

  return {
    steamId,
    streakType: outcome,
    streakCount: newCount,
    lastAlertedCount: lastAlerted,
  };
}

export function markStreakAlerted(steamId: string, count: number): void {
  db.update(playerStreaks)
    .set({ lastAlertedCount: count })
    .where(eq(playerStreaks.steamId, steamId))
    .run();
}
