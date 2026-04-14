import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { getProfile } from "../leetify/client.js";
import { getSteamId } from "../store.js";
import {
  leetifyEmbed,
  resolveSteamId,
  fmt,
} from "../helpers.js";

export const data = new SlashCommandBuilder()
  .setName("stats")
  .setDescription(
    "Show a player's CS2 stats"
  )
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription("Discord user (must be linked)")
  )
  .addStringOption((opt) =>
    opt
      .setName("steamid")
      .setDescription("Steam64 ID (if not linked)")
  );

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  let { steamId, userId } = resolveSteamId(interaction);

  if (userId && !steamId) {
    await interaction.editReply(
      `<@${userId}> hasn't linked their account. `
      + "They need to run `/link` first."
    );
    return;
  }

  if (!steamId) {
    steamId = getSteamId(interaction.user.id);
    if (!steamId) {
      await interaction.editReply(
        "Provide a `user` or `steamid`, "
        + "or `/link` your own account first."
      );
      return;
    }
  }

  try {
    const p = await getProfile(steamId);

    const embed = leetifyEmbed(p.name).addFields(
      {
        name: "Leetify Rating",
        value: fmt(p.ranks?.leetify),
        inline: true,
      },
      {
        name: "Aim",
        value: fmt(p.rating?.aim),
        inline: true,
      },
      {
        name: "Positioning",
        value: fmt(p.rating?.positioning),
        inline: true,
      },
      {
        name: "Utility",
        value: fmt(p.rating?.utility),
        inline: true,
      },
      {
        name: "Clutch",
        value: fmt(p.rating?.clutch, 2),
        inline: true,
      },
      {
        name: "Premier",
        value: p.ranks?.premier?.toLocaleString()
          ?? "N/A",
        inline: true,
      }
    );

    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply(
      `Failed to fetch stats for \`${steamId}\`. `
      + "Is the Steam ID correct and the profile "
      + "Is the Steam ID correct and the profile on Leetify?"
    );
  }
}
