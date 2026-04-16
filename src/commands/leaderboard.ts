import { SlashCommandBuilder } from "discord.js";
import { fetchGuildProfiles, freshnessSuffix, leetifyEmbed } from "../helpers.js";
import { LeetifyUnavailableError } from "../leetify/client.js";
import type { LeetifyProfile } from "../leetify/types.js";
import log from "../logger.js";
import {
  getLastLeaderboard,
  getLastLeaderboardWithNames,
  type PlayerSnapshot,
  saveLeaderboardSnapshot,
  saveSnapshots,
} from "../store.js";
import { wrapCommand } from "./handler.js";

function isLeetifyDown(err: unknown): boolean {
  if (err instanceof LeetifyUnavailableError) return true;
  const msg = (err as { message?: string })?.message ?? "";
  return msg.includes("Leetify API error") || msg.includes("fetch failed");
}

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Rank tracked players by Premier rating");

function buildLines(
  entries: { name: string; steamId: string; premier: number }[],
  prevMap: Map<string, number | null>,
  prevOrder: string[],
) {
  const medals = ["\u{1f947}", "\u{1f948}", "\u{1f949}"];
  return entries.map((e, i) => {
    const prefix = medals[i] ?? `${i + 1}.`;
    const rating = e.premier ? e.premier.toLocaleString() : "Unranked";

    let change = "";
    const prev = prevMap.get(e.steamId);
    if (prev != null && e.premier) {
      const diff = e.premier - prev;
      if (diff > 0) change = ` (+${diff})`;
      else if (diff < 0) change = ` (${diff})`;
    }

    let posChange = "";
    if (prevOrder.length) {
      const oldPos = prevOrder.indexOf(e.steamId);
      if (oldPos !== -1 && oldPos !== i) {
        const moved = oldPos - i;
        posChange =
          moved > 0 ? ` \u2B06\uFE0F${moved}` : ` \u2B07\uFE0F${Math.abs(moved)}`;
      }
    }

    return `${prefix} **${e.name}** \u2014 ${rating}${change}${posChange}`;
  });
}

async function replyCached(
  interaction: import("discord.js").ChatInputCommandInteraction,
  guildId: string,
): Promise<boolean> {
  const cached = getLastLeaderboardWithNames(guildId);
  if (!cached.entries.length) return false;

  const entries = cached.entries
    .map((e) => ({ ...e, premier: e.premier ?? 0 }))
    .sort((a, b) => b.premier - a.premier);
  const lines = buildLines(entries, new Map(), []);
  const embed = leetifyEmbed("Leaderboard (cached)").setDescription(
    lines.join("\n") +
      freshnessSuffix(cached.recordedAt, "Leetify unavailable \u2014 snapshot from"),
  );
  await interaction.editReply({ embeds: [embed] });
  return true;
}

export const execute = wrapCommand(async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  let profiles: LeetifyProfile[] | null;
  try {
    profiles = await fetchGuildProfiles(guildId);
  } catch (err) {
    if (!isLeetifyDown(err)) throw err;
    log.warn({ cmd: "leaderboard" }, "Leetify down \u2014 falling back to cache");
    if (await replyCached(interaction, guildId)) return;
    await interaction.editReply(
      "Leetify is down and there's no cached leaderboard yet \u2014 try again shortly.",
    );
    return;
  }

  if (!profiles) {
    await interaction.editReply("No tracked players. Use `/track` to add some.");
    return;
  }

  const snapshots: PlayerSnapshot[] = profiles.map((p) => ({
    steamId: p.steam64_id,
    name: p.name,
    premier: p.ranks?.premier ?? null,
    leetify: p.ranks?.leetify ?? null,
    aim: p.rating?.aim,
    positioning: p.rating?.positioning,
    utility: p.rating?.utility,
    clutch: p.rating?.clutch,
  }));
  saveSnapshots(snapshots);

  const previous = getLastLeaderboard(guildId);
  const prevMap = new Map(previous.map((e) => [e.steamId, e.premier]));
  const prevOrder = [...previous]
    .sort((a, b) => (b.premier ?? 0) - (a.premier ?? 0))
    .map((e) => e.steamId);

  const entries = profiles
    .map((p) => ({ steamId: p.steam64_id, name: p.name, premier: p.ranks?.premier ?? 0 }))
    .sort((a, b) => b.premier - a.premier);

  saveLeaderboardSnapshot(
    guildId,
    entries.map((e) => ({ steamId: e.steamId, premier: e.premier })),
  );

  const lines = buildLines(entries, prevMap, prevOrder);
  const embed = leetifyEmbed("Leaderboard").setDescription(lines.join("\n"));
  await interaction.editReply({ embeds: [embed] });
});
