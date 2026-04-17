import { SlashCommandBuilder } from "discord.js";
import { fetchGuildProfiles, freshnessSuffix, leetifyEmbed } from "../helpers.js";
import {
  getLastLeaderboard,
  getLastLeaderboardWithNames,
  getTrackedPlayers,
  saveLeaderboardSnapshot,
} from "../store.js";
import { respondWithRevalidate, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Rank tracked players by Premier rating");

type Entry = { steamId: string; name: string; premier: number };

function buildLines(
  entries: Entry[],
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

export const execute = wrapCommand(async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  const trackedIds = getTrackedPlayers(guildId);
  if (!trackedIds.length) {
    await interaction.editReply("No tracked players. Use `/track` to add some.");
    return;
  }

  type View = {
    entries: Entry[];
    prev: { steamId: string; premier: number | null }[];
  };

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const cached = getLastLeaderboardWithNames(guildId);
      if (!cached.entries.length) return null;
      const entries = cached.entries
        .map((e) => ({
          steamId: e.steamId,
          name: e.name,
          premier: e.premier ?? 0,
        }))
        .sort((a, b) => b.premier - a.premier);
      return { data: { entries, prev: [] }, snapshotAt: cached.recordedAt };
    },
    fetchFresh: async () => {
      // Snapshot the "previous" leaderboard *before* we save the new one,
      // otherwise the position arrows would compare against ourselves.
      const prev = getLastLeaderboard(guildId);
      const profiles = await fetchGuildProfiles(guildId);
      const entries: Entry[] = (profiles ?? [])
        .map((p) => ({
          steamId: p.steam64_id,
          name: p.name,
          premier: p.ranks?.premier ?? 0,
        }))
        .sort((a, b) => b.premier - a.premier);
      saveLeaderboardSnapshot(
        guildId,
        entries.map((e) => ({ steamId: e.steamId, premier: e.premier })),
      );
      return { entries, prev };
    },
    render: (v, { cached, snapshotAt }) => {
      const prevMap = new Map(v.prev.map((e) => [e.steamId, e.premier]));
      const prevOrder = [...v.prev]
        .sort((a, b) => (b.premier ?? 0) - (a.premier ?? 0))
        .map((e) => e.steamId);
      const lines = buildLines(v.entries, prevMap, prevOrder);
      const title = cached ? "Leaderboard (cached)" : "Leaderboard";
      const desc = cached
        ? lines.join("\n") + freshnessSuffix(snapshotAt, "snapshot from")
        : lines.join("\n");
      return { embeds: [leetifyEmbed(title).setDescription(desc)] };
    },
    missingMessage:
      "Leetify is down and there's no cached leaderboard yet \u2014 try again shortly.",
  });
});
