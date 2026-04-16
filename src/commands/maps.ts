import { SlashCommandBuilder } from "discord.js";
import { leetifyEmbed, requireGuild } from "../helpers.js";
import type { MapStats } from "../store.js";
import { getPlayerMapStats, getTeamMapStats, getTrackedPlayers } from "../store.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

const MIN_MATCHES = 3;

export const data = new SlashCommandBuilder()
  .setName("maps")
  .setDescription("Map win rates")
  .addSubcommand((sub) =>
    sub
      .setName("team")
      .setDescription("Map win rates when tracked players queue together"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("player")
      .setDescription("Map win rates for a single player")
      .addUserOption((opt) => opt.setName("user").setDescription("Player to look up")),
  );

function formatMapLines(stats: MapStats[]): string {
  const filtered = stats.filter((s) => s.total >= MIN_MATCHES);
  if (!filtered.length) return "";
  return filtered
    .map((s) => {
      const name = s.mapName.replace(/^de_/, "");
      return `**${name}** \u2014 ${s.wins}W-${s.losses}L (${s.winRate.toFixed(0)}%) \u2022 ${s.total} games`;
    })
    .join("\n");
}

export const execute = wrapCommand(async (interaction) => {
  const guildId = requireGuild(interaction);
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "team") {
    const steamIds = getTrackedPlayers(guildId);
    if (steamIds.length < 2) {
      await interaction.editReply(
        "Need at least 2 tracked players. Use `/track add` first.",
      );
      return;
    }
    const stats = getTeamMapStats(steamIds);
    const lines = formatMapLines(stats);
    if (!lines) {
      await interaction.editReply(
        `No shared matches found (min ${MIN_MATCHES} games on a map).`,
      );
      return;
    }
    const embed = leetifyEmbed("Team Map Win Rates").setDescription(lines);
    await interaction.editReply({ embeds: [embed] });
  } else {
    const resolved = await requireLinkedUser(interaction);
    if (!resolved) return;
    const stats = getPlayerMapStats(resolved.steamId);
    const lines = formatMapLines(stats);
    if (!lines) {
      await interaction.editReply(
        `No map data for ${resolved.label} (min ${MIN_MATCHES} games).`,
      );
      return;
    }
    const embed = leetifyEmbed(`${resolved.label}'s Map Win Rates`).setDescription(lines);
    await interaction.editReply({ embeds: [embed] });
  }
});
