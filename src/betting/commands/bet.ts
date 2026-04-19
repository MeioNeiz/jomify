import { type ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { wrapCommand } from "../../commands/handler.js";
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

const OUTCOMES: Outcome[] = ["yes", "no"];

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
    sub
      .setName("place")
      .setDescription("Place a wager on an open bet")
      .addIntegerOption((opt) =>
        opt
          .setName("bet")
          .setDescription("Bet ID (from /bet list)")
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((opt) =>
        opt
          .setName("outcome")
          .setDescription("Side to back")
          .setRequired(true)
          .addChoices({ name: "yes", value: "yes" }, { name: "no", value: "no" }),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("amount")
          .setDescription("Credits to stake")
          .setRequired(true)
          .setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List open bets in this server"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("resolve")
      .setDescription("Resolve a bet you created (creator-only for now)")
      .addIntegerOption((opt) =>
        opt.setName("bet").setDescription("Bet ID").setRequired(true).setMinValue(1),
      )
      .addStringOption((opt) =>
        opt
          .setName("outcome")
          .setDescription("Winning outcome")
          .setRequired(true)
          .addChoices({ name: "yes", value: "yes" }, { name: "no", value: "no" }),
      ),
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

async function handleOpen(interaction: ChatInputCommandInteraction, guildId: string) {
  const question = interaction.options.getString("question", true);
  const id = createBet(guildId, interaction.user.id, question);
  const e = embed()
    .setTitle(`Bet #${id} opened`)
    .setDescription(
      [
        `**${question}**`,
        "",
        `Place a wager with \`/bet place bet:${id} outcome:yes|no amount:<int>\`.`,
        `Only <@${interaction.user.id}> can resolve this bet.`,
      ].join("\n"),
    );
  await interaction.editReply({ embeds: [e] });
}

async function handlePlace(interaction: ChatInputCommandInteraction) {
  const discordId = interaction.user.id;
  const betId = interaction.options.getInteger("bet", true);
  const outcome = interaction.options.getString("outcome", true) as Outcome;
  const amount = interaction.options.getInteger("amount", true);
  if (!OUTCOMES.includes(outcome)) {
    await interaction.editReply("Outcome must be `yes` or `no`.");
    return;
  }
  try {
    placeWager(betId, discordId, outcome, amount);
  } catch (err) {
    await interaction.editReply((err as Error).message);
    return;
  }
  const balance = getBalance(discordId);
  const pool = poolForBet(betId);
  await interaction.editReply(
    `Wagered ${amount} on **${outcome}** (bet #${betId}). ` +
      `Balance: ${balance}. Pool: ${pool.yes} yes / ${pool.no} no.`,
  );
}

async function handleList(interaction: ChatInputCommandInteraction, guildId: string) {
  const open = listOpenBets(guildId);
  if (!open.length) {
    await interaction.editReply("No open bets. Start one with `/bet open`.");
    return;
  }
  const rows = open.map((b) => {
    const pool = poolForBet(b.id);
    const q = b.question.length > 40 ? `${b.question.slice(0, 39)}\u2026` : b.question;
    return `#${pad(String(b.id), 3)} ${pad(q, 40)} ${pad(String(pool.yes), 4)}Y / ${pad(String(pool.no), 4)}N`;
  });
  const e = embed().setTitle("Open bets").setDescription(table(rows));
  await interaction.editReply({ embeds: [e] });
}

async function handleResolve(interaction: ChatInputCommandInteraction) {
  const betId = interaction.options.getInteger("bet", true);
  const outcome = interaction.options.getString("outcome", true) as Outcome;
  const bet = getBet(betId);
  if (!bet) {
    await interaction.editReply(`Bet #${betId} doesn't exist.`);
    return;
  }
  if (bet.creatorDiscordId !== interaction.user.id) {
    await interaction.editReply("Only the creator can resolve this bet.");
    return;
  }
  if (bet.status !== "open") {
    await interaction.editReply(`Bet #${betId} is already ${bet.status}.`);
    return;
  }

  const before = getWagersForBet(betId);
  const pool = poolForBet(betId);
  try {
    resolveBet(betId, outcome);
  } catch (err) {
    await interaction.editReply((err as Error).message);
    return;
  }

  const winners = before.filter((w) => w.outcome === outcome);
  const losers = before.filter((w) => w.outcome !== outcome);
  const lines = [
    `**${bet.question}** \u2192 **${outcome}**`,
    `Pool: ${pool.yes} yes / ${pool.no} no (total ${pool.total})`,
    winners.length
      ? `Winners: ${winners.length} \u2014 losers' ${losers.reduce((s, w) => s + w.amount, 0)} credits split by stake.`
      : "No winners \u2014 losers refunded.",
  ];
  const e = embed("success")
    .setTitle(`Bet #${betId} resolved`)
    .setDescription(lines.join("\n"));
  await interaction.editReply({ embeds: [e] });
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

  // Guild-scoped subcommands: bets and resolutions only make sense in
  // the context of a server. `balance` and `leaderboard` work in DMs.
  const guildOnly =
    sub === "open" || sub === "place" || sub === "list" || sub === "resolve";
  if (guildOnly && !guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  if (sub === "open") await handleOpen(interaction, guildId as string);
  else if (sub === "place") await handlePlace(interaction);
  else if (sub === "list") await handleList(interaction, guildId as string);
  else if (sub === "resolve") await handleResolve(interaction);
  else if (sub === "balance") await handleBalance(interaction);
  else if (sub === "leaderboard") await handleLeaderboard(interaction);
  else await interaction.editReply(`Unknown subcommand: ${sub}`);
});
