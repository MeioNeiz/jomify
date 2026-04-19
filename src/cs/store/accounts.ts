import { eq, or } from "drizzle-orm";
import db from "../../db.js";
import { linkedAccounts } from "../../schema.js";
import { assertSteam64 } from "./validate.js";

export type LinkResult = {
  previousSteamId: string | null;
  previousDiscordId: string | null;
};

/** Always links, overwriting any prior link on either side. */
export function linkAccount(discordId: string, steamId: string): LinkResult {
  assertSteam64(steamId);
  return db.transaction((tx) => {
    const prevForDiscord = tx
      .select({ steamId: linkedAccounts.steamId })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.discordId, discordId))
      .get();

    const prevForSteam = tx
      .select({ discordId: linkedAccounts.discordId })
      .from(linkedAccounts)
      .where(eq(linkedAccounts.steamId, steamId))
      .get();

    tx.delete(linkedAccounts)
      .where(
        or(eq(linkedAccounts.discordId, discordId), eq(linkedAccounts.steamId, steamId)),
      )
      .run();
    tx.insert(linkedAccounts).values({ discordId, steamId }).run();

    return {
      previousSteamId:
        prevForDiscord && prevForDiscord.steamId !== steamId
          ? prevForDiscord.steamId
          : null,
      previousDiscordId:
        prevForSteam && prevForSteam.discordId !== discordId
          ? prevForSteam.discordId
          : null,
    };
  });
}

export function getSteamId(discordId: string): string | null {
  const row = db
    .select({ steamId: linkedAccounts.steamId })
    .from(linkedAccounts)
    .where(eq(linkedAccounts.discordId, discordId))
    .get();
  return row?.steamId ?? null;
}

export function getDiscordId(steamId: string): string | null {
  const row = db
    .select({ discordId: linkedAccounts.discordId })
    .from(linkedAccounts)
    .where(eq(linkedAccounts.steamId, steamId))
    .get();
  return row?.discordId ?? null;
}

export function getAllLinkedAccounts(): { discordId: string; steamId: string }[] {
  return db
    .select({
      discordId: linkedAccounts.discordId,
      steamId: linkedAccounts.steamId,
    })
    .from(linkedAccounts)
    .all();
}
