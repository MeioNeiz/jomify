import db from "../db.js";

// ── Linked accounts ──

export type LinkResult = {
  previousSteamId: string | null;
  previousDiscordId: string | null;
};

/** Always links, overwriting any prior link on either side. */
export function linkAccount(discordId: string, steamId: string): LinkResult {
  const prevForDiscord = db
    .query(`SELECT steam_id FROM linked_accounts WHERE discord_id = ?`)
    .get(discordId) as { steam_id: string } | null;

  const prevForSteam = db
    .query(`SELECT discord_id FROM linked_accounts WHERE steam_id = ?`)
    .get(steamId) as { discord_id: string } | null;

  db.run(`DELETE FROM linked_accounts WHERE discord_id = ? OR steam_id = ?`, [
    discordId,
    steamId,
  ]);
  db.run(`INSERT INTO linked_accounts (discord_id, steam_id) VALUES (?, ?)`, [
    discordId,
    steamId,
  ]);

  return {
    previousSteamId:
      prevForDiscord && prevForDiscord.steam_id !== steamId
        ? prevForDiscord.steam_id
        : null,
    previousDiscordId:
      prevForSteam && prevForSteam.discord_id !== discordId
        ? prevForSteam.discord_id
        : null,
  };
}

export function getSteamId(discordId: string): string | null {
  const row = db
    .query("SELECT steam_id FROM linked_accounts WHERE discord_id = ?")
    .get(discordId) as { steam_id: string } | null;
  return row?.steam_id ?? null;
}

export function getDiscordId(steamId: string): string | null {
  const row = db
    .query("SELECT discord_id FROM linked_accounts WHERE steam_id = ?")
    .get(steamId) as { discord_id: string } | null;
  return row?.discord_id ?? null;
}

export function getAllLinkedAccounts(): {
  discordId: string;
  steamId: string;
}[] {
  const rows = db.query("SELECT discord_id, steam_id FROM linked_accounts").all() as {
    discord_id: string;
    steam_id: string;
  }[];
  return rows.map((r) => ({
    discordId: r.discord_id,
    steamId: r.steam_id,
  }));
}
