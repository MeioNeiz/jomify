import db from "../db.js";

// ── Head-to-head ──

export interface HeadToHeadResult {
  sharedMatches: number;
  sameTeamMatches: number;
  sameTeamWins: number;
  sameTeamLosses: number;
  sameTeamDraws: number;
}

export function getHeadToHead(steamId1: string, steamId2: string): HeadToHeadResult {
  const rows = db
    .query(
      `SELECT
         ms1.match_id,
         ms1.team_number AS team1,
         ms2.team_number AS team2,
         m.team1_score,
         m.team2_score
       FROM match_stats ms1
       JOIN match_stats ms2
         ON ms1.match_id = ms2.match_id
       JOIN matches m
         ON m.match_id = ms1.match_id
       WHERE ms1.steam_id = ?
         AND ms2.steam_id = ?`,
    )
    .all(steamId1, steamId2) as {
    match_id: string;
    team1: number;
    team2: number;
    team1_score: number;
    team2_score: number;
  }[];

  let sameTeamMatches = 0;
  let sameTeamWins = 0;
  let sameTeamLosses = 0;
  let sameTeamDraws = 0;

  for (const r of rows) {
    if (r.team1 !== r.team2) continue;
    sameTeamMatches++;

    const teamScore = r.team1 === 1 ? r.team1_score : r.team2_score;
    const oppScore = r.team1 === 1 ? r.team2_score : r.team1_score;

    if (teamScore > oppScore) sameTeamWins++;
    else if (teamScore < oppScore) sameTeamLosses++;
    else sameTeamDraws++;
  }

  return {
    sharedMatches: rows.length,
    sameTeamMatches,
    sameTeamWins,
    sameTeamLosses,
    sameTeamDraws,
  };
}

// ── Analysed opponents ──

export function isOpponentAnalysed(matchId: string, steamId: string): boolean {
  const row = db
    .query(
      `SELECT 1 FROM analysed_opponents
       WHERE match_id = ? AND steam_id = ?`,
    )
    .get(matchId, steamId);
  return !!row;
}

export function markOpponentAnalysed(matchId: string, steamId: string): void {
  db.run(
    `INSERT OR IGNORE INTO analysed_opponents
       (match_id, steam_id) VALUES (?, ?)`,
    [matchId, steamId],
  );
}

// ── API usage ──

export function trackApiCall(endpoint: string): void {
  db.run(
    `INSERT INTO api_usage (endpoint, day, count)
     VALUES (?, date('now'), 1)
     ON CONFLICT(endpoint, day) DO UPDATE
       SET count = count + 1`,
    [endpoint],
  );
}

export function getApiUsage(days = 7): {
  endpoint: string;
  day: string;
  count: number;
}[] {
  return db
    .query(
      `SELECT endpoint, day, count FROM api_usage
       WHERE day >= date('now', '-' || ? || ' days')
       ORDER BY day DESC, count DESC`,
    )
    .all(days) as {
    endpoint: string;
    day: string;
    count: number;
  }[];
}

export function getApiUsageToday(): {
  endpoint: string;
  count: number;
}[] {
  return db
    .query(
      `SELECT endpoint, count FROM api_usage
       WHERE day = date('now')
       ORDER BY count DESC`,
    )
    .all() as { endpoint: string; count: number }[];
}
