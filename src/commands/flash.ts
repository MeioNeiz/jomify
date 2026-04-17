import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { freshnessSuffix, requireTrackedGuild } from "../helpers.js";
import { refreshPlayers } from "../refresh.js";
import {
  getMostRecentMatchTime,
  getPlayerMatchStats,
  getPlayerStatAverages,
} from "../store.js";
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

const MEDALS = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];

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
      const lines = top.map((e, i) => {
        const medal = MEDALS[i] ?? `${i + 1}.`;
        return (
          `${medal} **${e.name}** \u2014 ` +
          `\u{1F91D} ${e.teamRate.toFixed(2)}   ` +
          `\u{1F4A5} ${e.enemyRate.toFixed(2)}   ` +
          `${e.thrown.toFixed(1)}/match`
        );
      });
      const header =
        "Per-flashbang rate \u2014 1.00 means one hit per flash thrown\n" +
        "\u{1F91D} teammates   \u{1F4A5} enemies";
      const embed = new EmbedBuilder()
        .setTitle("Flashbang Shame (last 30)")
        .setColor(0xffff00)
        .setDescription(`${header}\n\n${lines.join("\n")}${freshnessSuffix(latest)}`);
      return { embeds: [embed] };
    },
    missingMessage: "No match data yet.",
  });
});
