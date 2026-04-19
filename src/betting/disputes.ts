// Dispute flow. Lives outside commands/ because it has no slash
// command — it's all button + modal + select-menu wiring triggered
// from the Report button on resolved markets.
//
// customId grammar:
//   dispute:report:<betId>                — button → opens reason modal
//   dispute:reason:<betId>                — modal submit → opens dispute + posts panel
//   dispute:vote:<disputeId>:<vote>       — button → overturn/keep
//   dispute:admin:<disputeId>             — select menu → admin picks keep/flip-yes/flip-no/cancel
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
  type MessageEditOptions,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { registerComponent } from "../components.js";
import log from "../logger.js";
import { embed } from "../ui.js";
import { renderMarketView } from "./commands/market.js";
import { DISPUTE_COST } from "./config.js";
import {
  cancelBet,
  getBet,
  getDispute,
  getDisputeVotes,
  getOpenDisputeForBet,
  isInvolvedInBet,
  markDisputeResolved,
  type Outcome,
  openDispute,
  reopenBet,
  resolveBet,
  setDisputeMessage,
  type Vote,
} from "./store.js";
import { MARKET_EMBED_COLOUR } from "./ui.js";

// ── Rendering ────────────────────────────────────────────────────────

function adminActionMenu(disputeId: number): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(`dispute:admin:${disputeId}`)
    .setPlaceholder("Admin: pick a ruling…")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Keep current ruling")
        .setValue("keep")
        .setDescription("Dismiss the dispute, leave payouts as they are."),
      new StringSelectMenuOptionBuilder()
        .setLabel("Flip to Yes")
        .setValue("flip-yes")
        .setDescription("Reverse payouts, re-resolve as Yes."),
      new StringSelectMenuOptionBuilder()
        .setLabel("Flip to No")
        .setValue("flip-no")
        .setDescription("Reverse payouts, re-resolve as No."),
      new StringSelectMenuOptionBuilder()
        .setLabel("Cancel & refund")
        .setValue("cancel")
        .setDescription("Reverse payouts, refund every bet."),
    );
}

