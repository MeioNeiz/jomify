import {
  ActionRowBuilder,
  ButtonBuilder,
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
  cancelBet,
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
  setBetMessage,
} from "../store.js";
import {
  MARKET_BUTTONS,
  MARKET_COPY,
  MARKET_DURATIONS,
  MARKET_EMBED_COLOUR,
  MARKET_EMOJI,
} from "../ui.js";

export const data = new SlashCommandBuilder()
  .setName("market")
  .setDescription("Polymarket-style yes/no prediction markets")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Open a new prediction market")
      .addStringOption((opt) =>
        opt
          .setName("question")
          .setDescription("What are people predicting on?")
          .setRequired(true)
          .setMaxLength(200),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription("Auto-close + refund after this long (default: never)");
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Show open markets in this server"),
  )
  .addSubcommand((sub) =>
    sub.setName("balance").setDescription("Show your credits and recent ledger"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("leaderboard")
      .setDescription("Credit leaderboard")
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

// ── Market view rendering ────────────────────────────────────────────

type Pool = { yes: number; no: number; total: number };

function poolFor(betId: number): Pool {
  const rows = getWagersForBet(betId);
  let yes = 0;
  let no = 0;
  for (const w of rows) {
    if (w.outcome === "yes") yes += w.amount;
    else no += w.amount;
  }
  return { yes, no, total: yes + no };
}

function positionLines(betId: number): string[] {
  const rows = getWagersForBet(betId);
  return rows.map((w) => {
    const side = w.outcome === "yes" ? MARKET_EMOJI.yes : MARKET_EMOJI.no;
    return `${side} <@${w.discordId}> \u2014 **${w.amount}** on ${w.outcome}`;
  });
}

function button(
  customId: string,
  cfg: { style: number; label: string; emoji?: string },
): ButtonBuilder {
  const b = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(cfg.label)
    .setStyle(cfg.style);
  if (cfg.emoji) b.setEmoji(cfg.emoji);
  return b;
}

export function renderMarketView(
  betId: number,
): MessageEditOptions & InteractionReplyOptions {
  const bet = getBet(betId);
  if (!bet) {
    return { content: `Market #${betId} doesn't exist.`, embeds: [], components: [] };
  }
  const pool = poolFor(betId);
  const positions = positionLines(betId);

  const header = (() => {
    if (bet.status === "resolved") {
      return `${MARKET_EMOJI.resolved} ${MARKET_COPY.resolvedPrefix}: **${bet.winningOutcome?.toUpperCase()}**`;
    }
    if (bet.status === "cancelled") {
      return MARKET_COPY.cancelledLine;
    }
    return (
      `${MARKET_COPY.volumeLabel}: ${MARKET_EMOJI.yes} **${pool.yes}** yes · ` +
      `${MARKET_EMOJI.no} **${pool.no}** no (**${pool.total}** total)`
    );
  })();

  const desc = [header, `${MARKET_COPY.creatorPrefix} <@${bet.creatorDiscordId}>`];
  if (bet.status === "open" && bet.expiresAt) {
    // Discord's <t:epoch:R> renders a live-updating relative timestamp,
    // so "closes in 3 hours" auto-reflows without us resending messages.
    const unix = Math.floor(new Date(`${bet.expiresAt}Z`).getTime() / 1000);
    desc.push(`Closes <t:${unix}:R>`);
  }
  desc.push("");
  desc.push(`__${MARKET_COPY.positionsLabel}__`);
  desc.push(positions.length ? positions.join("\n") : MARKET_COPY.emptyPositions);
  if (bet.status === "open") desc.push("", MARKET_COPY.footerOpen);

  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(MARKET_COPY.title(bet.id, bet.question))
    .setDescription(desc.join("\n"));

  if (bet.status !== "open") {
    return { embeds: [e], components: [] };
  }

  const buyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`market:wager:${bet.id}:yes`, MARKET_BUTTONS.buyYes),
    button(`market:wager:${bet.id}:no`, MARKET_BUTTONS.buyNo),
  );
  const resolveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`market:resolve:${bet.id}:yes`, MARKET_BUTTONS.resolveYes),
    button(`market:resolve:${bet.id}:no`, MARKET_BUTTONS.resolveNo),
  );
  return { embeds: [e], components: [buyRow, resolveRow] };
}

// ── Slash handlers ───────────────────────────────────────────────────

