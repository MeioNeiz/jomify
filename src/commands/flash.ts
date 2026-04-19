import { SlashCommandBuilder } from "discord.js";
import { refreshPlayers } from "../cs/refresh.js";
import {
  getMostRecentMatchTime,
  getPlayerMatchStats,
  getPlayerStatAverages,
} from "../cs/store.js";
import { freshnessSuffix, requireTrackedGuild } from "../helpers.js";
import { embed, pad, rankPrefix, table } from "../ui.js";
import { respondWithRevalidate, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("flash")
  .setDescription("Who's the worst at flashing? Team vs enemy flash stats");

type Entry = {
  name: string;
  teamRate: number;
  enemyRate: number;
  thrown: number;
};
type View = {
  entries: Entry[];
  latest: string | null;
};

function computeView(steamIds: string[]): View {
  const entries: Entry[] = [];
  for (const id of steamIds) {
    const avgs = getPlayerStatAverages(id, 30);
    if (!avgs) continue;
    const recent = getPlayerMatchStats(id, 1);
    entries.push({
      name: recent[0]?.raw.name ?? id,
      teamRate: avgs.flash_friend_rate ?? 0,
      enemyRate: avgs.flash_enemy_rate ?? 0,
      thrown: avgs.avg_flash_thrown ?? 0,
    });
  }
  // Worst flasher first: highest rate of flashes hitting teammates.
  entries.sort((a, b) => b.teamRate - a.teamRate);
  return { entries, latest: getMostRecentMatchTime(steamIds) };
}

export const execute = wrapCommand(async (interaction) => {
  const guild = await requireTrackedGuild(interaction);
  if (!guild) return;
  const { steamIds } = guild;

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const data = computeView(steamIds);
      if (!data.entries.length) return null;
      return { data, snapshotAt: data.latest };
    },
    fetchFresh: async () => {
      await refreshPlayers(steamIds);
      return computeView(steamIds);
    },
    render: ({ entries, latest }) => {
      const top = entries.slice(0, 3);
      // All rows are medals (top 3 only), so the emoji-width issue doesn't
      // break column alignment here; numeric columns start at a fixed offset.
      const rows = top.map((e, i) => {
        const prefix = rankPrefix(i);
        return (
          `${prefix} ${pad(e.name, 16)} ` +
          `team ${e.teamRate.toFixed(2)}   ` +
          `enemy ${e.enemyRate.toFixed(2)}   ` +
          `${e.thrown.toFixed(1)}/match`
        );
      });
      const header =
        "Per-flashbang rate — 1.00 means one hit per flash thrown.\n" +
        "Lower `team` is better, higher `enemy` is better.";
      const e = embed("flash")
        .setTitle("Flashbang Shame (Last 30)")
        .setDescription(
          `${header}\n${table(rows)}${freshnessSuffix(latest, "last match")}`,
        );
      return { embeds: [e] };
    },
    missingMessage: "No match data yet.",
  });
});
