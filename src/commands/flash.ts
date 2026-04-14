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
  .setName("flash")
  .setDescription(
    "Who's the worst at flashing? "
    + "Team vs enemy flash stats"
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
    const entries = profiles
      .map((p) => ({
        name: p.name,
        team: p.stats.flashbang_hit_friend_per_flashbang,
        enemy: p.stats.flashbang_hit_foe_per_flashbang,
      }))
      .sort((a, b) => b.team - a.team);

    const lines = entries.map((e, i) => {
      const ratio = e.enemy > 0
        ? (e.team / e.enemy).toFixed(1)
        : "\u221E";
      return (
        `${i + 1}. **${e.name}** \u2014 `
        + `\u{1f91d} ${e.team.toFixed(2)} `
        + `\u{1f4a5} ${e.enemy.toFixed(2)} `
        + `(${ratio}x)`
      );
    });

    const embed = new EmbedBuilder()
      .setTitle("Flashbang Shame")
      .setColor(0xffff00)
      .setDescription(
        `\u{1f91d} = team | \u{1f4a5} = enemy\n\n`
        + lines.join("\n")
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("Flash error:", err);
    await interaction.editReply(
      "Failed to fetch stats. Try again later."
    );
  }
}
