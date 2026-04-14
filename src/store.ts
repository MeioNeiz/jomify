import db from "./db.js";

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

// ── Tracked players ──

export function getTrackedPlayers(
  guildId: string
): string[] {
  const rows = db
    .query(
      "SELECT steam_id FROM tracked_players WHERE guild_id = ?"
    )
    .all(guildId) as { steam_id: string }[];
  return rows.map((r) => r.steam_id);
}

export function getAllTrackedSteamIds(): string[] {
  const rows = db
    .query(
      "SELECT DISTINCT steam_id FROM tracked_players"
    )
    .all() as { steam_id: string }[];
  return rows.map((r) => r.steam_id);
}

export function getGuildsForSteamId(
  steamId: string
): string[] {
  const rows = db
    .query(
      "SELECT guild_id FROM tracked_players WHERE steam_id = ?"
    )
    .all(steamId) as { guild_id: string }[];
  return rows.map((r) => r.guild_id);
}

export function addTrackedPlayer(
  guildId: string,
  steamId: string
): void {
  db.run(
    `INSERT OR IGNORE INTO tracked_players
       (guild_id, steam_id) VALUES (?, ?)`,
    [guildId, steamId]
  );
}

export function removeTrackedPlayer(
  guildId: string,
  steamId: string
): void {
  db.run(
    `DELETE FROM tracked_players
     WHERE guild_id = ? AND steam_id = ?`,
    [guildId, steamId]
  );
}

// ── Linked accounts ──

export function linkAccount(
  discordId: string,
  steamId: string
): void {
  db.run(
    `INSERT OR REPLACE INTO linked_accounts
       (discord_id, steam_id) VALUES (?, ?)`,
    [discordId, steamId]
  );
}

export function getSteamId(
  discordId: string
): string | null {
  const row = db
    .query(
      "SELECT steam_id FROM linked_accounts WHERE discord_id = ?"
    )
    .get(discordId) as { steam_id: string } | null;
  return row?.steam_id ?? null;
}

export function getDiscordId(
  steamId: string
): string | null {
  const row = db
    .query(
      "SELECT discord_id FROM linked_accounts WHERE steam_id = ?"
    )
    .get(steamId) as { discord_id: string } | null;
  return row?.discord_id ?? null;
}

export function getAllLinkedAccounts(): {
  discordId: string;
  steamId: string;
}[] {
  const rows = db
    .query("SELECT discord_id, steam_id FROM linked_accounts")
    .all() as { discord_id: string; steam_id: string }[];
  return rows.map((r) => ({
    discordId: r.discord_id,
    steamId: r.steam_id,
  }));
}

// ── Processed matches ──

export function isMatchProcessed(
  matchId: string,
  steamId: string
): boolean {
  const row = db
    .query(
      `SELECT 1 FROM processed_matches
       WHERE match_id = ? AND steam_id = ?`
    )
    .get(matchId, steamId);
  return !!row;
}

export function markMatchProcessed(
  matchId: string,
  steamId: string,
  finishedAt: string
): void {
  db.run(
    `INSERT OR IGNORE INTO processed_matches
       (match_id, steam_id, finished_at) VALUES (?, ?, ?)`,
    [matchId, steamId, finishedAt]
  );
}

// ── Guild config ──

export function setNotifyChannel(
  guildId: string,
  channelId: string
): void {
  db.run(
    `INSERT OR REPLACE INTO guild_config
       (guild_id, notify_channel_id) VALUES (?, ?)`,
    [guildId, channelId]
  );
}

export function getNotifyChannel(
  guildId: string
): string | null {
  const row = db
    .query(
      `SELECT notify_channel_id FROM guild_config
       WHERE guild_id = ?`
    )
    .get(guildId) as { notify_channel_id: string } | null;
  return row?.notify_channel_id ?? null;
}

// ── Snapshots ──

export function saveSnapshots(
  snapshots: PlayerSnapshot[]
): void {
  const insert = db.prepare(
    `INSERT INTO snapshots
       (steam_id, name, premier, leetify,
        aim, positioning, utility, clutch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMany = db.transaction(
    (items: PlayerSnapshot[]) => {
      for (const s of items) {
        insert.run(
          s.steamId, s.name, s.premier, s.leetify,
          s.aim, s.positioning, s.utility, s.clutch
        );
      }
    }
  );
  insertMany(snapshots);
}

// ── Leaderboard snapshots ──

export function saveLeaderboardSnapshot(
  guildId: string,
  entries: { steamId: string; premier: number | null }[]
): void {
  const insert = db.prepare(
    `INSERT INTO leaderboard_snapshots
       (guild_id, steam_id, premier) VALUES (?, ?, ?)`
  );
  const insertMany = db.transaction(
    (items: typeof entries) => {
      for (const e of items) {
        insert.run(guildId, e.steamId, e.premier);
      }
    }
  );
  insertMany(entries);
}

export function getLastLeaderboard(
  guildId: string
): { steamId: string; premier: number | null }[] {
  // Get the most recent snapshot timestamp for this guild
  const latest = db
    .query(
      `SELECT recorded_at FROM leaderboard_snapshots
       WHERE guild_id = ?
       ORDER BY recorded_at DESC LIMIT 1`
    )
    .get(guildId) as { recorded_at: string } | null;

  if (!latest) return [];

  const rows = db
    .query(
      `SELECT steam_id, premier FROM leaderboard_snapshots
       WHERE guild_id = ? AND recorded_at = ?`
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

// ── Match data ──

import type {
  LeetifyMatchDetails,
  LeetifyPlayerStats,
} from "./leetify/types.js";

export function getProcessedMatchCount(
  steamId: string
): number {
  const row = db
    .query(
      `SELECT COUNT(*) as count FROM processed_matches
       WHERE steam_id = ?`
    )
    .get(steamId) as { count: number };
  return row.count;
}

export function isMatchStored(matchId: string): boolean {
  const row = db
    .query("SELECT 1 FROM matches WHERE match_id = ?")
    .get(matchId);
  return !!row;
}

export function saveMatchDetails(
  match: LeetifyMatchDetails
): void {
  if (isMatchStored(match.id)) return;

  const [t1, t2] = match.team_scores;

  db.run(
    `INSERT OR IGNORE INTO matches
       (match_id, finished_at, data_source,
        data_source_match_id, map_name,
        team1_score, team2_score,
        has_banned_player, replay_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      match.id, match.finished_at, match.data_source,
      match.data_source_match_id, match.map_name,
      t1.score, t2.score,
      match.has_banned_player ? 1 : 0,
      match.replay_url ?? null,
    ]
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
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction(
    (players: LeetifyPlayerStats[]) => {
      for (const p of players) {
        insert.run(
          match.id, p.steam64_id, p.name,
          p.initial_team_number,
          p.total_kills, p.total_deaths,
          p.total_assists, p.kd_ratio, p.dpr,
          p.total_damage, p.leetify_rating,
          p.ct_leetify_rating, p.t_leetify_rating,
          p.accuracy_head, p.spray_accuracy,
          p.flashbang_hit_friend, p.flashbang_hit_foe,
          p.flashbang_thrown, p.multi3k, p.multi4k,
          p.multi5k, p.rounds_count,
          JSON.stringify(p)
        );
      }
    }
  );
  insertAll(match.stats);
}

export function getPlayerMatchStats(
  steamId: string,
  limit = 20
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
       LIMIT ?`
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

export function getPlayerStatAverages(
  steamId: string
): Record<string, number> | null {
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
         COUNT(*) as match_count
       FROM match_stats
       WHERE steam_id = ?`
    )
    .get(steamId) as Record<string, number> | null;
  return row;
}
