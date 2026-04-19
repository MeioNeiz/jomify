import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { getCommandStats } from "../store.js";
import { embed, pad, table } from "../ui.js";
import { wrapCommand } from "./handler.js";

const METRICS_DEFAULT_DAYS = 7;
const METRICS_MIN_DAYS = 1;
const METRICS_MAX_DAYS = 90;

const CMD_WIDTH = 14;
const COUNT_WIDTH = 4;
const MS_WIDTH = 9;
const API_WIDTH = 5;

export const data = new SlashCommandBuilder()
  .setName("metrics")
  .setDescription("Command timing + API-call summary")
  .addIntegerOption((opt) =>
    opt
      .setName("days")
      .setDescription(`Window size in days (default ${METRICS_DEFAULT_DAYS})`)
      .setMinValue(METRICS_MIN_DAYS)
      .setMaxValue(METRICS_MAX_DAYS),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export const execute = wrapCommand(async (interaction) => {
  const days = interaction.options.getInteger("days") ?? METRICS_DEFAULT_DAYS;
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
    `${pad("command", CMD_WIDTH)}${pad("n", COUNT_WIDTH)}` +
    `${pad("ttf", MS_WIDTH)}${pad("p50", MS_WIDTH)}${pad("p95", MS_WIDTH)}` +
    `${pad("api", API_WIDTH)}fail%`;

  const body = rows.map((r) => {
    const failPct =
      r.count === 0 ? "0%" : `${Math.round((r.failureCount / r.count) * 100)}%`;
    return (
      `${pad(`/${r.command}`, CMD_WIDTH)}${pad(r.count.toString(), COUNT_WIDTH)}` +
      `${pad(`${r.ttfP50Ms}ms`, MS_WIDTH)}` +
      `${pad(`${r.p50Ms}ms`, MS_WIDTH)}${pad(`${r.p95Ms}ms`, MS_WIDTH)}` +
      `${pad(r.avgApiCalls.toFixed(2), API_WIDTH)}${failPct}`
    );
  });

  await interaction.editReply({
    embeds: [
      embed()
        .setTitle(`Command Metrics (Last ${days}d)`)
        .setDescription(
          `${table([header, ...body])}\n` +
            "-# `ttf` = p50 time-to-first-reply (what the user sees). " +
            "`p50`/`p95` = total wall clock incl. revalidate. " +
            "Query `metrics` in Datasette for TTL and error-message detail.",
        ),
    ],
  });
});