function renderDisputeView(disputeId: number): MessageEditOptions {
  const d = getDispute(disputeId);
  if (!d) return { content: `Dispute #${disputeId} doesn't exist.`, components: [] };
  const bet = getBet(d.betId);
  const tally = getDisputeVotes(disputeId);

  const lines: string[] = [];
  if (bet) {
    const ruling = bet.winningOutcome?.toUpperCase() ?? "—";
    lines.push(`**Market #${bet.id}** \u2014 ${bet.question}`);
    lines.push(`Current ruling: **${ruling}** (by <@${bet.creatorDiscordId}>)`);
  }
  lines.push("");
  lines.push(`Opened by <@${d.openerDiscordId}>:`);
  lines.push(`> ${d.reason}`);
  lines.push("");

  if (d.status === "resolved") {
    const outcome = d.finalOutcome ? ` (**${d.finalOutcome.toUpperCase()}**)` : "";
    lines.push(
      `\u2705 **Resolved**: ${d.finalAction}${outcome} by <@${d.resolverDiscordId}>.`,
    );
  } else {
    lines.push(
      `\uD83D\uDDF3\uFE0F Votes: **${tally.overturn}** overturn · ` +
        `**${tally.keep}** keep`,
    );
    if (tally.voters.length) {
      const voterLines = tally.voters.map(
        (v) => `\u2022 <@${v.discordId}> \u2014 ${v.vote}`,
      );
      lines.push(voterLines.join("\n"));
    }
    lines.push("");
    lines.push(
      "-# Anyone involved in the market can vote. Admin resolves with the dropdown.",
    );
  }

  const e = embed(MARKET_EMBED_COLOUR)
    .setTitle(`\u26A0\uFE0F Dispute on Market #${d.betId}`)
    .setDescription(lines.join("\n"));

  if (d.status === "resolved") {
    return { embeds: [e], components: [] };
  }

  const voteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dispute:vote:${d.id}:overturn`)
      .setLabel("Overturn")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("\uD83D\uDD04"),
    new ButtonBuilder()
      .setCustomId(`dispute:vote:${d.id}:keep`)
      .setLabel("Keep")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("\uD83D\uDD12"),
  );
  const adminRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    adminActionMenu(d.id),
  );
  return { embeds: [e], components: [voteRow, adminRow] };
}

// ── Helpers ──────────────────────────────────────────────────────────

function hasManageGuild(interaction: Interaction): boolean {
  const perms = interaction.memberPermissions;
  return perms?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function refreshMarketMessage(
  interaction: Interaction,
  betId: number,
): Promise<void> {
  const bet = getBet(betId);
  if (!bet?.channelId || !bet?.messageId) return;
  try {
    const channel = await interaction.client.channels.fetch(bet.channelId);
    if (!channel?.isTextBased()) return;
    const message = await (channel as TextChannel).messages.fetch(bet.messageId);
    const view = renderMarketView(betId);
    await message.edit({
      content: view.content ?? null,
      embeds: view.embeds ?? [],
      components: view.components ?? [],
    });
  } catch (err) {
    log.warn({ betId, err }, "Couldn't refresh market message after dispute");
  }
}

// ── Component handlers ───────────────────────────────────────────────

registerComponent("dispute", async (interaction) => {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  // report: open the reason modal. No DB write yet.
  if (action === "report" && interaction.isButton()) {
    const betId = Number(parts[2]);
    const bet = getBet(betId);
    if (!bet) {
      await interaction.reply({
        content: `Market #${betId} doesn't exist.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (bet.status !== "resolved") {
      await interaction.reply({
        content: "You can only dispute a resolved market.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!isInvolvedInBet(betId, interaction.user.id)) {
      await interaction.reply({
        content: "Only people involved in this market can dispute it.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const existing = getOpenDisputeForBet(betId);
    if (existing) {
      await interaction.reply({
        content: `Market #${betId} already has an open dispute (#${existing.id}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`dispute:reason:${betId}`)
      .setTitle(`Dispute market #${betId} (${DISPUTE_COST} shekels)`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("reason")
            .setLabel(`Why? Costs ${DISPUTE_COST} shekels.`)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMinLength(5)
            .setMaxLength(500),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // reason: modal submit. Create dispute row (debits shekels), post
  // the vote panel in the same channel as the market, then refresh
  // the market message so the Report button flips to "disputed".
  if (action === "reason" && interaction.isModalSubmit()) {
    const betId = Number(parts[2]);
    const reason = interaction.fields.getTextInputValue("reason").trim();
    let dispute: Awaited<ReturnType<typeof openDispute>>;
    try {
      dispute = openDispute(betId, interaction.user.id, reason);
    } catch (err) {
      await interaction.reply({
        content: (err as Error).message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Post vote panel. Target the same channel as the market so the
    // discussion stays adjacent; fall back to the current channel if
    // we don't have a market channel pointer.
    const bet = getBet(betId);
    const channelId = bet?.channelId ?? interaction.channelId;
    if (!channelId) {
      await interaction.reply({
        content: `Dispute #${dispute.id} opened, but no channel to post the vote panel in.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        const view = renderDisputeView(dispute.id);
        const msg = await (channel as TextChannel).send({
          embeds: view.embeds ?? [],
          components: view.components ?? [],
        });
        setDisputeMessage(dispute.id, msg.channelId, msg.id);
      }
    } catch (err) {
      log.warn({ disputeId: dispute.id, err }, "Couldn't post dispute vote panel");
    }

    await refreshMarketMessage(interaction, betId);
    await interaction.reply({
      content: `Dispute #${dispute.id} opened. ${DISPUTE_COST} shekels deducted.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // vote: upsert an overturn/keep vote, then refresh the panel.
  if (action === "vote" && interaction.isButton()) {
    const disputeId = Number(parts[2]);
    const vote = parts[3] as Vote;
    const dispute = getDispute(disputeId);
    if (!dispute || dispute.status !== "open") {
      await interaction.reply({
        content: "This dispute is closed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!isInvolvedInBet(dispute.betId, interaction.user.id)) {
      await interaction.reply({
        content: "Only people involved in this market can vote.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const { voteOnDispute } = await import("./store.js");
    voteOnDispute(disputeId, interaction.user.id, vote);
    const view = renderDisputeView(disputeId);
    await interaction.update({
      embeds: view.embeds ?? [],
      components: view.components ?? [],
    });
    return;
  }

  // admin: server-side gated on ManageGuild. Apply ruling via
  // reopenBet → resolveBet/cancelBet, then mark dispute resolved and
  // refresh both messages.
  if (action === "admin" && interaction.isStringSelectMenu()) {
    const disputeId = Number(parts[2]);
    const choice = interaction.values[0];
    const dispute = getDispute(disputeId);
    if (!dispute || dispute.status !== "open") {
      await interaction.reply({
        content: "This dispute is closed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!hasManageGuild(interaction)) {
      await interaction.reply({
        content: "Only server admins (Manage Server permission) can resolve disputes.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      if (choice === "keep") {
        markDisputeResolved(disputeId, "keep", dispute.finalOutcome, interaction.user.id);
      } else if (choice === "flip-yes" || choice === "flip-no") {
        const outcome: Outcome = choice === "flip-yes" ? "yes" : "no";
        reopenBet(dispute.betId);
        resolveBet(dispute.betId, outcome);
        markDisputeResolved(disputeId, "flip", outcome, interaction.user.id);
      } else if (choice === "cancel") {
        reopenBet(dispute.betId);
        cancelBet(dispute.betId);
        markDisputeResolved(disputeId, "cancel", null, interaction.user.id);
      } else {
        await interaction.reply({
          content: "Unknown ruling.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    } catch (err) {
      log.error({ disputeId, err }, "Admin dispute resolve failed");
      await interaction.reply({
        content: (err as Error).message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const view = renderDisputeView(disputeId);
    await interaction.update({
      embeds: view.embeds ?? [],
      components: view.components ?? [],
    });
    await refreshMarketMessage(interaction, dispute.betId);
    return;
  }

  log.warn({ customId: interaction.customId }, "Unhandled dispute action");
});
