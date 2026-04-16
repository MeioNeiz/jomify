import db from "../db.js";

// ── Guild config ──

export function setNotifyChannel(guildId: string, channelId: string): void {
  db.run(
    `INSERT OR REPLACE INTO guild_config
       (guild_id, notify_channel_id) VALUES (?, ?)`,
    [guildId, channelId],
  );
}

export function getNotifyChannel(guildId: string): string | null {
  const row = db
    .query(
      `SELECT notify_channel_id FROM guild_config
       WHERE guild_id = ?`,
    )
    .get(guildId) as { notify_channel_id: string } | null;
  return row?.notify_channel_id ?? null;
}

export function getAllGuildIds(): string[] {
  const rows = db
    .query(
      `SELECT guild_id FROM guild_config
       WHERE notify_channel_id IS NOT NULL`,
    )
    .all() as { guild_id: string }[];
  return rows.map((r) => r.guild_id);
}
