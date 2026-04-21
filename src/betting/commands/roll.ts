// /roll — WoW-style dice roll. Pure random, no shekels.
import { randomInt } from "node:crypto";
import { type ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { wrapCommand } from "../../commands/handler.js";

const MAX_BOUND = 1_000_000;

export const data = new SlashCommandBuilder()
  .setName("roll")
  .setDescription("Roll a random number — settle disputes, loot rolls, etc.")
  .addIntegerOption((opt) =>
    opt
      .setName("max")
      .setDescription("Upper bound (default 100)")
      .setMinValue(1)
      .setMaxValue(MAX_BOUND),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("min")
      .setDescription("Lower bound (default 1)")
      .setMinValue(0)
      .setMaxValue(MAX_BOUND),
  );

async function handleRoll(interaction: ChatInputCommandInteraction): Promise<void> {
  const rawMin = interaction.options.getInteger("min") ?? 1;
  const rawMax = interaction.options.getInteger("max") ?? 100;
  const [min, max] = rawMin <= rawMax ? [rawMin, rawMax] : [rawMax, rawMin];
  // randomInt(min, max) is [min, max) — add 1 so max is inclusive.
  const roll = randomInt(min, max + 1);
  const name =
    interaction.member && "displayName" in interaction.member
      ? (interaction.member.displayName as string)
      : interaction.user.displayName;
  await interaction.editReply(`\uD83C\uDFB2 ${name} rolls **${roll}** (${min}–${max})`);
}

export const execute = wrapCommand(handleRoll);
