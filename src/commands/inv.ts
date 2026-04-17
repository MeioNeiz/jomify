import { SlashCommandBuilder } from "discord.js";
import { fetchInventorySummary, type InventoryItem } from "../inventory.js";
import { embed } from "../ui.js";
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
  const extras: string[] = [];
  if (item.float != null) {
    extras.push(`float \`${item.float.toFixed(4)}\` (${wearName(item.float)})`);
  }
  if (item.paintSeed != null) extras.push(`seed \`#${item.paintSeed}\``);
  const tail = extras.length ? ` (${extras.join(", ")})` : "";
  return `- ${namePart} **£${item.price.toFixed(2)}**${tail}`;
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

  const e = embed().setTitle(`${label}'s Inventory`);

  if (inv.pricingSource === "disabled") {
    e.addFields({
      name: "Items",
      value: `${inv.totalItems}`,
      inline: true,
    }).setDescription(
      "-# Pricing disabled \u2014 set `CSFLOAT_API_KEY` in `.env` to enable value estimates.",
    );
    await interaction.editReply({ embeds: [e] });
    return;
  }

  e.addFields(
    { name: "Items", value: `${inv.totalItems}`, inline: true },
    { name: "Est. Value", value: `£${inv.totalValue.toFixed(2)}`, inline: true },
  );

  if (inv.top5.length) {
    e.addFields({
      name: "Top Items",
      value: inv.top5.map(formatItem).join("\n"),
      inline: false,
    });
  } else {
    e.setDescription("No priced items found.");
  }

  // Tag the provenance so users know when numbers are a fallback estimate.
  if (inv.pricingSource === "steam") {
    const existing = e.data.description;
    const note = "-# Prices from Steam Market (CSFloat missed some items).";
    e.setDescription(existing ? `${existing}\n${note}` : note);
  }

  await interaction.editReply({ embeds: [e] });
});
