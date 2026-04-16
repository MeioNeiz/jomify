import db from "../db.js";

// ── Player streaks ──

export interface PlayerStreak {
  steamId: string;
  streakType: "win" | "loss";
  streakCount: number;
  lastAlertedCount: number;
}

export function getPlayerStreak(steamId: string): PlayerStreak | null {
  const row = db
    .query(
      `SELECT steam_id, streak_type, streak_count,
              last_alerted_count
       FROM player_streaks WHERE steam_id = ?`,
    )
    .get(steamId) as {
    steam_id: string;
    streak_type: string;
    streak_count: number;
    last_alerted_count: number;
  } | null;
  if (!row) return null;
  return {
    steamId: row.steam_id,
    streakType: row.streak_type as "win" | "loss",
    streakCount: row.streak_count,
    lastAlertedCount: row.last_alerted_count,
  };
}

export function updatePlayerStreak(
  steamId: string,
  outcome: "win" | "loss" | "tie",
): PlayerStreak {
  const current = getPlayerStreak(steamId);

  if (outcome === "tie") {
    db.run(
      `INSERT INTO player_streaks
         (steam_id, streak_type, streak_count,
          last_alerted_count, updated_at)
       VALUES (?, 'win', 0, 0, datetime('now'))
       ON CONFLICT(steam_id) DO UPDATE SET
         streak_type = 'win', streak_count = 0,
         last_alerted_count = 0,
         updated_at = datetime('now')`,
      [steamId],
    );
    return {
      steamId,
      streakType: "win",
      streakCount: 0,
      lastAlertedCount: 0,
    };
  }

  let newCount: number;
  let lastAlerted: number;

  if (current && current.streakType === outcome) {
    newCount = current.streakCount + 1;
    lastAlerted = current.lastAlertedCount;
  } else {
    newCount = 1;
    lastAlerted = 0;
  }

  db.run(
    `INSERT INTO player_streaks
       (steam_id, streak_type, streak_count,
        last_alerted_count, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(steam_id) DO UPDATE SET
       streak_type = ?,
       streak_count = ?,
       last_alerted_count = ?,
       updated_at = datetime('now')`,
    [steamId, outcome, newCount, lastAlerted, outcome, newCount, lastAlerted],
  );

  return {
    steamId,
    streakType: outcome,
    streakCount: newCount,
    lastAlertedCount: lastAlerted,
  };
}

export function markStreakAlerted(steamId: string, count: number): void {
  db.run(
    `UPDATE player_streaks
     SET last_alerted_count = ?
     WHERE steam_id = ?`,
    [count, steamId],
  );
}
