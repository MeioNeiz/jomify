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

function formatBest(b: BestFlashGame): string {
  const outcome = outcomeTag(b.roundsWon ?? 0, b.roundsLost ?? 0);
  const kd = kdRatio(b.kills, b.deaths);
  const duration = b.avgBlindDuration.toFixed(1);
  const rating = b.rating != null ? ` \u2022 ${b.rating.toFixed(2)} rating` : "";
  return (
    `\u{1F3C6} **Best flash game (last 20d)**: **${b.name}** on **${b.mapName}** ` +
    `\u2014 ${outcome}, ${relTime(b.finishedAt)}\n` +
    `   \u{1F4A5} ${b.enemyFlashes} enemy (${duration}s avg) ` +
    `\u2022 \u26A1 ${b.leadingToKill} kills \u2022 \u{1F91D} ${b.teamFlashes} team\n` +
    `   ${b.kills}/${b.deaths}/${b.assists} KDA \u2022 ${kd} KD \u2022 ` +
    `${Math.round(b.dpr)} ADR${rating}`
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
      const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
      const lines = entries.map((e, i) => {
        const ratio = e.enemyRate > 0 ? (e.teamRate / e.enemyRate).toFixed(2) : "\u221E";
        return (
          `${i + 1}. **${e.name}** \u2014 ` +
          `\u{1f91d} ${pct(e.teamRate)} ` +
          `\u{1f4a5} ${pct(e.enemyRate)} ` +
          `(${ratio}x) \u2022 ${e.thrown.toFixed(1)}/match`
        );
      });
      const sections = [
        "Per-flashbang rate \u2014 " +
          "\u{1f91d} = hits teammates | \u{1f4a5} = hits enemies\n\n" +
          lines.join("\n"),
      ];
      if (best) sections.push(formatBest(best));
      const embed = new EmbedBuilder()
        .setTitle("Flashbang Shame (last 30)")
        .setColor(0xffff00)
        .setDescription(sections.join("\n\n") + freshnessSuffix(latest));
      return { embeds: [embed] };
    },
    missingMessage: "No match data yet.",
  });
});
