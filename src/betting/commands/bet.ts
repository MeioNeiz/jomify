import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type MessageEditOptions,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { wrapCommand } from "../../commands/handler.js";
import { registerComponent } from "../../components.js";
import log from "../../logger.js";
import { embed, pad, rankPrefix, table } from "../../ui.js";
import {
  createBet,
  ensureAccount,
  getAllTimeWins,
  getBalance,
  getBet,
  getCurrentStandings,
  getRecentLedger,
  getWagersForBet,
  listOpenBets,
  type Outcome,
  placeWager,
  resolveBet,
} from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("bet")
  .setDescription("Pari-mutuel prediction markets")
  .addSubcommand((sub) =>
    sub
      .setName("open")
      .setDescription("Create a new yes/no bet")
      .addStringOption((opt) =>
        opt
          .setName("question")
          .setDescription("The question people are betting on")
          .setRequired(true)
          .setMaxLength(200),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List open bets in this server"),
  )
  .addSubcommand((sub) =>
    sub.setName("balance").setDescription("Show your balance and recent ledger entries"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("leaderboard")
      .setDescription("Show the betting leaderboard")
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

// ── Interactive bet view ─────────────────────────────────────────────

type Pool = { yes: number; no: number; total: number };

function poolForBet(betId: number): Pool {
  const wagers = getWagersForBet(betId);
  let yes = 0;
  let no = 0;
  for (const w of wagers) {
    if (w.outcome === "yes") yes += w.amount;
    else no += w.amount;
  }
  return { yes, no, total: yes + no };
}

function wagerLines(betId: number): string[] {
  const rows = getWagersForBet(betId);
  return rows.map((w) => `\u2022 <@${w.discordId}>: **${w.amount}** on ${w.outcome}`);
}

/**
 * Render the bet message from current DB state. Used by /bet open,
 * /bet list, every button click, and every modal submit — one render
 * path, no drift.
 */
function renderBetView(betId: number): MessageEditOptions & InteractionReplyOptions {
  const bet = getBet(betId);
  if (!bet) {
    return { content: `Bet #${betId} doesn't exist.`, embeds: [], components: [] };
  }
  const pool = poolForBet(betId);
  const wagers = wagerLines(betId);

  const isResolved = bet.status !== "open";
  const colourKind = isResolved
    ? bet.winningOutcome === "yes"
      ? "success"
      : "danger"
    : "brand";

  const header = isResolved
    ? `Resolved: **${bet.winningOutcome?.toUpperCase()}**`
    : `Pool: 🟢 **${pool.yes}** yes · 🔴 **${pool.no}** no (total **${pool.total}**)`;

  const desc = [
    header,
    `Created by <@${bet.creatorDiscordId}>`,
    "",
    wagers.length ? wagers.join("\n") : "_No wagers yet._",
  ];
  if (!isResolved) {
    desc.push("", "-# Tap Yes or No to wager. Creator resolves with the bottom row.");
  }

  const e = embed(colourKind)
    .setTitle(`Bet #${bet.id} \u2014 ${bet.question}`)
    .setDescription(desc.join("\n"));

  if (isResolved) {
    return { embeds: [e], components: [] };
  }

  const wagerRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`bet:wager:${bet.id}:yes`)
      .setLabel("Bet Yes")
      .setEmoji("\u2705")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`bet:wager:${bet.id}:no`)
      .setLabel("Bet No")
      .setEmoji("\u274C")
      .setStyle(ButtonStyle.Danger),
  );
  const resolveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`bet:resolve:${bet.id}:yes`)
      .setLabel("Yes wins")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bet:resolve:${bet.id}:no`)
      .setLabel("No wins")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [wagerRow, resolveRow] };
}

// ── Slash handlers ───────────────────────────────────────────────────

async function handleOpen(interaction: ChatInputCommandInteraction, guildId: string) {
  const question = interaction.options.getString("question", true);
  const id = createBet(guildId, interaction.user.id, question);
  await interaction.editReply(renderBetView(id));
}

async function handleList(interaction: ChatInputCommandInteraction, guildId: string) {
  const open = listOpenBets(guildId);
  if (!open.length) {
    await interaction.editReply("No open bets. Start one with `/bet open`.");
    return;
  }
  const options = open.slice(0, 25).map((b) => {
    const pool = poolForBet(b.id);
    const q = b.question.length > 90 ? `${b.question.slice(0, 89)}\u2026` : b.question;
    return new StringSelectMenuOptionBuilder()
      .setLabel(`#${b.id} ${q}`)
      .setValue(String(b.id))
      .setDescription(`${pool.yes} yes / ${pool.no} no (${pool.total} total)`);
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId("bet:pick")
    .setPlaceholder("Pick a bet to view…")
    .addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const e = embed()
    .setTitle("Open bets")
    .setDescription(`${open.length} open. Pick one to bet on or resolve.`);
  await interaction.editReply({ embeds: [e], components: [row] });
}

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
  const e = embed()
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
    const e = embed().setTitle("All-time leaderboard").setDescription(lines.join("\n"));
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
  const e = embed()
    .setTitle("This week's standings")
    .setDescription(
      `${lines.join("\n")}\n-# Resets Monday 00:00 Europe/London. Top 3 get a weekly win archived.`,
    );
  await interaction.editReply({ embeds: [e] });
}

