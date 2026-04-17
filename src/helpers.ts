import type { ChatInputCommandInteraction } from "discord.js";
import {
  getProfile,
  isLeetifyCircuitOpen,
  LeetifyNotFoundError,
} from "./leetify/client.js";
import type { LeetifyProfile } from "./leetify/types.js";
import { getTrackedPlayers, isLeetifyUnknown } from "./store.js";

/** Guild id for a slash command, or null (after replying) for a DM. */
export async function requireGuild(
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  if (interaction.guildId) return interaction.guildId;
  await interaction.editReply("Use this in a server.");
  return null;
}

/** Guild id + at least one tracked player, or null (after replying). */
export async function requireTrackedGuild(
  interaction: ChatInputCommandInteraction,
): Promise<{ guildId: string; steamIds: string[] } | null> {
  const guildId = await requireGuild(interaction);
  if (!guildId) return null;
  const steamIds = getTrackedPlayers(guildId);
  if (!steamIds.length) {
    await interaction.editReply("No tracked players. Use `/track` to add some.");
    return null;
  }
  return { guildId, steamIds };
}

export async function fetchGuildProfiles(
  guildId: string,
): Promise<LeetifyProfile[] | null> {
  const players = getTrackedPlayers(guildId);
  if (!players.length) return null;
  // Skip ids we already know aren't on Leetify — they'd just 404.
  const targets = players.filter((id) => !isLeetifyUnknown(id));
  const settled = await Promise.allSettled(targets.map((id) => getProfile(id)));
  // 404s are non-fatal (the player isn't on Leetify); other errors still
  // bubble so /leaderboard /stats /compare fall back to cached data.
  const profiles: LeetifyProfile[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") profiles.push(r.value);
    else if (!(r.reason instanceof LeetifyNotFoundError)) throw r.reason;
  }
  return profiles;
}

export function fmt(val: number | undefined | null, decimals = 1): string {
  return val != null ? val.toFixed(decimals) : "N/A";
}

/** "+212" / "-43" / "0". */
export function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `${r}`;
}

/** KD ratio with 2 dp, handling zero-death edge case. */
export function kdRatio(kills: number, deaths: number): string {
  return deaths ? (kills / deaths).toFixed(2) : `${kills}`;
}

/** Per-team score badge: "W 13-7" / "L 7-13" / "T 12-12". */
export function outcomeTag(won: number, lost: number): string {
  if (won > lost) return `W ${won}-${lost}`;
  if (lost > won) return `L ${won}-${lost}`;
  return `T ${won}-${lost}`;
}

/** SQLite UTC datetime string → Discord relative timestamp. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const normalised = iso.replace(" ", "T");
  const t = new Date(normalised.endsWith("Z") ? normalised : `${normalised}Z`).getTime();
  if (Number.isNaN(t)) return "unknown";
  return `<t:${Math.floor(t / 1000)}:R>`;
}

/**
 * Standard trailing italic line for embeds backed by stored/cached data.
 * Automatically appends "Leetify unavailable" when the circuit breaker
 * is tripped — signals to users that the snapshot they're looking at
 * isn't the most recent available because upstream is down.
 */
export function freshnessSuffix(
  iso: string | null | undefined,
  prefix = "data as of",
): string {
  const upstream = isLeetifyCircuitOpen() ? " \u00B7 Leetify unavailable" : "";
  return `\n\n_${prefix} ${relTime(iso)}${upstream}_`;
}
