import { SlashCommandBuilder } from "discord.js";
import { wrapCommand } from "../../commands/handler.js";
import { embed } from "../../ui.js";
import { getCreatorStats } from "../store.js";
import { CURRENCY, MARKET_EMBED_COLOUR } from "../ui.js";

export const data = new SlashCommandBuilder()
  .setName("creator-stats")
  .setDescription(`Your lifetime market-making P&L in ${CURRENCY.plural}`);

export const execute = wrapCommand(async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }
  const stats = getCreatorStats(interaction.user.id, guildId);
  if (stats.marketsCreated === 0) {
    await interaction.editReply(
      "You haven't made any LP markets yet. Open one with `/market create`.",
    );
    return;
  }
  const sign = (n: number) => (n >= 0 ? `+${n}` : String(n));
  const lines = [
    `Markets created: **${stats.marketsCreated}**`,
    `Stake deployed: **${stats.stakeDeployed}**`,
    `Settlements returned: **${stats.lifetimeSettle}**`,
    `Engagement bonuses: **${stats.lifetimeBonus}**`,
    `— — —`,
    `Net P&L: **${sign(stats.netPnL)}** ${CURRENCY.plural}`,
  ];
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle("Creator-LP stats")
    .setDescription(lines.join("\n"));
  await interaction.editReply({ embeds: [e] });
});
