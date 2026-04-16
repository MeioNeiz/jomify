import db from "../db.js";

export interface PlayerSnapshot {
  steamId: string;
  name: string;
  premier: number | null;
  leetify: number | null;
  aim: number;
  positioning: number;
  utility: number;
  clutch: number;
}

// ── Snapshots ──

export function saveSnapshots(snapshots: PlayerSnapshot[]): void {
  const insert = db.prepare(
    `INSERT INTO snapshots
       (steam_id, name, premier, leetify,
        aim, positioning, utility, clutch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((items: PlayerSnapshot[]) => {
    for (const s of items) {
      insert.run(
        s.steamId,
        s.name,
        s.premier,
        s.leetify,
        s.aim,
        s.positioning,
        s.utility,
        s.clutch,
      );
    }
  });
  insertMany(snapshots);
}

// ── Leaderboard snapshots ──

export function saveLeaderboardSnapshot(
  guildId: string,
  entries: { steamId: string; premier: number | null }[],
): void {
  const insert = db.prepare(
    `INSERT INTO leaderboard_snapshots
       (guild_id, steam_id, premier) VALUES (?, ?, ?)`,
  );
  const insertMany = db.transaction((items: typeof entries) => {
    for (const e of items) {
      insert.run(guildId, e.steamId, e.premier);
    }
  });
  insertMany(entries);
}

export function getLastLeaderboard(
  guildId: string,
): { steamId: string; premier: number | null }[] {
  const latest = db
    .query(
      `SELECT recorded_at FROM leaderboard_snapshots
       WHERE guild_id = ?
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .get(guildId) as { recorded_at: string } | null;

  if (!latest) return [];

  const rows = db
    .query(
      `SELECT steam_id, premier FROM leaderboard_snapshots
       WHERE guild_id = ? AND recorded_at = ?`,
    )
    .all(guildId, latest.recorded_at) as {
    steam_id: string;
    premier: number | null;
  }[];

  return rows.map((r) => ({
    steamId: r.steam_id,
    premier: r.premier,
  }));
}

export function getLastLeaderboardWithNames(guildId: string): {
  entries: {
    name: string;
    steamId: string;
    premier: number | null;
  }[];
  recordedAt: string | null;
} {
  const latest = db
    .query(
      `SELECT recorded_at FROM leaderboard_snapshots
       WHERE guild_id = ?
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .get(guildId) as { recorded_at: string } | null;

  if (!latest) return { entries: [], recordedAt: null };

  const rows = db
    .query(
      `SELECT ls.steam_id, ls.premier,
              COALESCE(s.name, ls.steam_id) as name
       FROM leaderboard_snapshots ls
       LEFT JOIN (
         SELECT steam_id, name,
           ROW_NUMBER() OVER (
             PARTITION BY steam_id
             ORDER BY recorded_at DESC
           ) as rn
         FROM snapshots
       ) s ON s.steam_id = ls.steam_id AND s.rn = 1
       WHERE ls.guild_id = ?
         AND ls.recorded_at = ?`,
    )
    .all(guildId, latest.recorded_at) as {
    steam_id: string;
    premier: number | null;
    name: string;
  }[];

  return {
    entries: rows.map((r) => ({
      name: r.name,
      steamId: r.steam_id,
      premier: r.premier,
    })),
    recordedAt: latest.recorded_at,
  };
}

/** Get most recent snapshot for a player (local fallback for API). */
export function getLatestSnapshot(
  steamId: string,
): (PlayerSnapshot & { recordedAt: string }) | null {
  const row = db
    .query(
      `SELECT steam_id, name, premier, leetify,
              aim, positioning, utility, clutch, recorded_at
       FROM snapshots
       WHERE steam_id = ?
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .get(steamId) as {
    steam_id: string;
    name: string;
    premier: number | null;
    leetify: number | null;
    aim: number;
    positioning: number;
    utility: number;
    clutch: number;
    recorded_at: string;
  } | null;

  if (!row) return null;
  return {
    steamId: row.steam_id,
    name: row.name,
    premier: row.premier,
    leetify: row.leetify,
    aim: row.aim,
    positioning: row.positioning,
    utility: row.utility,
    clutch: row.clutch,
    recordedAt: row.recorded_at,
  };
}

// ── Weekly leaderboard ──

export function getWeekAgoLeaderboard(
  guildId: string,
): { steamId: string; premier: number | null }[] {
  const nearest = db
    .query(
      `SELECT recorded_at FROM leaderboard_snapshots
       WHERE guild_id = ?
       ORDER BY ABS(
         julianday(recorded_at)
         - julianday('now', '-7 days')
       ) LIMIT 1`,
    )
    .get(guildId) as { recorded_at: string } | null;

  if (!nearest) return [];

  const rows = db
    .query(
      `SELECT steam_id, premier
       FROM leaderboard_snapshots
       WHERE guild_id = ? AND recorded_at = ?`,
    )
    .all(guildId, nearest.recorded_at) as {
    steam_id: string;
    premier: number | null;
  }[];

  return rows.map((r) => ({
    steamId: r.steam_id,
    premier: r.premier,
  }));
}
