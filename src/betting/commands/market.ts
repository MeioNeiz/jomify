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
import { requireLinkedUser, wrapCommand } from "../../commands/handler.js";
import { registerComponent } from "../../components.js";
import { getTrackedPlayers } from "../../cs/store.js";
import log from "../../logger.js";
import { embed } from "../../ui.js";
// Side-effect import: registers the dispute component handlers. Kept
// here (not commands/index.ts) so the market module owns the
// surfaces that share its lifecycle.
import "../disputes.js";
import { DEFAULT_EXPIRY_HOURS, DISPUTE_COST, LMSR_RAKE } from "../config.js";
import { lmsrExpectedPayout, lmsrProb } from "../lmsr.js";
import { lookup } from "../resolvers/index.js";
import {
  cancelBet,
  createBet,
  extendBet,
  getBalance,
  getBet,
  getOpenDisputeForBet,
  getWagersForBet,
  listOpenBets,
  type Outcome,
  placeWager,
  resolveBet,
  setBetMessage,
} from "../store.js";
import {
  CURRENCY,
  MARKET_BUTTONS,
  MARKET_COPY,
  MARKET_DURATIONS,
  MARKET_EMBED_COLOUR,
  MARKET_EMOJI,
} from "../ui.js";

export const data = new SlashCommandBuilder()
  .setName("market")
  .setDescription("LMSR prediction markets — back yes or no, odds shift as bets arrive")
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
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Auto-close + refund after this long (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cs-next-match")
      .setDescription("Auto-resolving market on a tracked player's next match")
      .addUserOption((opt) =>
        opt
          .setName("player")
          .setDescription("Linked Discord user to watch (must be tracked in this server)")
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("outcome")
          .setDescription("What decides yes/no")
          .setRequired(true)
          .addChoices(
            { name: "win (yes if they win)", value: "win" },
            { name: "rating above threshold", value: "rating-above" },
            { name: "kills above threshold", value: "kills-above" },
          ),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("probability")
          .setDescription("Your starting estimate for YES % (default: 50)")
          .addChoices(
            { name: "10%", value: 10 },
            { name: "20%", value: 20 },
            { name: "30%", value: 30 },
            { name: "40%", value: 40 },
            { name: "50% (even odds)", value: 50 },
            { name: "60%", value: 60 },
            { name: "70%", value: 70 },
            { name: "80%", value: 80 },
            { name: "90%", value: 90 },
          ),
      )
      .addNumberOption((opt) =>
        opt
          .setName("threshold")
          .setDescription("Required for rating-above / kills-above"),
      )
      .addStringOption((opt) => {
        opt
          .setName("duration")
          .setDescription(
            `Auto-cancel + refund if no match lands in this window (default: ${DEFAULT_EXPIRY_HOURS}h)`,
          );
        for (const d of MARKET_DURATIONS) opt.addChoices({ name: d.name, value: d.name });
        return opt;
      }),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Show open markets in this server"),
  );

