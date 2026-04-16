import { SlashCommandBuilder } from "discord.js";
import { fmt, freshnessSuffix, leetifyEmbed } from "../helpers.js";
import {
  getProfileWithFallback,
  isFullProfile,
  requireLinkedUser,
  wrapCommand,
} from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Show a player's CS2 stats")
  .addUserOption((opt) => opt.setName("user").setDescription("Player to look up"));

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;

  const { data: p, cached, snapshotAt } = await getProfileWithFallback(resolved.steamId);

  const name = isFullProfile(p) ? p.name : p.name;
  const premier = isFullProfile(p) ? p.ranks?.premier : p.premier;
  const leetify = isFullProfile(p) ? p.ranks?.leetify : p.leetify;
  const rating = isFullProfile(p) ? p.rating : p;

  const embed = leetifyEmbed(cached ? `${name} (cached)` : name).addFields(
    { name: "Leetify Rating", value: fmt(leetify), inline: true },
    { name: "Aim", value: fmt(rating?.aim), inline: true },
    { name: "Positioning", value: fmt(rating?.positioning), inline: true },
    { name: "Utility", value: fmt(rating?.utility), inline: true },
    { name: "Clutch", value: fmt(rating?.clutch, 2), inline: true },
    { name: "Premier", value: premier?.toLocaleString() ?? "N/A", inline: true },
  );

  if (cached)
    embed.setDescription(freshnessSuffix(snapshotAt, "cached — last synced").trim());

  await interaction.editReply({ embeds: [embed] });
});
