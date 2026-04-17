import { SlashCommandBuilder } from "discord.js";
import { freshnessSuffix, requireTrackedGuild, signed } from "../helpers.js";
import { refreshPlayers } from "../refresh.js";
import { getMostRecentMatchTime, getTeamCarryStats, getTeamMapStats } from "../store.js";
import { embed, rankPrefix } from "../ui.js";
import { respondWithRevalidate, wrapCommand } from "./handler.js";
import { formatMapLines, MIN_MATCHES } from "./maps.js";

export const data = new SlashCommandBuilder()
  .setName("team")
  .setDescription("Team-wide stats for tracked players")
  .addSubcommand((sub) =>
    sub
      .setName("maps")
      .setDescription("Map win rates when tracked players queue together"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("carry")
      .setDescription("Who contributes most rating to other tracked players"),
  );

export const execute = wrapCommand(async (interaction) => {
  const sub = interaction.options.getSubcommand();

  if (sub === "maps") {
    await teamMaps(interaction);
    return;
  }

  if (sub === "carry") {
    await teamCarry(interaction);
    return;
  }
});

async function teamMaps(interaction: import("discord.js").ChatInputCommandInteraction) {
  const guild = await requireTrackedGuild(interaction);
  if (!guild) return;
  if (guild.steamIds.length < 2) {
    await interaction.editReply(
      "Need at least 2 tracked players. Use `/track add` first.",
    );
    return;
  }
  const lines = formatMapLines(getTeamMapStats(guild.steamIds));
  if (!lines) {
    await interaction.editReply(
      `No shared matches found (min ${MIN_MATCHES} games on a map).`,
    );
    return;
  }
  await interaction.editReply({
    embeds: [embed().setTitle("Team Map Win Rates").setDescription(lines)],
  });
}

type CarryView = {
  rows: ReturnType<typeof getTeamCarryStats>;
  latest: string | null;
};

async function teamCarry(interaction: import("discord.js").ChatInputCommandInteraction) {
  const guild = await requireTrackedGuild(interaction);
  if (!guild) return;
  const { steamIds } = guild;
  if (steamIds.length < 2) {
    await interaction.editReply(
      "Need at least 2 tracked players. Use `/track add` first.",
    );
    return;
  }

  const compute = (): CarryView => ({
    rows: getTeamCarryStats(steamIds).filter((r) => r.sharedMatches >= 3),
    latest: getMostRecentMatchTime(steamIds),
  });

  await respondWithRevalidate<CarryView>(interaction, {
    fetchCached: () => {
      const v = compute();
      return v.rows.length ? { data: v, snapshotAt: v.latest } : null;
    },
    fetchFresh: async () => {
      await refreshPlayers(steamIds);
      return compute();
    },
    render: ({ rows, latest }) => {
      const top = rows.slice(0, 10);
      const lines = top.map((r, i) => {
        const main =
          r.premierSamples > 0
            ? `**${signed(r.premierScore)}** Premier`
            : `**${r.proxyScore.toFixed(2)}** carry score`;
        return (
          `${rankPrefix(i)} **${r.name}** ${main} ` +
          `(${r.sharedMatches} games, ${r.partnerCount} teammates)`
        );
      });

      // `-#` renders as Discord subtext (small, dimmed) — closest thing
      // to a tooltip inline. Explains the sign of the score once so we
      // don't have to annotate every row.
      const note = "-# Positive = net carry, negative = net drag vs team mean.";

      const e = embed()
        .setTitle("Team Carry Rankings")
        .setDescription(
          `${lines.join("\n")}\n\n${note}${freshnessSuffix(latest, "last match")}`,
        );
      return { embeds: [e] };
    },
    missingMessage: "Not enough shared matches yet to rank carries (need 3+ per pair).",
  });
}