// ── Market view rendering ────────────────────────────────────────────

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

  const allWagers = getWagersForBet(betId);
  let yesAmount = 0;
  let noAmount = 0;
  for (const w of allWagers) {
    if (w.outcome === "yes") yesAmount += w.amount;
    else noAmount += w.amount;
  }
  const total = yesAmount + noAmount;

  // ── Header lines ─────────────────────────────────────────────────────
  const descLines: string[] = [];

  if (bet.status === "open" && bet.b > 0) {
    // Live LMSR probability — this is what the market thinks, shifting
    // with each bet. Show it first so it's the most prominent signal.
    const p = lmsrProb(bet.qYes, bet.qNo, bet.b);
    const pctYes = Math.round(p * 100);
    const pctNo = 100 - pctYes;
    descLines.push(`📊 YES **${pctYes}%** · NO **${pctNo}%**`);
  }

  if (bet.status === "resolved") {
    descLines.push(
      `${MARKET_EMOJI.resolved} ${MARKET_COPY.resolvedPrefix}: **${bet.winningOutcome?.toUpperCase()}**`,
    );
  } else if (bet.status === "cancelled") {
    descLines.push(MARKET_COPY.cancelledLine);
  } else {
    descLines.push(
      `${MARKET_COPY.volumeLabel}: ${MARKET_EMOJI.yes} **${yesAmount}** yes · ` +
        `${MARKET_EMOJI.no} **${noAmount}** no (**${total}** total)`,
    );
  }

  descLines.push(`${MARKET_COPY.creatorPrefix} <@${bet.creatorDiscordId}>`);

  if (bet.status === "open" && bet.resolverKind) {
    const resolver = lookup(bet.resolverKind);
    const args = bet.resolverArgs ? (JSON.parse(bet.resolverArgs) as unknown) : null;
    descLines.push(
      resolver?.describe?.(args) ?? "Auto-resolves when its upstream event lands.",
    );
  }
  if (bet.status === "open" && bet.expiresAt) {
    const unix = Math.floor(new Date(`${bet.expiresAt}Z`).getTime() / 1000);
    descLines.push(`Closes <t:${unix}:R>`);
  }

  const openDispute = bet.status === "resolved" ? getOpenDisputeForBet(bet.id) : null;
  if (openDispute) {
    descLines.push(`\u26A0\uFE0F Dispute #${openDispute.id} pending admin ruling.`);
  }

  // ── Bet lines ─────────────────────────────────────────────────────────
  descLines.push("", `__${MARKET_COPY.betsLabel}__`);
  if (allWagers.length === 0) {
    descLines.push(MARKET_COPY.emptyBets);
  } else {
    for (const w of allWagers) {
      const side = w.outcome === "yes" ? MARKET_EMOJI.yes : MARKET_EMOJI.no;
      if (bet.b > 0 && w.shares > 0) {
        descLines.push(
          `${side} <@${w.discordId}> \u2014 **${w.amount}** \u21a6 **${w.shares.toFixed(1)}** shares`,
        );
      } else {
        descLines.push(
          `${side} <@${w.discordId}> \u2014 **${w.amount}** on ${w.outcome}`,
        );
      }
    }
  }

  if (bet.status === "open") descLines.push("", MARKET_COPY.footerOpen);

  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(MARKET_COPY.title(bet.id, bet.question))
    .setDescription(descLines.join("\n"));

  if (bet.status === "resolved" && !openDispute) {
    const reportRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`dispute:report:${bet.id}`)
        .setLabel(`Report (${DISPUTE_COST} shekels)`)
        .setEmoji("\u26A0\uFE0F")
        .setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [e], components: [reportRow] };
  }
  if (bet.status !== "open") {
    return { embeds: [e], components: [] };
  }

  const betRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`market:wager:${bet.id}:yes`, MARKET_BUTTONS.betYes),
    button(`market:wager:${bet.id}:no`, MARKET_BUTTONS.betNo),
  );
  const extendBtn = button(`market:extend:${bet.id}`, MARKET_BUTTONS.extend);
  if (bet.resolverKind) {
    const extendRow = new ActionRowBuilder<ButtonBuilder>().addComponents(extendBtn);
    return { embeds: [e], components: [betRow, extendRow] };
  }
  const resolveRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`market:resolve:${bet.id}:yes`, MARKET_BUTTONS.resolveYes),
    button(`market:resolve:${bet.id}:no`, MARKET_BUTTONS.resolveNo),
    extendBtn,
  );
  return { embeds: [e], components: [betRow, resolveRow] };
}

// ── Slash handlers ───────────────────────────────────────────────────

function durationHours(choice: string | null): number {
  if (!choice) return DEFAULT_EXPIRY_HOURS;
  return MARKET_DURATIONS.find((d) => d.name === choice)?.hours ?? DEFAULT_EXPIRY_HOURS;
}

