import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { analyseStats, SUSPECT_THRESHOLD } from "../analyse.js";
import { freshnessSuffix } from "../helpers.js";
import { fetchInventorySummary } from "../inventory.js";
import { getPlayerMatchStats } from "../store.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("sus")
  .setDescription("Is this player sussy?")
  .addUserOption((opt) => opt.setName("user").setDescription("Player to investigate"));

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;
  const { steamId, label } = resolved;

  const matches = getPlayerMatchStats(steamId, 20);
  if (!matches.length) {
    await interaction.editReply(`No match data for ${label}. Track them first.`);
    return;
  }

  const { checks, score } = analyseStats(matches.map((m) => m.raw));

  let verdict: string;
  let colour: number;
  if (score >= 8) {
    verdict = "Suss \u{1F6A9}";
    colour = 0xed4245;
  } else if (score >= SUSPECT_THRESHOLD) {
    verdict = "Sussy \u26A0\uFE0F";
    colour = 0xfee75c;
  } else {
    verdict = "Clean \u2705";
    colour = 0x57f287;
  }

  const lines = checks
    .filter((c) => c.flagged || c.z > 1.5)
    .map((c) => `${c.flagged ? "\u26A0\uFE0F" : "\u2705"} **${c.name}**: ${c.value}`);

  if (!lines.length) {
    const top = [...checks].sort((a, b) => b.z - a.z).slice(0, 3);
    for (const c of top) lines.push(`\u2705 **${c.name}**: ${c.value}`);
  }

  // Inventory check — expensive skins on a sussy account is a red flag
  const inv = await fetchInventorySummary(steamId);
  if (inv !== "private" && inv !== "error") {
    const valStr = `$${inv.totalValue.toFixed(2)}`;
    const topStr = inv.topItem
      ? `top: ${inv.topItem.name} ($${inv.topItem.price.toFixed(2)})`
      : "no priced items";
    lines.push(`\u{1F4B0} **Inventory**: ${valStr} \u2022 ${topStr}`);
  } else if (inv === "private") {
    lines.push(`\u{1F512} **Inventory**: private`);
  }

  const latest = matches[0]?.finishedAt ?? null;
  const embed = new EmbedBuilder()
    .setTitle(`${label} \u2014 ${verdict}`)
    .setColor(colour)
    .setDescription(lines.join("\n") + freshnessSuffix(latest, "most recent match"))
    .setFooter({
      text: `${matches.length} matches \u2022 z-scores vs competitive avg \u2022 not definitive`,
    });

  await interaction.editReply({ embeds: [embed] });
});
