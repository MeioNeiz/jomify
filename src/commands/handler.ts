import type { ChatInputCommandInteraction } from "discord.js";
import { fetchGuildProfiles } from "../helpers.js";
import { getProfile, LeetifyUnavailableError } from "../leetify/client.js";
import type { LeetifyProfile } from "../leetify/types.js";
import log from "../logger.js";
import { getLatestSnapshot, getSteamId, type PlayerSnapshot } from "../store.js";

type CommandFn = (interaction: ChatInputCommandInteraction) => Promise<void>;

/**
 * Wraps a command with deferReply + error handling.
 * Set defer to false for commands that reply immediately.
 */
export function wrapCommand(fn: CommandFn, opts?: { defer?: boolean }): CommandFn {
  const defer = opts?.defer ?? true;
  return async (interaction) => {
    if (defer) await interaction.deferReply();
    try {
      await fn(interaction);
    } catch (err) {
      const e = err as { code?: number; message?: string } | undefined;
      if (e?.code === 10062) return;
      log.error({ cmd: interaction.commandName, err }, "Command error");

      let msg = "Something went wrong.";
      if (err instanceof LeetifyUnavailableError) {
        msg = "Leetify is down right now \u2014 try again in a minute.";
      } else if (e?.message?.includes("Leetify API error")) {
        msg = "Leetify API error \u2014 try again shortly.";
      } else if (e?.message?.includes("fetch failed")) {
        msg = "Network error \u2014 couldn't reach external services.";
      }

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(msg);
        } else {
          await interaction.reply(msg);
        }
      } catch {
        /* interaction gone */
      }
    }
  };
}

/** Resolve a user option to a steamId, or reply with error. */
export async function requireLinkedUser(
  interaction: ChatInputCommandInteraction,
  userOpt = "user",
): Promise<{ steamId: string; label: string } | null> {
  const user = interaction.options.getUser(userOpt);
  const discordId = user?.id ?? interaction.user.id;
  const label = user?.displayName ?? interaction.user.displayName;
  const steamId = getSteamId(discordId);
  if (!steamId) {
    await interaction.editReply(`${label} hasn't linked. Use \`/link\` first.`);
    return null;
  }
  return { steamId, label };
}

/**
 * Fetch a profile from Leetify, falling back to the latest
 * local snapshot if the API is unavailable. Returns
 * { profile, cached } where profile is a full LeetifyProfile
 * or a snapshot shaped enough for most commands.
 */
export async function getProfileWithFallback(steamId: string): Promise<{
  data: LeetifyProfile | PlayerSnapshot;
  cached: boolean;
  snapshotAt: string | null;
}> {
  try {
    const data = await getProfile(steamId);
    return { data, cached: false, snapshotAt: null };
  } catch {
    const snap = getLatestSnapshot(steamId);
    if (snap) {
      const { recordedAt, ...rest } = snap;
      return { data: rest, cached: true, snapshotAt: recordedAt };
    }
    throw new Error(`No data for ${steamId} (API down, no local cache)`);
  }
}

/** Check if a profile result is a full LeetifyProfile or a snapshot. */
export function isFullProfile(p: LeetifyProfile | PlayerSnapshot): p is LeetifyProfile {
  return "steam64_id" in p;
}

/** Require a guild + tracked profiles, or reply with error. */
export async function requireGuildProfiles(
  interaction: ChatInputCommandInteraction,
): Promise<{ guildId: string; profiles: LeetifyProfile[] } | null> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return null;
  }
  const profiles = await fetchGuildProfiles(guildId);
  if (!profiles) {
    await interaction.editReply("No tracked players. Use `/track` to add some.");
    return null;
  }
  return { guildId, profiles };
}
