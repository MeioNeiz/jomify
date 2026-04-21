// /give — player-to-player shekel transfer. Atomic deduct+credit in one
// transaction with matching ledger rows (give-sent / give-received).
import { type ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { wrapCommand } from "../../commands/handler.js";
import { transferBalance } from "../store.js";
import { CURRENCY } from "../ui.js";

export const data = new SlashCommandBuilder()
  .setName("give")
  .setDescription(`Send ${CURRENCY.plural} to another user`)
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Recipient").setRequired(true),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("amount")
      .setDescription(`${CURRENCY.label} to send`)
      .setRequired(true)
      .setMinValue(1),
  );

async function handleGive(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const senderId = interaction.user.id;

  if (target.id === senderId) {
    await interaction.editReply("Can't give to yourself.");
    return;
  }
  if (target.bot) {
    await interaction.editReply("Bots don't carry shekels, mate.");
    return;
  }

  const result = transferBalance(senderId, target.id, guildId, amount);
  if (result.kind === "insufficient-funds") {
    await interaction.editReply(
      `You've only got **${CURRENCY.format(result.balance)}** — not enough to send **${CURRENCY.format(amount)}**.`,
    );
    return;
  }

  await interaction.editReply(
    `\uD83D\uDCB8 <@${senderId}> sent **${CURRENCY.format(amount)}** to <@${target.id}>.\n` +
      `-# Your balance: **${CURRENCY.format(result.senderBalance)}**`,
  );
}

export const execute = wrapCommand(handleGive);