function expiryIso(hours: number): string {
  const when = new Date(Date.now() + hours * 3600 * 1000);
  return when.toISOString().replace("T", " ").replace(/\..+$/, "");
}

async function handleCreate(interaction: ChatInputCommandInteraction, guildId: string) {
  const question = interaction.options.getString("question", true);
  const probPct = interaction.options.getInteger("probability") ?? 50;
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));

  const id = createBet(guildId, interaction.user.id, question, expiresAt, {
    initialProb: probPct / 100,
  });
  await interaction.editReply(renderMarketView(id));

  try {
    const msg = await interaction.fetchReply();
    setBetMessage(id, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, betId: id }, "Couldn't capture market message pointer");
  }
}

const CS_NEXT_MATCH_KIND = {
  win: "cs:next-match-win",
  "rating-above": "cs:next-match-rating-above",
  "kills-above": "cs:next-match-kills-above",
} as const;

async function handleCsNextMatch(
  interaction: ChatInputCommandInteraction,
  guildId: string,
) {
  const resolved = await requireLinkedUser(interaction, "player");
  if (!resolved) return;
  const outcomeChoice = interaction.options.getString("outcome", true);
  const kind = CS_NEXT_MATCH_KIND[outcomeChoice as keyof typeof CS_NEXT_MATCH_KIND];
  if (!kind) {
    await interaction.editReply(`Unknown outcome: ${outcomeChoice}`);
    return;
  }
  const threshold = interaction.options.getNumber("threshold");
  if (kind !== "cs:next-match-win" && threshold === null) {
    await interaction.editReply(
      `\`${outcomeChoice}\` needs a \`threshold\`. Try a rating like 0.05 or a kill count like 20.`,
    );
    return;
  }

  const tracked = new Set(getTrackedPlayers(guildId));
  if (!tracked.has(resolved.steamId)) {
    await interaction.editReply(
      `${resolved.label} isn't tracked here. Add them with \`/track\` first.`,
    );
    return;
  }

  const question = (() => {
    if (kind === "cs:next-match-win")
      return `Will ${resolved.label} win their next match?`;
    if (kind === "cs:next-match-rating-above")
      return `Will ${resolved.label}'s next match rating be ≥ ${threshold}?`;
    return `Will ${resolved.label} get more than ${threshold} kills next match?`;
  })();

  const probPct = interaction.options.getInteger("probability") ?? 50;
  const durationChoice = interaction.options.getString("duration");
  const expiresAt = expiryIso(durationHours(durationChoice));

  const id = createBet(guildId, interaction.user.id, question, expiresAt, {
    resolverKind: kind,
    resolverArgs: {
      steamId: resolved.steamId,
      ...(threshold !== null ? { threshold } : {}),
    },
    initialProb: probPct / 100,
  });
  await interaction.editReply(renderMarketView(id));
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
    const allWagers = getWagersForBet(b.id);
    let yes = 0;
    let no = 0;
    for (const w of allWagers) {
      if (w.outcome === "yes") yes += w.amount;
      else no += w.amount;
    }
    const total = yes + no;
    const q = b.question.length > 90 ? `${b.question.slice(0, 89)}\u2026` : b.question;
    const pctStr =
      b.b > 0 ? ` · ${Math.round(lmsrProb(b.qYes, b.qNo, b.b) * 100)}% YES` : "";
    return new StringSelectMenuOptionBuilder()
      .setLabel(`#${b.id} ${q}`)
      .setValue(String(b.id))
      .setDescription(`${yes} yes / ${no} no (${total} total)${pctStr}`);
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId("market:pick")
    .setPlaceholder("Pick a market to view…")
    .addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle("Open markets")
    .setDescription(`${open.length} open. Pick one to bet on or resolve.`);
  await interaction.editReply({ embeds: [e], components: [row] });
}

