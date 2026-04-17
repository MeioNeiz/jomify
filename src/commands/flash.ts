import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  freshnessSuffix,
  kdRatio,
  outcomeTag,
  relTime,
  requireTrackedGuild,
} from "../helpers.js";
import { refreshPlayers } from "../refresh.js";
import {
  type BestFlashGame,
  getBestFlashGame,
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
  best: BestFlashGame | null;
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
  return {
    entries,
    best: getBestFlashGame(steamIds, 20),
    latest: getMostRecentMatchTime(steamIds),
  };
}

const MEDALS = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];

function addBestFlashFields(embed: EmbedBuilder, b: BestFlashGame): void {
  const outcome = outcomeTag(b.roundsWon ?? 0, b.roundsLost ?? 0);
  const duration = b.avgBlindDuration.toFixed(1);
  embed.addFields(
    {
      name: "\u{1F3C6} Best flash game (last 20d)",
      value: `**${b.name}** on **${b.mapName}**\n${outcome}   ${relTime(b.finishedAt)}`,
      inline: false,
    },
    {
      name: "Flashes",
      value:
        `\u{1F4A5} enemies hit: **${b.enemyFlashes}** (${duration}s avg)\n` +
        `\u26A1 kills: **${b.leadingToKill}**\n` +
        `\u{1F91D} team hits: **${b.teamFlashes}**`,
      inline: true,
    },
    {
      name: "Game",
      value:
        `${b.kills}/${b.deaths}/${b.assists} KDA\n` +
        `${kdRatio(b.kills, b.deaths)} K/D\n` +
        `${Math.round(b.dpr)} ADR` +
        (b.rating != null ? `\n${b.rating.toFixed(2)} rating` : ""),
      inline: true,
    },
  );
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
    render: ({ entries, best, latest }) => {
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
      if (best) addBestFlashFields(embed, best);
      return { embeds: [embed] };
    },
    missingMessage: "No match data yet.",
  });
});
