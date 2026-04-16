import db from "../db.js";

// ── Tracked players ──

export function getTrackedPlayers(guildId: string): string[] {
  const rows = db
    .query("SELECT steam_id FROM tracked_players WHERE guild_id = ?")
    .all(guildId) as { steam_id: string }[];
  return rows.map((r) => r.steam_id);
}

export function getAllTrackedSteamIds(): string[] {
  const rows = db.query("SELECT DISTINCT steam_id FROM tracked_players").all() as {
    steam_id: string;
  }[];
  return rows.map((r) => r.steam_id);
}

export function getGuildsForSteamId(steamId: string): string[] {
  const rows = db
    .query("SELECT guild_id FROM tracked_players WHERE steam_id = ?")
    .all(steamId) as { guild_id: string }[];
  return rows.map((r) => r.guild_id);
}

export function addTrackedPlayer(guildId: string, steamId: string): void {
  db.run(
    `INSERT OR IGNORE INTO tracked_players
       (guild_id, steam_id) VALUES (?, ?)`,
    [guildId, steamId],
  );
}

export function removeTrackedPlayer(guildId: string, steamId: string): void {
  db.run(
    `DELETE FROM tracked_players
     WHERE guild_id = ? AND steam_id = ?`,
    [guildId, steamId],
  );
}
