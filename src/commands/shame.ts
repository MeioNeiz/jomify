import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import {
  requireGuild,
  fetchGuildProfiles,
} from "../helpers.js";

export const data = new SlashCommandBuilder()
  .setName("shame")
  .setDescription(
    "Who had the worst most recent game? Wall of shame."
  );

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  const guildId = requireGuild(interaction);
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  const profiles = await fetchGuildProfiles(guildId);
  if (!profiles) {
    await interaction.editReply(
      "No tracked players. Use `/track` to add some."
    );
    return;
  }

  try {
    const results: {
      name: string;
      rating: number;
      map: string;
    }[] = [];

    for (const profile of profiles) {
      const match = profile.recent_matches?.[0];
      if (!match) continue;
      results.push({
        name: profile.name,
        rating: match.leetify_rating,
        map: match.map_name,
      });
    }

    if (!results.length) {
      await interaction.editReply(
        "No recent matches found."
      );
      return;
    }

    results.sort((a, b) => a.rating - b.rating);
    const worst = results[0];

    const embed = new EmbedBuilder()
      .setTitle("Wall of Shame")
      .setColor(0xff0000)
      .setDescription(
        `**${worst.name}** had the worst game with a `
        + `**${worst.rating.toFixed(2)}** rating `
        + `on ${worst.map}`
      )
      .addFields(
        results.map((r, i) => ({
          name: `${i + 1}. ${r.name}`,
          value:
            `Rating: ${r.rating.toFixed(2)} | ${r.map}`,
        }))
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("Shame error:", err);
    await interaction.editReply(
      "Failed to fetch stats. Try again later."
    );
  }
}
