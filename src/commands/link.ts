import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { linkAccount } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("link")
  .setDescription(
    "Link a Discord account to a Steam ID"
  )
  .addStringOption((opt) =>
    opt
      .setName("steamid")
      .setDescription("Steam64 ID")
      .setRequired(true)
  )
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription(
        "Discord user to link (defaults to yourself)"
      )
  );

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  const steamId = interaction.options.getString(
    "steamid", true
  );
  const user = interaction.options.getUser("user");
  const discordId = user?.id ?? interaction.user.id;

  linkAccount(discordId, steamId);
  await interaction.reply(
    `Linked <@${discordId}> to \`${steamId}\`.`
  );
}
