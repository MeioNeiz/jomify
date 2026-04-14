import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { setNotifyChannel } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("setchannel")
  .setDescription(
    "Set the channel for match notifications"
  )
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("The channel for notifications")
      .setRequired(true)
  )
  .setDefaultMemberPermissions(
    PermissionFlagsBits.ManageGuild
  );

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply("Use this in a server.");
    return;
  }

  const channel = interaction.options.getChannel(
    "channel", true
  );
  setNotifyChannel(guildId, channel.id);
  await interaction.reply(
    `Notifications will be posted in <#${channel.id}>.`
  );
}
