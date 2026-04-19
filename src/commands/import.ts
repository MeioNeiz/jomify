import { SlashCommandBuilder } from "discord.js";
import { getProfile } from "../cs/leetify/client.js";
import { addTrackedPlayer } from "../cs/store.js";
import { backfillPlayer } from "../cs/watcher.js";
import { requireGuild } from "../helpers.js";
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
  const guildId = await requireGuild(interaction);
  if (!guildId) return;

  const raw = interaction.options.getString("steamids", true);
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    await interaction.editReply("No valid IDs provided.");
    return;
  }

  const settled = await Promise.allSettled(
    ids.map(async (id) => {
      const profile = await getProfile(id);
      addTrackedPlayer(guildId, id);
      const count = await backfillPlayer(id);
      return { name: profile.name, count };
    }),
  );
  const results = settled.map((r, i) =>
    r.status === "fulfilled"
      ? `\u2705 **${r.value.name}** \u2014 ${r.value.count} matches loaded`
      : `\u274C \`${ids[i]}\` \u2014 not found on Leetify`,
  );

  await interaction.editReply(
    `**Imported ${ids.length} player(s):**\n${results.join("\n")}`,
  );
});
