import { SlashCommandBuilder } from "discord.js";
import { leetifyEmbed } from "../helpers.js";
import { fetchInventorySummary } from "../inventory.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("inv")
  .setDescription("Show a player's CS2 inventory & value")
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Discord user (must be linked)"),
  );

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;
  const { steamId, label } = resolved;

  const inv = await fetchInventorySummary(steamId);
  if (inv === "private") {
    await interaction.editReply(
      "Inventory is private \u2014 needs to be public on Steam.",
    );
    return;
  }
  if (inv === "error") {
    await interaction.editReply("Failed to fetch inventory \u2014 try later.");
    return;
  }

  const lines = [
    `**${inv.totalItems}** items \u2022 **$${inv.totalValue.toFixed(2)}** est. value`,
  ];
  for (const item of inv.top5) lines.push(`\u2022 ${item.name} \u2014 ${item.priceStr}`);
  if (!inv.top5.length) lines.push("No priced items found.");

  const embed = leetifyEmbed(`${label}'s Inventory`).setDescription(lines.join("\n"));
  await interaction.editReply({ embeds: [embed] });
});
