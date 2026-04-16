import { SlashCommandBuilder } from "discord.js";
import { leetifyEmbed } from "../helpers.js";
import { fetchInventorySummary, type InventoryItem } from "../inventory.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("inv")
  .setDescription("Show a player's CS2 inventory & value")
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Discord user (must be linked)"),
  );

function wearName(f: number): string {
  if (f < 0.07) return "FN";
  if (f < 0.15) return "MW";
  if (f < 0.38) return "FT";
  if (f < 0.45) return "WW";
  return "BS";
}

function formatItem(item: InventoryItem): string {
  // Link to the item's Steam Market page — always https (Discord renders it),
  // works on every client, shows the item image and live listings.
  const marketUrl = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(item.name)}`;
  const namePart = `[${item.name}](${marketUrl})`;
  const floatPart =
    item.float != null
      ? ` \u2022 float \`${item.float.toFixed(4)}\` (${wearName(item.float)})`
      : "";
  const seedPart = item.paintSeed != null ? ` \u2022 seed \`#${item.paintSeed}\`` : "";
  return `\u2022 ${namePart} \u2014 £${item.price.toFixed(2)}${floatPart}${seedPart}`;
}

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
    `**${inv.totalItems}** items \u2022 **£${inv.totalValue.toFixed(2)}** est. value`,
    "",
    ...inv.top5.map(formatItem),
  ];
  if (!inv.top5.length) lines.push("No priced items found.");

  const embed = leetifyEmbed(`${label}'s Inventory`).setDescription(lines.join("\n"));
  await interaction.editReply({ embeds: [embed] });
});
