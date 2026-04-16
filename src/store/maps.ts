import db from "../db.js";

// ── Map win rates ──

export interface MapStats {
  mapName: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
}

export function getTeamMapStats(steamIds: string[]): MapStats[] {
  if (steamIds.length === 0) return [];

  const placeholders = steamIds.map(() => "?").join(", ");
  const count = steamIds.length;

  // team_number 2 = team1_score,
  // team_number 3 = team2_score
  const rows = db
    .query(
      `SELECT
         m.map_name,
         MAX(CASE
           WHEN ms1.team_number = 2
             AND m.team1_score > m.team2_score
             THEN 1
           WHEN ms1.team_number = 3
             AND m.team2_score > m.team1_score
             THEN 1
           ELSE 0
         END) AS wins,
         MAX(CASE
           WHEN ms1.team_number = 2
             AND m.team1_score < m.team2_score
             THEN 1
           WHEN ms1.team_number = 3
             AND m.team2_score < m.team1_score
             THEN 1
           ELSE 0
         END) AS losses,
         1 AS total
       FROM matches m
       JOIN match_stats ms1
         ON ms1.match_id = m.match_id
       WHERE ms1.steam_id IN (${placeholders})
         AND ms1.match_id IN (
           SELECT ms2.match_id
           FROM match_stats ms2
           WHERE ms2.steam_id IN (${placeholders})
           GROUP BY ms2.match_id, ms2.team_number
           HAVING COUNT(DISTINCT ms2.steam_id) = ?
         )
       GROUP BY m.map_name, ms1.match_id
       HAVING COUNT(DISTINCT ms1.steam_id) = ?`,
    )
    .all(...steamIds, ...steamIds, count, count) as {
    map_name: string;
    wins: number;
    losses: number;
    total: number;
  }[];

  // Aggregate per map (query gives one row per
  // match due to GROUP BY match_id)
  const byMap = new Map<string, { wins: number; losses: number; total: number }>();
  for (const r of rows) {
    const cur = byMap.get(r.map_name) ?? {
      wins: 0,
      losses: 0,
      total: 0,
    };
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
    .query(
      `SELECT
         m.map_name,
         SUM(CASE
           WHEN ms.team_number = 2
             AND m.team1_score > m.team2_score
             THEN 1
           WHEN ms.team_number = 3
             AND m.team2_score > m.team1_score
             THEN 1
           ELSE 0
         END) AS wins,
         SUM(CASE
           WHEN ms.team_number = 2
             AND m.team1_score < m.team2_score
             THEN 1
           WHEN ms.team_number = 3
             AND m.team2_score < m.team1_score
             THEN 1
           ELSE 0
         END) AS losses,
         COUNT(*) AS total
       FROM match_stats ms
       JOIN matches m ON m.match_id = ms.match_id
       WHERE ms.steam_id = ?
       GROUP BY m.map_name
       ORDER BY total DESC`,
    )
    .all(steamId) as {
    map_name: string;
    wins: number;
    losses: number;
    total: number;
  }[];

  return rows.map((r) => ({
    mapName: r.map_name,
    wins: r.wins,
    losses: r.losses,
    total: r.total,
    winRate: r.total ? (r.wins / r.total) * 100 : 0,
  }));
}
