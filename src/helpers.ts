import {
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getProfile } from "./leetify/client.js";
import { getSteamId, getTrackedPlayers } from "./store.js";
import type { LeetifyProfile } from "./leetify/types.js";

export const BRAND_COLOUR = 0xf84982;

export function leetifyEmbed(title: string) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(BRAND_COLOUR)
    .setTimestamp();
}

export function resolveSteamId(
  interaction: ChatInputCommandInteraction,
  userOpt = "user",
  steamOpt = "steamid"
): { steamId: string | null; userId: string | null } {
  const user = interaction.options.getUser(userOpt);
  if (user) {
    return {
      steamId: getSteamId(user.id),
      userId: user.id,
    };
  }
  const raw = interaction.options.getString(steamOpt);
  return { steamId: raw, userId: null };
}

export function requireGuild(
  interaction: ChatInputCommandInteraction
): string | null {
  const guildId = interaction.guildId;
  if (!guildId) return null;
  return guildId;
}

export async function fetchGuildProfiles(
  guildId: string
): Promise<LeetifyProfile[] | null> {
  const players = getTrackedPlayers(guildId);
  if (!players.length) return null;
  return Promise.all(
    players.map((id) => getProfile(id))
  );
}

export function fmt(
  val: number | undefined | null,
  decimals = 1
): string {
  return val != null ? val.toFixed(decimals) : "N/A";
}
