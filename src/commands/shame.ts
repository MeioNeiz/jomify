import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getProfile } from "../leetify/client.js";
import { trackedPlayers } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("shame")
  .setDescription(
    "Who had the worst most recent game? Wall of shame."
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
    const results: {
      name: string;
      rating: number;
      kd: string;
      map: string;
    }[] = [];

    const profiles = await Promise.all(
      [...players].map((steamId) => getProfile(steamId))
    );

    for (const profile of profiles) {
      const match = profile.recentMatches?.[0];
      if (!match) continue;

      results.push({
        name: profile.meta.name,
        rating: match.playerStats.leetifyRating,
        kd: `${match.playerStats.kills}/${match.playerStats.deaths}`,
        map: match.mapName,
      });
    }

    if (!results.length) {
      await interaction.editReply("No recent matches found.");
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
        + `(${worst.kd} on ${worst.map})`
      )
      .addFields(
        results.map((r, i) => ({
          name: `${i + 1}. ${r.name}`,
          value: `Rating: ${r.rating.toFixed(2)} | K/D: ${r.kd} | ${r.map}`,
        }))
      )
      .setFooter({ text: "Data Provided by Leetify" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(
      "Failed to fetch stats. Try again later."
    );
  }
}
