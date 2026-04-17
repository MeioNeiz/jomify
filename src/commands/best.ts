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

function pct(n: number | null): string {
  return n != null ? `${(n * 100).toFixed(1)}%` : "N/A";
}

function num(n: number | null, dec = 1): string {
  return n != null ? n.toFixed(dec) : "N/A";
}

/**
 * Per-stat breakdown — the "what made this the best {stat}" detail
 * the headline number alone doesn't explain. Returned as an array of
 * embed fields so they render as columns beside the headline number.
 */
function contextFields(
  stat: BestStatKey,
  m: BestMatch,
): { name: string; value: string; inline: boolean }[] {
  switch (stat) {
    case "flash":
      return [
        {
          name: "Flashes",
          value:
            `\u{1F4A5} ${m.flashEnemies ?? 0} enemies (${num(m.flashBlind, 1)}s avg)\n` +
            `\u26A1 ${m.flashKills ?? 0} kills\n` +
            `\u{1F91D} ${m.flashTeam ?? 0} team hits`,
          inline: true,
        },
      ];
    case "aim":
      return [
        {
          name: "Accuracy",
          value:
            `\u{1F3AF} HS ${pct(m.accuracyHead)}\n` +
            `Spray ${pct(m.sprayAccuracy)}\n` +
            `Preaim ${num(m.preaim, 2)} cm`,
          inline: true,
        },
      ];
    case "utility":
      return [
        {
          name: "Utility",
          value:
            `\u{1F4A5} HE dmg ${num(m.heEnemies, 1)} (friendly ${num(m.heFriends, 1)})\n` +
            `\u{1F91D} team flashes ${m.flashTeam ?? 0}`,
          inline: true,
        },
      ];
    case "clutch":
    case "multikill":
      return [
        {
          name: "Multikills",
          value: multikillBreakdown(m),
          inline: true,
        },
      ];
    case "hs":
      return [{ name: "Headshot %", value: pct(m.accuracyHead), inline: true }];
    default:
      return [];
  }
}

/**
 * One-line explainer per stat — rendered as Discord `-#` subtext so it
 * reads like a tooltip under the headline number. Dimensionless scores
 * (aim/utility/clutch) get their formula; direct stats get nothing.
 */
function statExplainer(stat: BestStatKey): string {
  switch (stat) {
    case "flash":
      return (
        "-# Flash impact = (enemy hits × avg blind duration " +
        "+ 2 × kills + flash assists − 2 × team hits) ÷ rounds."
      );
    case "aim":
      return (
        "-# Aim score = 100 × head accuracy + 50 × spray − 5 × preaim. " +
        "Higher is better; typical range 20-70."
      );
    case "utility":
      return "-# Utility score = flash impact + 0.5 × HE damage − 0.3 × friendly HE damage.";
    case "clutch":
      return (
        "-# Clutch proxy = 10 × 5Ks + 5 × 4Ks + 3 × 3Ks. " +
        "Leetify doesn't publish per-round clutch data so this is a stand-in."
      );
    case "positioning":
      return "-# Survival % = 1 − deaths / rounds.";
    case "multikill":
      return "-# Tier-weighted; a single 5K beats any number of 4Ks.";
    default:
      return "";
  }
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

      const explainer = statExplainer(stat);
      const bodyLines = [
        `\u{1F3C6} **${match.name}** on **${match.mapName}** (${outcome}), ${relTime(match.finishedAt)}`,
      ];
      if (explainer) bodyLines.push(explainer);

      const e = embed("success")
        .setTitle(`Best ${conf.label} (Last ${days}d)`)
        .setDescription(
          bodyLines.join("\n") + (cached ? freshnessSuffix(latest, "snapshot from") : ""),
        )
        .addFields(
          { name: conf.label, value: `**${headline}**`, inline: true },
          ...contextFields(stat, match),
          {
            name: "Score",
            value:
              `${match.kills}/${match.deaths}/${match.assists} KDA\n` +
              `${kdRatio(match.kills, match.deaths)} K/D\n` +
              `${Math.round(match.dpr)} ADR`,
            inline: true,
          },
        );
      return { embeds: [e] };
    },
    missingMessage: "No match data yet.",
  });
});
