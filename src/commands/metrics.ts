import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { getCommandStats } from "../store.js";
import { embed, pad, table } from "../ui.js";
import { wrapCommand } from "./handler.js";

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 90;

const CMD_WIDTH = 14;
const COUNT_WIDTH = 6;
const MS_WIDTH = 7;
const API_WIDTH = 6;

export const data = new SlashCommandBuilder()
  .setName("metrics")
  .setDescription("Command timing + API-call summary (admin)")
  .addIntegerOption((opt) =>
    opt
      .setName("days")
      .setDescription(`Window size in days (default ${DEFAULT_DAYS})`)
      .setMinValue(MIN_DAYS)
      .setMaxValue(MAX_DAYS),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export const execute = wrapCommand(async (interaction) => {
  const days = interaction.options.getInteger("days") ?? DEFAULT_DAYS;
  const rows = getCommandStats(days);

  if (!rows.length) {
    await interaction.editReply({
      embeds: [
        embed()
          .setTitle(`Command Metrics (Last ${days}d)`)
          .setDescription("No command invocations recorded in this window."),
      ],
    });
    return;
  }

  const header =
    `${pad("command", CMD_WIDTH)}${pad("count", COUNT_WIDTH)}` +
    `${pad("p50", MS_WIDTH)}${pad("p95", MS_WIDTH)}` +
    `${pad("api", API_WIDTH)}fail%`;

  const body = rows.map((r) => {
    const failPct =
      r.count === 0 ? "0%" : `${Math.round((r.failureCount / r.count) * 100)}%`;
    return (
      `${pad(`/${r.command}`, CMD_WIDTH)}${pad(r.count.toString(), COUNT_WIDTH)}` +
      `${pad(`${r.p50Ms}ms`, MS_WIDTH)}${pad(`${r.p95Ms}ms`, MS_WIDTH)}` +
      `${pad(r.avgApiCalls.toFixed(2), API_WIDTH)}${failPct}`
    );
  });

  const e = embed()
    .setTitle(`Command Metrics (Last ${days}d)`)
    .setDescription(table([header, ...body]));
  await interaction.editReply({ embeds: [e] });
});
