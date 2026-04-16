import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { setNotifyChannel } from "../store.js";
import { wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("setchannel")
  .setDescription("Set the channel for match notifications")
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("The channel for notifications")
      .setRequired(true),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const execute = wrapCommand(async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }
  const channel = interaction.options.getChannel("channel", true);
  setNotifyChannel(guildId, channel.id);
  await interaction.editReply(`Notifications will be posted in <#${channel.id}>.`);
});
