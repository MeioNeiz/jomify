import { SlashCommandBuilder } from "discord.js";
import { leetifyEmbed } from "../helpers.js";
import { getPlayerMapStats, type MapStats } from "../store.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

const MIN_MATCHES = 3;

export const data = new SlashCommandBuilder()
  .setName("maps")
  .setDescription("Map win rates for a player")
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Player to look up (defaults to you)"),
  );

export function formatMapLines(stats: MapStats[]): string {
  const filtered = stats.filter((s) => s.total >= MIN_MATCHES);
  if (!filtered.length) return "";
  return filtered
    .map((s) => {
      const name = s.mapName.replace(/^de_/, "");
      return (
        `**${name}** \u2014 ${s.wins}W-${s.losses}L ` +
        `(${s.winRate.toFixed(0)}%) \u2022 ${s.total} games`
      );
    })
    .join("\n");
}

export { MIN_MATCHES };

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;
  const lines = formatMapLines(getPlayerMapStats(resolved.steamId));
  if (!lines) {
    await interaction.editReply(
      `No map data for ${resolved.label} (min ${MIN_MATCHES} games).`,
    );
    return;
  }
  await interaction.editReply({
    embeds: [leetifyEmbed(`${resolved.label}'s Map Win Rates`).setDescription(lines)],
  });
});
