// /flip — WoW-Trade-Chat-style open 1v1 coin flip. Challenger stakes
// shekels with `/flip amount:<n>`; the embed posts Accept + Cancel
// buttons. Anyone else in the channel can accept by clicking the
// button or by running `/flip` (no amount) — whichever fires first
// wins the transaction. On Accept we roll a fair coin
// (crypto.randomInt), animate the reveal across three edits, and
// credit the winner the full 2x stake. Cancel (challenger-only)
// refunds the stake. On timeout (3 min default) the sweeper in
// src/betting/expiry.ts reaps the flip and refunds; Accept after the
// deadline also refunds-and-expires inline so we're correct even if
// the watcher is asleep.
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
  cancelFlip,
  type Flip,
  type FlipSide,
  getBalance,
  getFlip,
  getLastAcceptedFlipForUser,
  getLatestOpenFlipInChannel,
  getOpenFlipForChallenger,
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
  .setDescription(
    `Open a coin flip for ${CURRENCY.plural}, or run without an amount to accept one`,
  )
  .addIntegerOption((opt) =>
    opt
      .setName("amount")
      .setDescription(`${CURRENCY.label} to stake (omit to accept an open challenge)`)
      .setRequired(false)
      .setMinValue(1),
  );

// ── Rendering ────────────────────────────────────────────────────────

function challengeView(flip: Flip): MessageEditOptions {
  const acceptBy = Math.floor(new Date(`${flip.expiresAt}Z`).getTime() / 1000);
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`🪙 Coin flip #${flip.id}`)
    .setDescription(
      [
        `<@${flip.challengerId}> has staked **${CURRENCY.format(flip.amount)}** ` +
          "on a coin flip — who's got the nerve?",
        "",
        "Heads: challenger wins. Tails: accepter wins. Winner takes the lot.",
        "Tap **Flip** or run `/flip` to accept.",
        `Expires <t:${acceptBy}:R>.`,
      ].join("\n"),
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`flip:accept:${flip.id}`)
      .setLabel("Flip")
      .setEmoji("🪙")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`flip:cancel:${flip.id}`)
      .setLabel("Cancel")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [row] };
}

function flippingView(flip: Flip, acceptorId: string, frame: 0 | 1): MessageEditOptions {
  const coin = frame === 0 ? "🪙" : "✨";
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`${coin} Coin flip #${flip.id} — flipping…`)
    .setDescription(
      [
        `<@${flip.challengerId}> vs <@${acceptorId}>`,
        `Stake: **${CURRENCY.format(flip.amount)}** each — pot **${CURRENCY.format(flip.amount * 2)}**`,
        "",
        frame === 0 ? "🪙 flipping…" : "✨ flipping…",
      ].join("\n"),
    );
  return { embeds: [e], components: [] };
}

function resultView(
  flip: Flip,
  acceptorId: string,
  side: FlipSide,
  winnerId: string,
): MessageEditOptions {
  const isHeads = side === "heads";
  const icon = isHeads ? "🟢" : "🔴";
  const face = isHeads ? "HEADS" : "TAILS";
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`${icon} ${face}! — coin flip #${flip.id}`)
    .setDescription(
      [
        `<@${flip.challengerId}> vs <@${acceptorId}>`,
        `Stake: **${CURRENCY.format(flip.amount)}** each`,
        "",
        `🏆 <@${winnerId}> scoops **${CURRENCY.format(flip.amount * 2)}**.`,
      ].join("\n"),
    );
  return { embeds: [e], components: [] };
}

function cancelledView(flip: Flip): MessageEditOptions {
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`🪙 Coin flip #${flip.id} — cancelled`)
    .setDescription(`<@${flip.challengerId}> pulled the challenge. Stake refunded.`);
  return { embeds: [e], components: [] };
}

export function expiredView(flip: Flip): MessageEditOptions {
  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`🪙 Coin flip #${flip.id} — expired`)
    .setDescription(`No takers. Stake refunded to <@${flip.challengerId}>.`);
  return { embeds: [e], components: [] };
}

// ── Slash handler ────────────────────────────────────────────────────

async function handleFlip(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }
  const amount = interaction.options.getInteger("amount", false);

  if (amount == null) {
    await acceptViaSlash(interaction, guildId);
    return;
  }
  await openViaSlash(interaction, guildId, amount);
}