function durationHours(choice: string | null): number | null {
  if (!choice) return null;
  return MARKET_DURATIONS.find((d) => d.name === choice)?.hours ?? null;
}

function expiryIso(hours: number | null): string | null {
  if (!hours) return null;
  const when = new Date(Date.now() + hours * 3600 * 1000);
  // Match SQLite's datetime('now') format ('YYYY-MM-DD HH:MM:SS', UTC).
  return when.toISOString().replace("T", " ").replace(/\..+$/, "");
}

async function handleCreate(interaction: ChatInputCommandInteraction, guildId: string) {
  const question = interaction.options.getString("question", true);
  const durationChoice = interaction.options.getString("duration");
  const hours = durationHours(durationChoice);
  const expiresAt = expiryIso(hours);

  const id = createBet(guildId, interaction.user.id, question, expiresAt);
  await interaction.editReply(renderMarketView(id));

  // Capture the Discord message pointer so the expiry watcher can edit
  // this same post when it auto-cancels. Best-effort: if the fetch
  // fails the market still works, it just can't update its own message
  // on expiry (the auto-cancel still refunds).
  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

async function handleList(interaction: ChatInputCommandInteraction, guildId: string) {
  const open = listOpenBets(guildId);
  if (!open.length) {
    await interaction.editReply("No open markets. Start one with `/market create`.");
    return;
  }
  const options = open.slice(0, 25).map((b) => {
    const pool = poolFor(b.id);
    const q = b.question.length > 90 ? `${b.question.slice(0, 89)}\u2026` : b.question;
    return new StringSelectMenuOptionBuilder()
      .setLabel(`#${b.id} ${q}`)
      .setValue(String(b.id))
      .setDescription(`${pool.yes} yes / ${pool.no} no (${pool.total} total)`);
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId("market:pick")
    .setPlaceholder("Pick a market to view…")
    .addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle("Open markets")
    .setDescription(`${open.length} open. Pick one to buy in or resolve.`);
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
  const guildId = interaction.guildId;
  const guildOnly = sub === "create" || sub === "list";
  if (guildOnly && !guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }
  if (sub === "create") await handleCreate(interaction, guildId as string);
  else if (sub === "list") await handleList(interaction, guildId as string);
  else if (sub === "balance") await handleBalance(interaction);
  else if (sub === "leaderboard") await handleLeaderboard(interaction);
  else await interaction.editReply(`Unknown subcommand: ${sub}`);
});

// ── Component handlers ───────────────────────────────────────────────
//
// customId grammar:
//   market:wager:<id>:<outcome>    — button, opens amount modal
//   market:modal:<id>:<outcome>    — modal submit, places position
//   market:resolve:<id>:<outcome>  — button, creator-only resolve
//   market:pick                    — select menu, posts market view
registerComponent("market", async (interaction) => {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "pick" && interaction.isStringSelectMenu()) {
    const betId = Number(interaction.values[0]);
    if (!Number.isInteger(betId)) return;
    await interaction.reply({ ...renderMarketView(betId) });
    return;
  }

  if (action === "wager" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const outcome = parts[3] as Outcome;
    const bet = getBet(betId);
    if (!bet || bet.status !== "open") {
      await interaction.reply({ content: "This market is closed.", ephemeral: true });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`market:modal:${betId}:${outcome}`)
      .setTitle(`Buy ${outcome.toUpperCase()} \u2014 market #${betId}`)
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
    if (interaction.isFromMessage()) {
      await interaction.update(renderMarketView(betId));
    }
    await interaction.followUp({
      content: `Bought **${amount}** on **${outcome}** (market #${betId}). Balance: **${balance}**.`,
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
        content: `Market #${betId} doesn't exist.`,
        ephemeral: true,
      });
      return;
    }
    if (bet.creatorDiscordId !== interaction.user.id) {
      await interaction.reply({
        content: "Only the creator can resolve this market.",
        ephemeral: true,
      });
      return;
    }
    if (bet.status !== "open") {
      await interaction.reply({
        content: `Market #${betId} is already ${bet.status}.`,
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
    await interaction.update(renderMarketView(betId));
    return;
  }

  log.warn({ customId: interaction.customId }, "Unhandled market action");
});

// Re-exported so the expiry watcher can drive auto-cancel without
// routing through the component dispatcher.
export { cancelBet };
