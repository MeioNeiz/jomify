import { type ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { getProfile } from "./leetify/client.js";
import type { LeetifyProfile } from "./leetify/types.js";
import { getSteamId, getTrackedPlayers } from "./store.js";

export const BRAND_COLOUR = 0xf84982;

export function leetifyEmbed(title: string) {
  return new EmbedBuilder().setTitle(title).setColor(BRAND_COLOUR).setTimestamp();
}

export function resolveSteamId(
  interaction: ChatInputCommandInteraction,
  userOpt = "user",
  steamOpt = "steamid",
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

/** Resolve user option or fall back to caller. Returns steamId or sends error. */
export function resolveUser(
  interaction: ChatInputCommandInteraction,
  userOpt = "user",
): { steamId: string | null; label: string } {
  const user = interaction.options.getUser(userOpt);
  const discordId = user?.id ?? interaction.user.id;
  const label = user?.displayName ?? interaction.user.displayName;
  return { steamId: getSteamId(discordId), label };
}

export function requireGuild(interaction: ChatInputCommandInteraction): string | null {
  const guildId = interaction.guildId;
  if (!guildId) return null;
  return guildId;
}

export async function fetchGuildProfiles(
  guildId: string,
): Promise<LeetifyProfile[] | null> {
  const players = getTrackedPlayers(guildId);
  if (!players.length) return null;
  const profiles: LeetifyProfile[] = [];
  for (const id of players) {
    profiles.push(await getProfile(id));
  }
  return profiles;
}

export function fmt(val: number | undefined | null, decimals = 1): string {
  return val != null ? val.toFixed(decimals) : "N/A";
}

/** SQLite UTC datetime string → Discord relative timestamp. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const normalised = iso.replace(" ", "T");
  const t = new Date(normalised.endsWith("Z") ? normalised : `${normalised}Z`).getTime();
  if (Number.isNaN(t)) return "unknown";
  return `<t:${Math.floor(t / 1000)}:R>`;
}

/** Standard trailing italic line for embeds backed by stored/cached data. */
export function freshnessSuffix(
  iso: string | null | undefined,
  prefix = "data as of",
): string {
  return `\n\n_${prefix} ${relTime(iso)}_`;
}