async function openViaSlash(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  amount: number,
): Promise<void> {
  const challengerId = interaction.user.id;

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

  // One open challenge at a time per challenger.
  const open = getOpenFlipForChallenger(challengerId, guildId);
  if (open) {
    await interaction.editReply(
      `You've already got coin flip #${open.id} open — resolve or cancel it first.`,
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
      amount,
      expiresInMs: EXPIRY_MS,
      channelId: interaction.channelId ?? undefined,
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

  await interaction.editReply(challengeView(flip));
  try {
    const msg = await interaction.fetchReply();
    setFlipMessage(flipId, msg.channelId, msg.id);
  } catch (err) {
    log.warn({ err, flipId }, "Couldn't capture flip message pointer");
  }
}

async function acceptViaSlash(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const acceptorId = interaction.user.id;
  const channelId = interaction.channelId;
  if (!channelId) {
    await interaction.editReply("Use this in a channel.");
    return;
  }

  const flip = getLatestOpenFlipInChannel(channelId, acceptorId);
  if (!flip) {
    await interaction.editReply(
      `No open coin flip in this channel. Run \`/flip amount:<n>\` to start one.`,
    );
    return;
  }

  const gate = await guardAccept(flip, acceptorId, guildId);
  if (gate) {
    await interaction.editReply(gate);
    return;
  }

  // Feedback to the accepter is via the original embed edit — just
  // confirm quickly here so the slash interaction doesn't hang.
  await interaction.editReply(`Accepted coin flip #${flip.id} — rolling…`);
  await runAccept(flip.id, acceptorId, {
    editMessage: async (view) => {
      if (!flip.channelId || !flip.messageId) return;
      try {
        const channel = await interaction.client.channels.fetch(flip.channelId);
        if (!channel?.isTextBased() || !("messages" in channel)) return;
        const msg = await channel.messages.fetch(flip.messageId);
        await msg.edit({
          content: null,
          embeds: view.embeds ?? [],
          components: view.components ?? [],
        });
      } catch (err) {
        log.warn({ err, flipId: flip.id }, "Couldn't edit flip message from /flip");
      }
    },
  });
}

export const execute = wrapCommand(handleFlip);

// ── Component handlers ───────────────────────────────────────────────
//
// customId grammar:
//   flip:accept:<id>    — anyone (not challenger) clicks Flip
//   flip:cancel:<id>    — challenger aborts before anyone accepts
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

  if (action === "cancel") {
    if (interaction.user.id !== flip.challengerId) {
      await interaction.reply({
        content: "Only the challenger can cancel this flip.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const after = cancelFlip(flipId) ?? flip;
    await interaction.update(cancelledView(after));
    return;
  }

  if (action !== "accept") {
    log.warn({ customId: interaction.customId }, "Unhandled flip action");
    return;
  }

  const acceptorId = interaction.user.id;
  const gate = await guardAccept(flip, acceptorId, flip.guildId);
  if (gate) {
    await interaction.reply({ content: gate, flags: MessageFlags.Ephemeral });
    return;
  }

  await runAccept(flipId, acceptorId, {
    editMessage: async (view) => {
      await interaction.update(view);
    },
    firstEditViaInteraction: true,
    onFetchReply: async () => {
      try {
        return await interaction.fetchReply();
      } catch {
        return null;
      }
    },
  });
});

// ── Shared accept helpers ────────────────────────────────────────────

/**
 * Checks that `acceptorId` is allowed to accept `flip`: not the
 * challenger, not a bot, off cooldown, and solvent. Returns an error
 * string to show the user, or null if clear to proceed.
 */
async function guardAccept(
  flip: Flip,
  acceptorId: string,
  guildId: string,
): Promise<string | null> {
  if (acceptorId === flip.challengerId) {
    return "Can't accept your own flip — someone else has to bite.";
  }
  const last = getLastAcceptedFlipForUser(acceptorId, guildId);
  if (last?.resolvedAt) {
    const sinceMs = Date.now() - new Date(`${last.resolvedAt}Z`).getTime();
    if (sinceMs < COOLDOWN_MS) {
      const waitS = Math.ceil((COOLDOWN_MS - sinceMs) / 1000);
      return `Cooling off — try again in **${waitS}s**.`;
    }
  }
  const balance = getBalance(acceptorId, guildId);
  if (balance < flip.amount) {
    return (
      `You've only got **${CURRENCY.format(balance)}** — ` +
      `not enough to cover the **${CURRENCY.format(flip.amount)}** stake.`
    );
  }
  return null;
}

type AcceptRenderHooks = {
  editMessage: (view: MessageEditOptions) => Promise<void>;
  firstEditViaInteraction?: boolean;
  onFetchReply?: () => Promise<Message | null>;
};

async function runAccept(
  flipId: number,
  acceptorId: string,
  hooks: AcceptRenderHooks,
): Promise<void> {
  const flip = getFlip(flipId);
  if (!flip) return;
  // `crypto.randomInt(2)` — 0 = heads (challenger wins), 1 = tails.
  const side: FlipSide = randomInt(2) === 0 ? "heads" : "tails";
  const result = acceptFlip(flipId, acceptorId, side);

  if (result.kind === "gone" || result.kind === "self") {
    await hooks.editMessage({
      embeds: [
        embed(MARKET_EMBED_COLOUR)
          .setTitle(`🪙 Coin flip #${flipId} — gone`)
          .setDescription("This flip was already settled."),
      ],
      components: [],
    });
    return;
  }
  if (result.kind === "expired") {
    await hooks.editMessage(expiredView(flip));
    return;
  }
  if (result.kind === "insufficient-funds") {
    const e = embed(MARKET_EMBED_COLOUR)
      .setTitle(`🪙 Coin flip #${flipId} — can't cover`)
      .setDescription(
        [
          `<@${acceptorId}> only has **${CURRENCY.format(result.balance)}** — ` +
            `not enough to cover the **${CURRENCY.format(result.needed)}** stake.`,
          `Stake refunded to <@${flip.challengerId}>.`,
        ].join("\n"),
      );
    await hooks.editMessage({ embeds: [e], components: [] });
    return;
  }

  // Won path — animate three frames, then settle.
  await hooks.editMessage(flippingView(flip, acceptorId, 0));
  let msg: Message | null = null;
  if (hooks.firstEditViaInteraction && hooks.onFetchReply) {
    msg = await hooks.onFetchReply();
  }
  if (msg) {
    await sleep(FRAME_MS);
    try {
      await msg.edit(flippingView(flip, acceptorId, 1));
    } catch (err) {
      log.warn({ err, flipId }, "Flip frame 2 edit failed");
    }
    await sleep(FRAME_MS);
    try {
      await msg.edit(resultView(flip, acceptorId, result.side, result.winnerId));
    } catch (err) {
      log.warn({ err, flipId }, "Flip result edit failed");
    }
  } else {
    // No message handle — drive the rest of the animation through the
    // caller's editMessage hook (the /flip slash path).
    await sleep(FRAME_MS);
    await hooks.editMessage(flippingView(flip, acceptorId, 1));
    await sleep(FRAME_MS);
    await hooks.editMessage(resultView(flip, acceptorId, result.side, result.winnerId));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
