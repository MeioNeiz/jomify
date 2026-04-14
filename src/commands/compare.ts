import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { getProfile } from "../leetify/client.js";
import { getSteamId } from "../store.js";
import { leetifyEmbed, fmt } from "../helpers.js";

export const data = new SlashCommandBuilder()
  .setName("compare")
  .setDescription("Compare two players side by side")
  .addUserOption((opt) =>
    opt
      .setName("user1")
      .setDescription("First player (Discord user)")
  )
  .addUserOption((opt) =>
    opt
      .setName("user2")
      .setDescription("Second player (Discord user)")
  )
  .addStringOption((opt) =>
    opt
      .setName("player1")
      .setDescription("First player Steam64 ID")
  )
  .addStringOption((opt) =>
    opt
      .setName("player2")
      .setDescription("Second player Steam64 ID")
  );

function resolveId(
  interaction: ChatInputCommandInteraction,
  userOpt: string,
  steamOpt: string
): string | null {
  const user = interaction.options.getUser(userOpt);
  if (user) return getSteamId(user.id);
  return interaction.options.getString(steamOpt);
}

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  const id1 = resolveId(interaction, "user1", "player1");
  const id2 = resolveId(interaction, "user2", "player2");

  if (!id1 || !id2) {
    await interaction.editReply(
      "Need two players. Use `user1`/`user2` or "
      + "`player1`/`player2` (Steam64 IDs)."
    );
    return;
  }

  try {
    const [p1, p2] = await Promise.all([
      getProfile(id1),
      getProfile(id2),
    ]);

    const fields = [
      ["Leetify Rating", "leetify"],
      ["Aim", "aim"],
      ["Positioning", "positioning"],
      ["Utility", "utility"],
      ["Clutch", "clutch"],
    ] as const;

    const lines = fields.map(([label, key]) => {
      const v1 = key === "leetify"
        ? p1.ranks?.[key]
        : p1.rating?.[key];
      const v2 = key === "leetify"
        ? p2.ranks?.[key]
        : p2.rating?.[key];
      return `**${label}**: ${fmt(v1)} vs ${fmt(v2)}`;
    });

    const embed = leetifyEmbed(`${p1.name} vs ${p2.name}`)
      .setDescription(lines.join("\n"));

    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply(
      "Failed to fetch one or both profiles. "
      + "Check the Steam IDs are correct."
    );
  }
}
