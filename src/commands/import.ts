import { SlashCommandBuilder } from "discord.js";
import { requireGuild } from "../helpers.js";
import { getProfile } from "../leetify/client.js";
import { addTrackedPlayer } from "../store.js";
import { backfillPlayer } from "../watcher.js";
import { wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("import")
  .setDescription("Bulk import Steam IDs to track")
  .addStringOption((opt) =>
    opt
      .setName("steamids")
      .setDescription("Steam64 IDs separated by spaces or commas")
      .setRequired(true),
  );

export const execute = wrapCommand(async (interaction) => {
  const guildId = requireGuild(interaction);
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  const raw = interaction.options.getString("steamids", true);
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    await interaction.editReply("No valid IDs provided.");
    return;
  }

  const results: string[] = [];
  for (const id of ids) {
    try {
      const profile = await getProfile(id);
      addTrackedPlayer(guildId, id);
      const count = await backfillPlayer(id);
      results.push(`\u2705 **${profile.name}** \u2014 ${count} matches loaded`);
    } catch {
      results.push(`\u274C \`${id}\` \u2014 not found on Leetify`);
    }
  }

  await interaction.editReply(
    `**Imported ${ids.length} player(s):**\n${results.join("\n")}`,
  );
});
