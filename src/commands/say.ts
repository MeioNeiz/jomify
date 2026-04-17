import {
  ChannelType,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextBasedChannel,
} from "discord.js";
import log from "../logger.js";

export const data = new SlashCommandBuilder()
  .setName("say")
  .setDescription("Post a message as the bot")
  .addStringOption((opt) =>
    opt.setName("message").setDescription("What to say").setRequired(true),
  )
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("Channel to post in (defaults to current)")
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.AnnouncementThread,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
      ),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

// Bypasses wrapCommand so we can defer ephemerally — the invoker's "Sent."
// confirmation must not leak into the channel.
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    // Defence-in-depth: setDefaultMemberPermissions can be overridden by guild
    // admins in Discord's Integrations UI, so re-check at execution time.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.editReply("Admin only.");
      return;
    }

    const raw = interaction.options.getString("message", true);
    const message = raw.trim();
    if (!message) {
      await interaction.editReply("Message can't be empty.");
      return;
    }
    if (message.length > 2000) {
      await interaction.editReply(
        `Message is ${message.length} chars; Discord's limit is 2000.`,
      );
      return;
    }

    const picked = interaction.options.getChannel("channel");
    const target = (picked ?? interaction.channel) as TextBasedChannel | null;
    if (!target || !("send" in target) || typeof target.send !== "function") {
      await interaction.editReply("Can't post in that channel.");
      return;
    }

    try {
      // allowedMentions parse: [] lets admins write "@everyone" / "@here" /
      // role mentions in the text (e.g. quoting something) without Discord
      // actually firing the notification. Stripping would silently mangle
      // legitimate announcements; rejecting is too strict for admins. This
      // is the belt-and-braces middle ground.
      await target.send({ content: message, allowedMentions: { parse: [] } });
    } catch (err) {
      log.warn({ err, channelId: target.id }, "/say send failed");
      await interaction.editReply("Can't post in that channel.");
      return;
    }

    await interaction.editReply("Sent.");
  } catch (err) {
    log.error({ err }, "/say error");
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Something went wrong.");
      } else {
        await interaction.reply({
          content: "Something went wrong.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      /* interaction gone */
    }
  }
}
