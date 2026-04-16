import { decodeLink } from "@csfloat/cs2-inspect-serializer";
import { SlashCommandBuilder } from "discord.js";
import { leetifyEmbed } from "../helpers.js";
import { wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("float")
  .setDescription("Decode a CS2 inspect link — shows float, seed, stickers, rarity")
  .addStringOption((opt) =>
    opt
      .setName("url")
      .setDescription("Paste an inspect link (F6 in-game after right-click Inspect)")
      .setRequired(true),
  );

// Wear bands per Valve's standard float thresholds.
function wearName(f: number): string {
  if (f < 0.07) return "Factory New";
  if (f < 0.15) return "Minimal Wear";
  if (f < 0.38) return "Field-Tested";
  if (f < 0.45) return "Well-Worn";
  return "Battle-Scarred";
}

// CS2 rarity tiers. 7 is used for both knives and gloves.
const RARITY: Record<number, string> = {
  1: "Consumer Grade",
  2: "Industrial Grade",
  3: "Mil-Spec",
  4: "Restricted",
  5: "Classified",
  6: "Covert",
  7: "Exceedingly Rare",
};

export const execute = wrapCommand(async (interaction) => {
  const url = interaction.options.getString("url", true).trim();

  let decoded: ReturnType<typeof decodeLink>;
  try {
    decoded = decodeLink(url);
  } catch {
    await interaction.editReply(
      "Couldn't decode that link. Make sure it's a modern CS2 inspect link " +
        "(copy from inside CS2 with **F6** after right-click → Inspect). " +
        "Old-format Steam inventory links don't self-encode and can't be read here.",
    );
    return;
  }

  const lines: string[] = [];

  if (decoded.paintwear != null) {
    lines.push(
      `**Float**: \`${decoded.paintwear.toFixed(10)}\` (${wearName(decoded.paintwear)})`,
    );
  }
  if (decoded.paintseed != null) {
    lines.push(`**Paint seed**: \`#${decoded.paintseed}\``);
  }
  if (decoded.rarity != null) {
    const q = decoded.quality != null ? ` \u2022 **Quality**: ${decoded.quality}` : "";
    lines.push(`**Rarity**: ${RARITY[decoded.rarity] ?? `tier ${decoded.rarity}`}${q}`);
  }
  if (decoded.defindex != null || decoded.paintindex != null) {
    lines.push(
      `**defindex**: \`${decoded.defindex ?? "?"}\` \u2022 ` +
        `**paintindex**: \`${decoded.paintindex ?? "?"}\``,
    );
  }

  if (decoded.stickers.length) {
    const s = decoded.stickers
      .map((x) => {
        const wearStr = x.wear != null ? ` (${(x.wear * 100).toFixed(0)}% worn)` : "";
        return `\u2022 sticker \`#${x.stickerId ?? "?"}\` slot ${x.slot ?? "?"}${wearStr}`;
      })
      .join("\n");
    lines.push(`\n**Stickers**:\n${s}`);
  }

  if (decoded.keychains.length) {
    const k = decoded.keychains
      .map(
        (x) => `\u2022 keychain \`#${x.stickerId ?? "?"}\` pattern ${x.pattern ?? "?"}`,
      )
      .join("\n");
    lines.push(`\n**Keychains**:\n${k}`);
  }

  if (!lines.length) {
    lines.push("No decodable fields in that link.");
  }

  await interaction.editReply({
    embeds: [leetifyEmbed("Inspect").setDescription(lines.join("\n"))],
  });
});
