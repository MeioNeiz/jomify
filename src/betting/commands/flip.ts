// /flip — WoW-Trade-Chat-style public 1v1 coin flip. Challenger stakes
// shekels; target gets an embed with Accept / Decline buttons. On
// Accept we roll a fair coin (crypto.randomInt), animate the reveal
// across three edits, and credit the winner the full 2x stake. On
// Decline we refund the challenger and edit the embed to match. On
// timeout (3 min default) we lazy-expire: the background sweeper in
// src/betting/expiry.ts runs the sweep every 30 s, but Accept after
// the deadline also refunds-and-expires inline so we're correct even
// if the watcher is asleep.
import { randomInt } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Message,
  type MessageEditOptions,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { wrapCommand } from "../../commands/handler.js";
import { registerComponent } from "../../components.js";
import log from "../../logger.js";
import { embed } from "../../ui.js";
import {
  acceptFlip,
  declineFlip,
  type Flip,
  type FlipSide,
  getBalance,
  getFlip,
  getLastAcceptedFlipForUser,
  getOpenFlipForUser,
  openFlip,
  setFlipMessage,
} from "../store.js";
import { CURRENCY, MARKET_EMBED_COLOUR } from "../ui.js";

// ── Config ───────────────────────────────────────────────────────────

const EXPIRY_MS = 3 * 60_000; // 3 min challenge window
const COOLDOWN_MS = 60_000; // 60 s between accepted flips
const FRAME_MS = 500; // animation pacing

// ── Slash ────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("flip")
  .setDescription(`Challenge another user to a 1v1 coin flip for ${CURRENCY.plural}`)
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Who are you flipping against?").setRequired(true),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("amount")
      .setDescription(`${CURRENCY.label} to stake`)
      .setRequired(true)
      .setMinValue(1),
  );

// ── Rendering ────────────────────────────────────────────────────────

function challengeView(flip: Flip): MessageEditOptions {
  const acceptBy = Math.floor(new Date(`${flip.expiresAt}Z`).getTime() / 1000);
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`\uD83E\uDE99 Coin flip #${flip.id}`)
    .setDescription(
      [
        `<@${flip.challengerId}> challenges <@${flip.targetId}> for ` +
          `**${CURRENCY.format(flip.amount)}**.`,
        "",
        "Heads: challenger wins. Tails: target wins. Winner takes the lot.",
        `Expires <t:${acceptBy}:R>.`,
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`flip:accept:${flip.id}`)
      .setLabel("Accept")
      .setEmoji("\u2705")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`flip:decline:${flip.id}`)
      .setLabel("Decline")
      .setEmoji("\u274C")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [row] };
}

function flippingView(flip: Flip, frame: 0 | 1): MessageEditOptions {
  const coin = frame === 0 ? "\uD83E\uDE99" : "\u2728";
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`${coin} Coin flip #${flip.id} — flipping…`)
    .setDescription(
      [
        `<@${flip.challengerId}> vs <@${flip.targetId}>`,
        `Stake: **${CURRENCY.format(flip.amount)}** each — pot **${CURRENCY.format(flip.amount * 2)}**`,
        "",
        frame === 0 ? "\uD83E\uDE99 flipping\u2026" : "\u2728 flipping\u2026",
      ].join("\n"),
    );
  return { embeds: [e], components: [] };
}

function resultView(flip: Flip, side: FlipSide, winnerId: string): MessageEditOptions {
  const isHeads = side === "heads";
  const icon = isHeads ? "\uD83D\uDFE2" : "\uD83D\uDD34";
  const face = isHeads ? "HEADS" : "TAILS";
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`${icon} ${face}! — coin flip #${flip.id}`)
    .setDescription(
      [
        `<@${flip.challengerId}> vs <@${flip.targetId}>`,
        `Stake: **${CURRENCY.format(flip.amount)}** each`,
        "",
        `\uD83C\uDFC6 <@${winnerId}> scoops **${CURRENCY.format(flip.amount * 2)}**.`,
      ].join("\n"),
    );
  return { embeds: [e], components: [] };
}

function declinedView(flip: Flip): MessageEditOptions {
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`\uD83E\uDE99 Coin flip #${flip.id} — declined`)
    .setDescription(
      `<@${flip.targetId}> declined. Stake refunded to <@${flip.challengerId}>.`,
    );
  return { embeds: [e], components: [] };
}

export function expiredView(flip: Flip): MessageEditOptions {
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`\uD83E\uDE99 Coin flip #${flip.id} — expired`)
    .setDescription(
      `No response from <@${flip.targetId}>. Stake refunded to <@${flip.challengerId}>.`,
    );
  return { embeds: [e], components: [] };
}

// ── Slash handler ────────────────────────────────────────────────────

