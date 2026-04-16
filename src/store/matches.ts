import db from "../db.js";
import type { LeetifyMatchDetails, LeetifyPlayerStats } from "../leetify/types.js";

// ── Processed matches ──

export function isMatchProcessed(matchId: string, steamId: string): boolean {
  const row = db
    .query(
      `SELECT 1 FROM processed_matches
       WHERE match_id = ? AND steam_id = ?`,
    )
    .get(matchId, steamId);
  return !!row;
}

export function markMatchProcessed(
  matchId: string,
  steamId: string,
  finishedAt: string,
): void {
  db.run(
    `INSERT OR IGNORE INTO processed_matches
       (match_id, steam_id, finished_at) VALUES (?, ?, ?)`,
    [matchId, steamId, finishedAt],
  );
}

// ── Match data ──

export function getProcessedMatchCount(steamId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) as count
       FROM processed_matches
       WHERE steam_id = ?`,
    )
    .get(steamId) as { count: number };
  return row.count;
}

export function getStoredMatchCount(steamId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) as count
       FROM match_stats WHERE steam_id = ?`,
    )
    .get(steamId) as { count: number };
  return row.count;
}

export function isMatchStored(matchId: string): boolean {
  const row = db.query("SELECT 1 FROM matches WHERE match_id = ?").get(matchId);
  return !!row;
}

export function saveMatchDetails(match: LeetifyMatchDetails): void {
  const [t1, t2] = match.team_scores;

  db.run(
    `INSERT OR IGNORE INTO matches
       (match_id, finished_at, data_source,
        data_source_match_id, map_name,
        team1_score, team2_score,
        has_banned_player, replay_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      match.id,
      match.finished_at,
      match.data_source,
      match.data_source_match_id,
      match.map_name,
      t1.score,
      t2.score,
      match.has_banned_player ? 1 : 0,
      match.replay_url ?? null,
    ],
  );

  const insert = db.prepare(
    `INSERT OR IGNORE INTO match_stats
       (match_id, steam_id, name, team_number,
        total_kills, total_deaths, total_assists,
        kd_ratio, dpr, total_damage,
        leetify_rating, ct_leetify_rating,
        t_leetify_rating, accuracy_head,
        spray_accuracy, flashbang_hit_friend,
        flashbang_hit_foe, flashbang_thrown,
        multi3k, multi4k, multi5k,
        rounds_count, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertAll = db.transaction((players: LeetifyPlayerStats[]) => {
    for (const p of players) {
      insert.run(
        match.id,
        p.steam64_id,
        p.name,
        p.initial_team_number,
        p.total_kills,
        p.total_deaths,
        p.total_assists,
        p.kd_ratio,
        p.dpr,
        p.total_damage,
        p.leetify_rating,
        p.ct_leetify_rating,
        p.t_leetify_rating,
        p.accuracy_head,
        p.spray_accuracy,
        p.flashbang_hit_friend,
        p.flashbang_hit_foe,
        p.flashbang_thrown,
        p.multi3k,
        p.multi4k,
        p.multi5k,
        p.rounds_count,
        JSON.stringify(p),
      );
    }
  });
  insertAll(match.stats);
}

export function getPlayerMatchStats(
  steamId: string,
  limit = 20,
): {
  matchId: string;
  mapName: string;
  finishedAt: string;
  raw: LeetifyPlayerStats;
}[] {
  const rows = db
    .query(
      `SELECT ms.match_id, m.map_name, m.finished_at,
              ms.raw
       FROM match_stats ms
       JOIN matches m ON m.match_id = ms.match_id
       WHERE ms.steam_id = ?
       ORDER BY m.finished_at DESC
       LIMIT ?`,
    )
    .all(steamId, limit) as {
    match_id: string;
    map_name: string;
    finished_at: string;
    raw: string;
  }[];

  return rows.map((r) => ({
    matchId: r.match_id,
    mapName: r.map_name,
    finishedAt: r.finished_at,
    raw: JSON.parse(r.raw) as LeetifyPlayerStats,
  }));
}

/** Get matches within the last N hours. */
export function getRecentMatchesSince(
  steamId: string,
  hours: number,
): {
  matchId: string;
  mapName: string;
  finishedAt: string;
  raw: LeetifyPlayerStats;
}[] {
  const rows = db
    .query(
      `SELECT ms.match_id, m.map_name, m.finished_at, ms.raw
       FROM match_stats ms
       JOIN matches m ON m.match_id = ms.match_id
       WHERE ms.steam_id = ?
         AND m.finished_at >= datetime('now', '-' || ? || ' hours')
       ORDER BY m.finished_at DESC`,
    )
    .all(steamId, hours) as {
    match_id: string;
    map_name: string;
    finished_at: string;
    raw: string;
  }[];

  return rows.map((r) => ({
    matchId: r.match_id,
    mapName: r.map_name,
    finishedAt: r.finished_at,
    raw: JSON.parse(r.raw) as LeetifyPlayerStats,
  }));
}

/** Latest finished_at (ISO, UTC) across the given steam IDs, or null. */
export function getMostRecentMatchTime(steamIds: string[]): string | null {
  if (!steamIds.length) return null;
  const placeholders = steamIds.map(() => "?").join(",");
  const row = db
    .query(
      `SELECT MAX(m.finished_at) as latest
       FROM matches m
       JOIN match_stats ms ON ms.match_id = m.match_id
       WHERE ms.steam_id IN (${placeholders})`,
    )
    .get(...steamIds) as { latest: string | null } | null;
  return row?.latest ?? null;
}

// ── Player stat averages ──

export function getPlayerStatAverages(steamId: string): Record<string, number> | null {
  const row = db
    .query(
      `SELECT
         AVG(total_kills) as avg_kills,
         AVG(total_deaths) as avg_deaths,
         AVG(kd_ratio) as avg_kd,
         AVG(dpr) as avg_dpr,
         AVG(leetify_rating) as avg_rating,
         AVG(accuracy_head) as avg_hs,
         AVG(spray_accuracy) as avg_spray,
         AVG(CAST(flashbang_hit_friend AS REAL)
           / NULLIF(flashbang_thrown, 0))
           as avg_team_flash_rate,
         AVG(flashbang_hit_foe)
           as avg_flash_enemies,
         AVG(json_extract(
           raw, '$.he_foes_damage_avg'))
           as avg_he_damage,
         AVG(json_extract(
           raw, '$.utility_on_death_avg'))
           as avg_util_on_death,
         COUNT(*) as match_count
       FROM match_stats
       WHERE steam_id = ?`,
    )
    .get(steamId) as Record<string, number> | null;
  return row;
}
