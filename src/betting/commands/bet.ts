import { type ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { wrapCommand } from "../../commands/handler.js";
import { embed, pad, rankPrefix, table } from "../../ui.js";
import {
  ensureAccount,
  getAllTimeWins,
  getBalance,
  getCurrentStandings,
  getRecentLedger,
} from "../store.js";
import { MARKET_EMBED_COLOUR } from "../ui.js";

export const data = new SlashCommandBuilder()
  .setName("bet")
  .setDescription("Your credits and the betting leaderboard")
  .addSubcommand((sub) =>
    sub.setName("balance").setDescription("Show your credits and recent ledger"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("leaderboard")
      .setDescription("Who's ahead on credits")
      .addStringOption((opt) =>
        opt
          .setName("view")
          .setDescription("Live balances this week, or all-time weeks won")
          .addChoices(
            { name: "current (this week)", value: "current" },
            { name: "all-time (weeks won)", value: "all-time" },
          ),
      ),
  );

async function handleBalance(interaction: ChatInputCommandInteraction) {
  // Seed on first view so the embed always shows the starting grant
  // instead of a confusing 0. Cheap + idempotent.
  const discordId = interaction.user.id;
  ensureAccount(discordId);
  const balance = getBalance(discordId);
  const ledgerRows = getRecentLedger(discordId, 8);
  const rows = ledgerRows.map((r) => {
    const sign = r.delta > 0 ? `+${r.delta}` : String(r.delta);
    const ref = r.ref ? `#${r.ref}` : "";
    return `${pad(r.at.slice(5, 16), 11)} ${pad(sign, 5)} ${pad(r.reason, 15)} ${ref}`;
  });
  const body = rows.length ? table(rows) : "_No activity yet._";
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle("Your balance")
    .setDescription(`**${balance} credits**\n\n${body}`);
  await interaction.editReply({ embeds: [e] });
}

async function handleLeaderboard(interaction: ChatInputCommandInteraction) {
  const view = interaction.options.getString("view") ?? "current";
  if (view === "all-time") {
    const rows = getAllTimeWins(10);
    if (!rows.length) {
      await interaction.editReply("No weeks resolved yet — check back Monday.");
      return;
    }
    const lines = rows.map((r, i) => {
      const wk = r.weeksWon === 1 ? "week" : "weeks";
      return `${rankPrefix(i)} <@${r.discordId}> \u2014 **${r.weeksWon}** ${wk} won`;
    });
    const e = embed(MARKET_EMBED_COLOUR)
      .setTitle("All-time leaderboard")
      .setDescription(lines.join("\n"));
    await interaction.editReply({ embeds: [e] });
    return;
  }

  const rows = getCurrentStandings(10);
  if (!rows.length) {
    await interaction.editReply("No balances yet — play a match to get started.");
    return;
  }
  const lines = rows.map(
    (r, i) => `${rankPrefix(i)} <@${r.discordId}> \u2014 **${r.balance}** credits`,
  );
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle("This week's standings")
    .setDescription(
      `${lines.join("\n")}\n-# Resets Monday 00:00 Europe/London. Top 3 get a weekly win archived.`,
    );
  await interaction.editReply({ embeds: [e] });
}

export const execute = wrapCommand(async (interaction) => {
  const sub = interaction.options.getSubcommand(true);
  if (sub === "balance") await handleBalance(interaction);
  else if (sub === "leaderboard") await handleLeaderboard(interaction);
  else await interaction.editReply(`Unknown subcommand: ${sub}`);
});
