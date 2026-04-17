import { SlashCommandBuilder } from "discord.js";
import {
  freshnessSuffix,
  kdRatio,
  outcomeTag,
  relTime,
  requireTrackedGuild,
} from "../helpers.js";
import { refreshPlayers } from "../refresh.js";
import {
  BEST_STATS,
  type BestMatch,
  type BestStatKey,
  getBestMatch,
  getMostRecentMatchTime,
} from "../store.js";
import { embed } from "../ui.js";
import { respondWithRevalidate, wrapCommand } from "./handler.js";

const STAT_CHOICES: { name: string; value: BestStatKey }[] = [
  { name: "Leetify rating", value: "rating" },
  { name: "Kills", value: "kills" },
  { name: "K/D ratio", value: "kd" },
  { name: "ADR (damage per round)", value: "adr" },
  { name: "Headshot accuracy", value: "hs" },
  { name: "Aim (composite)", value: "aim" },
  { name: "Positioning (survival %)", value: "positioning" },
  { name: "Utility (flash + HE)", value: "utility" },
  { name: "Clutch (weighted multikills)", value: "clutch" },
  { name: "Flash impact", value: "flash" },
  { name: "Biggest multikill", value: "multikill" },
];

const DEFAULT_DAYS = 7;

export const data = new SlashCommandBuilder()
  .setName("best")
  .setDescription("Find the best single-game performance across tracked players")
  .addStringOption((o) =>
    o
      .setName("stat")
      .setDescription("Which stat to rank by")
      .setRequired(true)
      .addChoices(...STAT_CHOICES),
  )
  .addIntegerOption((o) =>
    o
      .setName("days")
      .setDescription(`Look-back window in days (default ${DEFAULT_DAYS})`)
      .setMinValue(1)
      .setMaxValue(90),
  );

type View = {
  match: BestMatch | null;
  stat: BestStatKey;
  days: number;
  latest: string | null;
};

function multikillBreakdown(m: BestMatch): string {
  const parts: string[] = [];
  if (m.multi5k) parts.push(`${m.multi5k}× 5K`);
  if (m.multi4k) parts.push(`${m.multi4k}× 4K`);
  if (m.multi3k) parts.push(`${m.multi3k}× 3K`);
  return parts.length ? parts.join(", ") : "none";
}

export const execute = wrapCommand(async (interaction) => {
  const guild = await requireTrackedGuild(interaction);
  if (!guild) return;
  const { steamIds } = guild;
  const stat = interaction.options.getString("stat", true) as BestStatKey;
  const days = interaction.options.getInteger("days") ?? DEFAULT_DAYS;

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const match = getBestMatch(steamIds, stat, days);
      if (!match) return null;
      return {
        data: { match, stat, days, latest: match.finishedAt },
        snapshotAt: match.finishedAt,
      };
    },
    fetchFresh: async () => {
      await refreshPlayers(steamIds);
      return {
        match: getBestMatch(steamIds, stat, days),
        stat,
        days,
        latest: getMostRecentMatchTime(steamIds),
      };
    },
    render: ({ match, stat, days, latest }, { cached }) => {
      const conf = BEST_STATS[stat];
      if (!match) {
        return {
          content: `No tracked players have ${conf.label.toLowerCase()} data in the last ${days} days.`,
        };
      }
      const outcome = outcomeTag(match.roundsWon ?? 0, match.roundsLost ?? 0);
      const headline =
        stat === "multikill" ? multikillBreakdown(match) : conf.format(match.statValue);

      const e = embed("success")
        .setTitle(`Best ${conf.label} (Last ${days}d)`)
        .setDescription(
          `\u{1F3C6} **${match.name}** on **${match.mapName}** (${outcome}), ${relTime(match.finishedAt)}` +
            (cached ? freshnessSuffix(latest, "snapshot from") : ""),
        )
        .addFields(
          { name: conf.label, value: `**${headline}**`, inline: true },
          {
            name: "Score",
            value:
              `${match.kills}/${match.deaths}/${match.assists} KDA\n` +
              `${kdRatio(match.kills, match.deaths)} K/D\n` +
              `${Math.round(match.dpr)} ADR`,
            inline: true,
          },
          {
            name: "Rating",
            value: match.rating != null ? match.rating.toFixed(2) : "N/A",
            inline: true,
          },
        );
      return { embeds: [e] };
    },
    missingMessage: "No match data yet.",
  });
});