export const execute = wrapCommand(async (interaction) => {
  const sub = interaction.options.getSubcommand(true);
  const guildId = interaction.guildId;
  const guildOnly = sub === "open" || sub === "list";
  if (guildOnly && !guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }
  if (sub === "open") await handleOpen(interaction, guildId as string);
  else if (sub === "list") await handleList(interaction, guildId as string);
  else if (sub === "balance") await handleBalance(interaction);
  else if (sub === "leaderboard") await handleLeaderboard(interaction);
  else await interaction.editReply(`Unknown subcommand: ${sub}`);
});

// ── Component handlers ───────────────────────────────────────────────

// customId grammar:
//   bet:wager:<id>:<outcome>     — button, opens amount modal
//   bet:modal:<id>:<outcome>     — modal submit, places wager
//   bet:resolve:<id>:<outcome>   — button, creator-only resolve
//   bet:pick                     — select menu, posts a fresh bet view
registerComponent("bet", async (interaction) => {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "pick" && interaction.isStringSelectMenu()) {
    const betId = Number(interaction.values[0]);
    if (!Number.isInteger(betId)) return;
    await interaction.reply({ ...renderBetView(betId) });
    return;
  }

  if (action === "wager" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const outcome = parts[3] as Outcome;
    const bet = getBet(betId);
    if (!bet || bet.status !== "open") {
      await interaction.reply({ content: "This bet is closed.", ephemeral: true });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`bet:modal:${betId}:${outcome}`)
      .setTitle(`Wager on ${outcome.toUpperCase()} — bet #${betId}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel(`Credits to stake (balance: ${getBalance(interaction.user.id)})`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("e.g. 5")
            .setMinLength(1)
            .setMaxLength(6),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (action === "modal" && interaction.isModalSubmit()) {
    const betId = Number(parts[2]);
    const outcome = parts[3] as Outcome;
    const raw = interaction.fields.getTextInputValue("amount").trim();
    const amount = Number(raw);
    if (!Number.isInteger(amount) || amount <= 0) {
      await interaction.reply({
        content: `\`${raw}\` isn't a positive whole number.`,
        ephemeral: true,
      });
      return;
    }
    try {
      placeWager(betId, interaction.user.id, outcome, amount);
    } catch (err) {
      await interaction.reply({ content: (err as Error).message, ephemeral: true });
      return;
    }
    const balance = getBalance(interaction.user.id);
    // Update the public bet message, then confirm privately to the bettor.
    if (interaction.isFromMessage()) {
      await interaction.update(renderBetView(betId));
    }
    await interaction.followUp({
      content: `Wagered **${amount}** on **${outcome}** (bet #${betId}). Balance: **${balance}**.`,
      ephemeral: true,
    });
    return;
  }

  if (action === "resolve" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const outcome = parts[3] as Outcome;
    const bet = getBet(betId);
    if (!bet) {
      await interaction.reply({
        content: `Bet #${betId} doesn't exist.`,
        ephemeral: true,
      });
      return;
    }
    if (bet.creatorDiscordId !== interaction.user.id) {
      await interaction.reply({
        content: "Only the creator can resolve this bet.",
        ephemeral: true,
      });
      return;
    }
    if (bet.status !== "open") {
      await interaction.reply({
        content: `Bet #${betId} is already ${bet.status}.`,
        ephemeral: true,
      });
      return;
    }
    try {
      resolveBet(betId, outcome);
    } catch (err) {
      await interaction.reply({ content: (err as Error).message, ephemeral: true });
      return;
    }
    await interaction.update(renderBetView(betId));
    return;
  }

  log.warn({ customId: interaction.customId }, "Unhandled bet action");
});
