import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getProfile } from "../leetify/client.js";

export const data = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Show a player's CS2 stats from Leetify")
  .addStringOption((opt) =>
    opt
      .setName("steamid")
      .setDescription("Steam64 ID of the player")
      .setRequired(true)
  );

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  const steamId = interaction.options.getString("steamid", true);

  try {
    const profile = await getProfile(steamId);

    const embed = new EmbedBuilder()
      .setTitle(profile.meta.name)
      .setThumbnail(profile.meta.avatarUrl ?? null)
      .setColor(0xf84982)
      .addFields(
        {
          name: "Leetify Rating",
          value: `${profile.ratings?.leetifyRating ?? "N/A"}`,
          inline: true,
        },
        {
          name: "Aim",
          value: `${profile.ratings?.aim ?? "N/A"}`,
          inline: true,
        },
        {
          name: "Positioning",
          value: `${profile.ratings?.positioning ?? "N/A"}`,
          inline: true,
        },
        {
          name: "Utility",
          value: `${profile.ratings?.utility ?? "N/A"}`,
          inline: true,
        },
        {
          name: "Clutch",
          value: `${profile.ratings?.clutch ?? "N/A"}`,
          inline: true,
        },
        {
          name: "Premier",
          value: `${profile.ranks?.premier ?? "N/A"}`,
          inline: true,
        }
      )
      .setFooter({ text: "Data Provided by Leetify" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(
      `Failed to fetch stats for \`${steamId}\`. `
      + "Is the Steam ID correct and the profile on Leetify?"
    );
  }
}
