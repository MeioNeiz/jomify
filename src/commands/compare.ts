import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getProfile } from "../leetify/client.js";

export const data = new SlashCommandBuilder()
  .setName("compare")
  .setDescription("Compare two players side by side")
  .addStringOption((opt) =>
    opt
      .setName("player1")
      .setDescription("Steam64 ID of first player")
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("player2")
      .setDescription("Steam64 ID of second player")
      .setRequired(true)
  );

function fmt(val: number | undefined): string {
  return val !== undefined ? val.toFixed(1) : "N/A";
}

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  const id1 = interaction.options.getString("player1", true);
  const id2 = interaction.options.getString("player2", true);

  try {
    const [p1, p2] = await Promise.all([
      getProfile(id1),
      getProfile(id2),
    ]);

    const fields = [
      "leetifyRating",
      "aim",
      "positioning",
      "utility",
      "clutch",
    ] as const;

    const lines = fields.map((f) => {
      const v1 = p1.ratings?.[f];
      const v2 = p2.ratings?.[f];
      const label = f.charAt(0).toUpperCase() + f.slice(1);
      return `**${label}**: ${fmt(v1)} vs ${fmt(v2)}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`${p1.meta.name} vs ${p2.meta.name}`)
      .setColor(0xf84982)
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Data Provided by Leetify" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(
      "Failed to fetch one or both profiles. "
      + "Check the Steam IDs are correct."
    );
  }
}
