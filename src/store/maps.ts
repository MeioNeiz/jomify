import { desc, eq, sql } from "drizzle-orm";
import db from "../db.js";
import { matches, matchStats } from "../schema.js";

export interface MapStats {
  mapName: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
}

/**
 * Matches where *every* listed steamId was on the same team.
 * Complex shape (subquery + GROUP BY HAVING) kept as raw SQL.
 */
export function getTeamMapStats(steamIds: string[]): MapStats[] {
  if (steamIds.length === 0) return [];

  const count = steamIds.length;
  const ids = sql.join(
    steamIds.map((id) => sql`${id}`),
    sql`, `,
  );

  const rows = db.all<{
    map_name: string;
    wins: number;
    losses: number;
    total: number;
  }>(sql`
    SELECT
      m.map_name,
      MAX(CASE
        WHEN ms1.team_number = 2 AND m.team1_score > m.team2_score THEN 1
        WHEN ms1.team_number = 3 AND m.team2_score > m.team1_score THEN 1
        ELSE 0
      END) AS wins,
      MAX(CASE
        WHEN ms1.team_number = 2 AND m.team1_score < m.team2_score THEN 1
        WHEN ms1.team_number = 3 AND m.team2_score < m.team1_score THEN 1
        ELSE 0
      END) AS losses,
      1 AS total
    FROM matches m
    JOIN match_stats ms1 ON ms1.match_id = m.match_id
    WHERE ms1.steam_id IN (${ids})
      AND ms1.match_id IN (
        SELECT ms2.match_id
        FROM match_stats ms2
        WHERE ms2.steam_id IN (${ids})
        GROUP BY ms2.match_id, ms2.team_number
        HAVING COUNT(DISTINCT ms2.steam_id) = ${count}
      )
    GROUP BY m.map_name, ms1.match_id
    HAVING COUNT(DISTINCT ms1.steam_id) = ${count}
  `);

  const byMap = new Map<string, { wins: number; losses: number; total: number }>();
  for (const r of rows) {
    const cur = byMap.get(r.map_name) ?? { wins: 0, losses: 0, total: 0 };
    cur.wins += r.wins;
    cur.losses += r.losses;
    cur.total += 1;
    byMap.set(r.map_name, cur);
  }

  return [...byMap.entries()]
    .map(([mapName, s]) => ({
      mapName,
      wins: s.wins,
      losses: s.losses,
      total: s.total,
      winRate: s.total ? (s.wins / s.total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

export function getPlayerMapStats(steamId: string): MapStats[] {
  const rows = db
    .select({
      mapName: matches.mapName,
      wins: sql<number>`SUM(CASE
        WHEN ${matchStats.teamNumber} = 2 AND ${matches.team1Score} > ${matches.team2Score} THEN 1
        WHEN ${matchStats.teamNumber} = 3 AND ${matches.team2Score} > ${matches.team1Score} THEN 1
        ELSE 0
      END)`,
      losses: sql<number>`SUM(CASE
        WHEN ${matchStats.teamNumber} = 2 AND ${matches.team1Score} < ${matches.team2Score} THEN 1
        WHEN ${matchStats.teamNumber} = 3 AND ${matches.team2Score} < ${matches.team1Score} THEN 1
        ELSE 0
      END)`,
      total: sql<number>`COUNT(*)`,
    })
    .from(matchStats)
    .innerJoin(matches, eq(matches.matchId, matchStats.matchId))
    .where(eq(matchStats.steamId, steamId))
    .groupBy(matches.mapName)
    .orderBy(desc(sql`COUNT(*)`))
    .all();

  return rows.map((r) => ({
    mapName: r.mapName,
    wins: r.wins,
    losses: r.losses,
    total: r.total,
    winRate: r.total ? (r.wins / r.total) * 100 : 0,
  }));
}
