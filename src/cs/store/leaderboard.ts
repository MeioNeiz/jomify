import { and, desc, eq, sql } from "drizzle-orm";
import db from "../../db.js";
import { leaderboardSnapshots, snapshots } from "../../schema.js";

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

export function saveSnapshots(items: PlayerSnapshot[]): void {
  if (!items.length) return;
  db.transaction((tx) => {
    for (const s of items) {
      tx.insert(snapshots)
        .values({
          steamId: s.steamId,
          name: s.name,
          premier: s.premier,
          leetify: s.leetify,
          aim: s.aim,
          positioning: s.positioning,
          utility: s.utility,
          clutch: s.clutch,
        })
        .run();
    }
  });
}

export function saveLeaderboardSnapshot(
  guildId: string,
  entries: { steamId: string; premier: number | null }[],
): void {
  if (!entries.length) return;
  db.transaction((tx) => {
    for (const e of entries) {
      tx.insert(leaderboardSnapshots)
        .values({ guildId, steamId: e.steamId, premier: e.premier })
        .run();
    }
  });
}

export type LeaderboardPrev = {
  recordedAt: string | null;
  entries: { steamId: string; premier: number | null }[];
};

/**
 * Returns the leaderboard snapshot strictly before the supplied cutoff.
 * Used by /leaderboard so the cached render can still show rank arrows
 * (compare cached-snapshot to the one before it) when Leetify is down.
 */
export function getLeaderboardBefore(guildId: string, cutoff: string): LeaderboardPrev {
  const prev = db
    .select({ recordedAt: leaderboardSnapshots.recordedAt })
    .from(leaderboardSnapshots)
    .where(
      and(
        eq(leaderboardSnapshots.guildId, guildId),
        sql`${leaderboardSnapshots.recordedAt} < ${cutoff}`,
      ),
    )
    .orderBy(desc(leaderboardSnapshots.recordedAt))
    .limit(1)
    .get();
  if (!prev) return { recordedAt: null, entries: [] };

  const entries = db
    .select({
      steamId: leaderboardSnapshots.steamId,
      premier: leaderboardSnapshots.premier,
    })
    .from(leaderboardSnapshots)
    .where(
      and(
        eq(leaderboardSnapshots.guildId, guildId),
        eq(leaderboardSnapshots.recordedAt, prev.recordedAt),
      ),
    )
    .all();
  return { recordedAt: prev.recordedAt, entries };
}

export function getLastLeaderboard(guildId: string): LeaderboardPrev {
  const latest = db
    .select({ recordedAt: leaderboardSnapshots.recordedAt })
    .from(leaderboardSnapshots)
    .where(eq(leaderboardSnapshots.guildId, guildId))
    .orderBy(desc(leaderboardSnapshots.recordedAt))
    .limit(1)
    .get();
  if (!latest) return { recordedAt: null, entries: [] };

  const entries = db
    .select({
      steamId: leaderboardSnapshots.steamId,
      premier: leaderboardSnapshots.premier,
    })
    .from(leaderboardSnapshots)
    .where(
      and(
        eq(leaderboardSnapshots.guildId, guildId),
        eq(leaderboardSnapshots.recordedAt, latest.recordedAt),
      ),
    )
    .all();
  return { recordedAt: latest.recordedAt, entries };
}

/** Complex: joins latest snapshot name per steam_id via window function. */
export function getLastLeaderboardWithNames(guildId: string): {
  entries: { name: string; steamId: string; premier: number | null }[];
  recordedAt: string | null;
} {
  const latest = db
    .select({ recordedAt: leaderboardSnapshots.recordedAt })
    .from(leaderboardSnapshots)
    .where(eq(leaderboardSnapshots.guildId, guildId))
    .orderBy(desc(leaderboardSnapshots.recordedAt))
    .limit(1)
    .get();
  if (!latest) return { entries: [], recordedAt: null };

  const rows = db.all<{ steam_id: string; premier: number | null; name: string }>(sql`
    SELECT ls.steam_id, ls.premier,
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
    WHERE ls.guild_id = ${guildId}
      AND ls.recorded_at = ${latest.recordedAt}
  `);

  return {
    entries: rows.map((r) => ({
      name: r.name,
      steamId: r.steam_id,
      premier: r.premier,
    })),
    recordedAt: latest.recordedAt,
  };
}

export function getLatestSnapshot(
  steamId: string,
): (PlayerSnapshot & { recordedAt: string }) | null {
  const row = db
    .select()
    .from(snapshots)
    .where(eq(snapshots.steamId, steamId))
    .orderBy(desc(snapshots.recordedAt))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    steamId: row.steamId,
    name: row.name,
    premier: row.premier,
    leetify: row.leetify,
    aim: row.aim ?? 0,
    positioning: row.positioning ?? 0,
    utility: row.utility ?? 0,
    clutch: row.clutch ?? 0,
    recordedAt: row.recordedAt,
  };
}

/** Snapshot nearest to 7 days ago (uses julianday math). */
export function getWeekAgoLeaderboard(
  guildId: string,
): { steamId: string; premier: number | null }[] {
  const rows = db.all<{ steam_id: string; premier: number | null }>(sql`
    SELECT steam_id, premier FROM leaderboard_snapshots
    WHERE guild_id = ${guildId}
      AND recorded_at = (
        SELECT recorded_at FROM leaderboard_snapshots
        WHERE guild_id = ${guildId}
        ORDER BY ABS(julianday(recorded_at) - julianday('now', '-7 days'))
        LIMIT 1
      )
  `);
  return rows.map((r) => ({ steamId: r.steam_id, premier: r.premier }));
}