export const execute = wrapCommand(async (interaction) => {
  const sub = interaction.options.getSubcommand(true);
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }
  if (sub === "create") await handleCreate(interaction, guildId);
  else if (sub === "cs-next-match") await handleCsNextMatch(interaction, guildId);
  else if (sub === "list") await handleList(interaction, guildId);
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
    const balance = getBalance(interaction.user.id);
    // Show current odds in the modal title so the user knows what they're
    // stepping into before they commit an amount.
    const oddsStr =
      bet.b > 0 ? ` — ${Math.round(lmsrProb(bet.qYes, bet.qNo, bet.b) * 100)}% YES` : "";
    const modal = new ModalBuilder()
      .setCustomId(`market:modal:${betId}:${outcome}`)
      .setTitle(`Bet ${outcome.toUpperCase()}${oddsStr} #${betId}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel(`${CURRENCY.label} to stake (you have ${balance})`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("e.g. 10")
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

    // Snapshot odds BEFORE placing (for the confirmation message).
    const betBefore = getBet(betId);
    const expectedPayout =
      betBefore?.b && betBefore.b > 0
        ? lmsrExpectedPayout(
            betBefore.qYes,
            betBefore.qNo,
            betBefore.b,
            amount,
            outcome,
            LMSR_RAKE,
          )
        : null;

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

    const payoutStr =
      expectedPayout !== null
        ? ` → **~${expectedPayout}** shekels if ${outcome.toUpperCase()} resolves`
        : "";
    await interaction.followUp({
      content: `Staked **${amount}** on **${outcome}**${payoutStr}. Balance: **${balance}**.`,
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
    if (bet.resolverKind) {
      await interaction.reply({
        content: "This market auto-resolves — admins can step in via the dispute flow.",
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

  if (action === "extend" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const bet = getBet(betId);
    if (!bet || bet.status !== "open") {
      await interaction.reply({ content: "This market is closed.", ephemeral: true });
      return;
    }
    if (
      bet.creatorDiscordId !== interaction.user.id &&
      !interaction.memberPermissions?.has("ManageGuild")
    ) {
      await interaction.reply({
        content: "Only the creator or an admin can extend this market.",
        ephemeral: true,
      });
      return;
    }
    const options = MARKET_DURATIONS.map((d) =>
      new StringSelectMenuOptionBuilder().setLabel(d.name).setValue(d.name),
    );
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`market:extendpick:${betId}`)
      .setPlaceholder("Extend deadline by…")
      .addOptions(options);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await interaction.reply({
      content: "Pick how far to push the deadline:",
      components: [row],
      ephemeral: true,
    });
    return;
  }

  if (action === "extendpick" && interaction.isStringSelectMenu()) {
    const betId = Number(parts[2]);
    const bet = getBet(betId);
    if (!bet || bet.status !== "open") {
      await interaction.update({ content: "This market is closed.", components: [] });
      return;
    }
    const durationName = interaction.values[0];
    const hours =
      MARKET_DURATIONS.find((d) => d.name === durationName)?.hours ??
      DEFAULT_EXPIRY_HOURS;
    const newExpiry = expiryIso(hours);
    try {
      extendBet(betId, newExpiry);
    } catch (err) {
      await interaction.update({ content: (err as Error).message, components: [] });
      return;
    }
    // Dismiss the ephemeral picker.
    await interaction.update({
      content: `Deadline pushed forward by **${durationName}**.`,
      components: [],
    });
    // Best-effort: edit the original market message so the new expiry timestamp
    // shows immediately without anyone else needing to interact with it.
    if (bet.channelId && bet.messageId) {
      try {
        const channel = await interaction.client.channels.fetch(bet.channelId);
        if (channel?.isTextBased()) {
          const msg = await channel.messages.fetch(bet.messageId);
          await msg.edit(renderMarketView(betId));
        }
      } catch (err) {
        log.warn({ err, betId }, "Couldn't edit market message after extend");
      }
    }
    return;
  }

  log.warn({ customId: interaction.customId }, "Unhandled market action");
});

// Re-exported so the expiry watcher can drive auto-cancel without
// routing through the component dispatcher.
export { cancelBet };
