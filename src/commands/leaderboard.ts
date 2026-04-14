import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getProfile } from "../leetify/client.js";
import { trackedPlayers } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription(
    "Rank tracked players by Leetify rating"
  );

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  const players = trackedPlayers.get(guildId);
  if (!players?.size) {
    await interaction.editReply(
      "No tracked players. Use `/track` to add some."
    );
    return;
  }

  try {
    const profiles = await Promise.all(
      [...players].map((steamId) => getProfile(steamId))
    );

    const entries = profiles
      .map((p) => ({
        name: p.meta.name,
        rating: p.ratings?.leetifyRating ?? 0,
        premier: p.ranks?.premier,
      }))
      .sort((a, b) => b.rating - a.rating);

    const medals = ["🥇", "🥈", "🥉"];

    const lines = entries.map((e, i) => {
      const prefix = medals[i] ?? `${i + 1}.`;
      const premier = e.premier ? ` (${e.premier})` : "";
      return `${prefix} **${e.name}** — ${e.rating.toFixed(2)}${premier}`;
    });

    const embed = new EmbedBuilder()
      .setTitle("Leaderboard")
      .setColor(0xf84982)
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Data Provided by Leetify" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(
      "Failed to fetch stats. Try again later."
    );
  }
}