async function handleFlip(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const challengerId = interaction.user.id;

  if (target.id === challengerId) {
    await interaction.editReply("Can't flip yourself — find a mark.");
    return;
  }
  if (target.bot) {
    await interaction.editReply("Bots don't carry shekels, mate.");
    return;
  }

  // Cooldown: 60 s since the user's last accepted flip in this guild.
  const last = getLastAcceptedFlipForUser(challengerId, guildId);
  if (last?.resolvedAt) {
    const sinceMs = Date.now() - new Date(`${last.resolvedAt}Z`).getTime();
    if (sinceMs < COOLDOWN_MS) {
      const waitS = Math.ceil((COOLDOWN_MS - sinceMs) / 1000);
      await interaction.editReply(`Cooling off — try again in **${waitS}s**.`);
      return;
    }
  }

  // One open challenge at a time (either side of the table).
  const openForChallenger = getOpenFlipForUser(challengerId, guildId);
  if (openForChallenger) {
    await interaction.editReply(
      `You've already got coin flip #${openForChallenger.id} open — resolve it first.`,
    );
    return;
  }
  const openForTarget = getOpenFlipForUser(target.id, guildId);
  if (openForTarget) {
    await interaction.editReply(
      `<@${target.id}> already has coin flip #${openForTarget.id} open — wait for it to settle.`,
    );
    return;
  }

  // Pre-check the challenger's balance for a friendlier message than
  // the store's "Insufficient balance" throw.
  const balance = getBalance(challengerId, guildId);
  if (balance < amount) {
    await interaction.editReply(
      `You've only got **${CURRENCY.format(balance)}** — not enough to stake **${amount}**.`,
    );
    return;
  }

  let flipId: number;
  try {
    flipId = openFlip({
      guildId,
      challengerId,
      targetId: target.id,
      amount,
      expiresInMs: EXPIRY_MS,
    });
  } catch (err) {
    await interaction.editReply((err as Error).message);
    return;
  }
  const flip = getFlip(flipId);
  if (!flip) {
    // Shouldn't happen — we just wrote it. Defensive log + bail.
    log.error({ flipId }, "Flip vanished right after openFlip");
    await interaction.editReply("Something went wrong opening the flip.");
    return;
  }

  await interaction.editReply({
    content: `<@${target.id}>`,
    allowedMentions: { users: [target.id] },
    ...challengeView(flip),
  });
  try {
    const msg = await interaction.fetchReply();
    setFlipMessage(flipId, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, flipId }, "Couldn't capture flip message pointer");
  }
}

export const execute = wrapCommand(handleFlip);

// ── Component handlers ───────────────────────────────────────────────
//
// customId grammar:
//   flip:accept:<id>    — target clicks Accept
//   flip:decline:<id>   — target clicks Decline
registerComponent("flip", async (interaction) => {
  if (!interaction.isButton()) return;
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const flipId = Number(parts[2]);
  if (!Number.isInteger(flipId)) return;

  const flip = getFlip(flipId);
  if (!flip) {
    await interaction.reply({
      content: "That coin flip doesn't exist.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (flip.status !== "open") {
    await interaction.reply({
      content: `This coin flip is already ${flip.status}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Only the target may click the buttons. Challenger can't accept
  // their own flip; bystanders can't either.
  if (interaction.user.id !== flip.targetId) {
    await interaction.reply({
      content: `Only <@${flip.targetId}> can respond to this flip.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "decline") {
    const after = declineFlip(flipId) ?? flip;
    await interaction.update(declinedView(after));
    return;
  }

  if (action !== "accept") {
    log.warn({ customId: interaction.customId }, "Unhandled flip action");
    return;
  }

  // Accept: flip the coin in the transaction, then animate the reveal.
  // `crypto.randomInt(2)` — 0 = heads (challenger wins), 1 = tails.
  const side: FlipSide = randomInt(2) === 0 ? "heads" : "tails";
  const result = acceptFlip(flipId, side);

  if (result.kind === "gone") {
    await interaction.update({
      embeds: [
        embed(MARKET_EMBED_COLOUR)
          .setTitle(`\uD83E\uDE99 Coin flip #${flipId} — gone`)
          .setDescription("This flip was already settled."),
      ],
      components: [],
    });
    return;
  }
  if (result.kind === "expired") {
    await interaction.update(expiredView(flip));
    return;
  }
  if (result.kind === "insufficient-funds") {
    const e = embed(MARKET_EMBED_COLOUR)
      .setTitle(`\uD83E\uDE99 Coin flip #${flipId} — can't cover`)
      .setDescription(
        [
          `<@${flip.targetId}> only has **${CURRENCY.format(result.balance)}** — ` +
            `not enough to cover the **${CURRENCY.format(result.needed)}** stake.`,
          `Stake refunded to <@${flip.challengerId}>.`,
        ].join("\n"),
      );
    await interaction.update({ embeds: [e], components: [] });
    return;
  }

  // Won path — animate three frames, then settle.
  await interaction.update(flippingView(flip, 0));
  let msg: Message | null = null;
  try {
    msg = await interaction.fetchReply();
  } catch {
    // Ephemeral/unknown — the initial update still shows frame 0, skip
    // the animation rather than error out. Final state is in the DB.
  }
  if (msg) {
    await sleep(FRAME_MS);
    try {
      await msg.edit(flippingView(flip, 1));
    } catch (err) {
      log.warn({ err, flipId }, "Flip frame 2 edit failed");
    }
    await sleep(FRAME_MS);
    try {
      await msg.edit(resultView(flip, result.side, result.winnerId));
    } catch (err) {
      log.warn({ err, flipId }, "Flip result edit failed");
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
