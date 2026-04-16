import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { freshnessSuffix, requireGuild } from "../helpers.js";
import {
  getMostRecentMatchTime,
  getPlayerMatchStats,
  getPlayerStatAverages,
  getTrackedPlayers,
} from "../store.js";
import { wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("flash")
  .setDescription("Who's the worst at flashing? Team vs enemy flash stats");

export const execute = wrapCommand(async (interaction) => {
  const guildId = requireGuild(interaction);
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  const steamIds = getTrackedPlayers(guildId);
  if (!steamIds.length) {
    await interaction.editReply("No tracked players. Use `/track` to add some.");
    return;
  }

  const entries: { name: string; team: number; enemy: number }[] = [];
  for (const id of steamIds) {
    const avgs = getPlayerStatAverages(id);
    if (!avgs?.match_count) continue;
    const recent = getPlayerMatchStats(id, 1);
    const name = recent.length ? recent[0].raw.name : id;
    entries.push({
      name,
      team: avgs.avg_team_flash_rate ?? 0,
      enemy: avgs.avg_flash_enemies ?? 0,
    });
  }

  if (!entries.length) {
    await interaction.editReply("No match data yet.");
    return;
  }

  entries.sort((a, b) => b.team - a.team);

  const lines = entries.map((e, i) => {
    const ratio = e.enemy > 0 ? (e.team / e.enemy).toFixed(1) : "\u221E";
    return (
      `${i + 1}. **${e.name}** \u2014 ` +
      `\u{1f91d} ${e.team.toFixed(2)} ` +
      `\u{1f4a5} ${e.enemy.toFixed(2)} (${ratio}x)`
    );
  });

  const latest = getMostRecentMatchTime(steamIds);
  const embed = new EmbedBuilder()
    .setTitle("Flashbang Shame")
    .setColor(0xffff00)
    .setDescription(
      `\u{1f91d} = team | \u{1f4a5} = enemy\n\n` +
        lines.join("\n") +
        freshnessSuffix(latest),
    );

  await interaction.editReply({ embeds: [embed] });
});
