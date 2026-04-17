import { type ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { requireGuild } from "../helpers.js";
import { resolveSteamId } from "../steam/client.js";
import {
  addTrackedPlayer,
  getAllLinkedAccounts,
  getDiscordId,
  getSteamId,
  getTrackedPlayers,
  removeTrackedPlayer,
} from "../store.js";
import { backfillPlayer } from "../watcher.js";
import { wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("track")
  .setDescription("Add or remove a player from tracking")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Start tracking a player")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("Discord user (must be linked)"),
      )
      .addStringOption((opt) =>
        opt.setName("steamid").setDescription("Steam64 ID (if not linked)"),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Stop tracking a player")
      .addUserOption((opt) => opt.setName("user").setDescription("Discord user"))
      .addStringOption((opt) => opt.setName("steamid").setDescription("Steam64 ID")),
  )
  .addSubcommand((sub) => sub.setName("list").setDescription("Show all tracked players"))
  .addSubcommand((sub) =>
    sub.setName("all").setDescription("Track all linked users in this server"),
  );

/**
 * Resolve the target from either the `user` option (via linked accounts)
 * or the `steamid` option. Replies + returns null if neither is usable.
 */
async function resolveTarget(
  interaction: ChatInputCommandInteraction,
  verb: "link" | "find",
): Promise<{ steamId: string; label: string } | null> {
  const user = interaction.options.getUser("user");
  const raw = interaction.options.getString("steamid");

  if (user) {
    const steamId = getSteamId(user.id);
    if (!steamId) {
      const hint = verb === "link" ? " They need to run `/link` first." : "";
      await interaction.editReply(`<@${user.id}> hasn't linked.${hint}`);
      return null;
    }
    return { steamId, label: `<@${user.id}>` };
  }

  if (raw) {
    const result = await resolveSteamId(raw);
    if (!result.ok) {
      const msg =
        result.reason === "not-found"
          ? `Couldn't find a Steam profile for \`${raw}\`.`
          : result.reason === "invalid-input"
            ? `\`${raw}\` doesn't look like a Steam ID, profile URL, or vanity name.`
            : "Steam API is unreachable — try again in a moment.";
      await interaction.editReply(msg);
      return null;
    }
    return { steamId: result.steamId, label: `\`${result.steamId}\`` };
  }

  await interaction.editReply("Provide a `user` or `steamid`.");
  return null;
}

export const execute = wrapCommand(async (interaction) => {
  const guildId = await requireGuild(interaction);
  if (!guildId) return;

  const sub = interaction.options.getSubcommand();

  if (sub === "add") {
    const target = await resolveTarget(interaction, "link");
    if (!target) return;
    addTrackedPlayer(guildId, target.steamId);
    const count = await backfillPlayer(target.steamId);
    await interaction.editReply(`Now tracking ${target.label}. Loaded ${count} matches.`);
  } else if (sub === "remove") {
    const target = await resolveTarget(interaction, "find");
    if (!target) return;
    removeTrackedPlayer(guildId, target.steamId);
    await interaction.editReply(`Stopped tracking ${target.label}.`);
  } else if (sub === "all") {
    const linked = getAllLinkedAccounts();
    if (!linked.length) {
      await interaction.editReply(
        "No one has linked their account yet. Use `/link` first.",
      );
      return;
    }
    for (const { steamId } of linked) {
      addTrackedPlayer(guildId, steamId);
    }
    const settled = await Promise.allSettled(
      linked.map(({ steamId }) => backfillPlayer(steamId)),
    );
    const total = linked.length;
    const failed = settled.filter((r) => r.status === "rejected").length;
    const suffix = failed ? ` (${failed} failed to backfill)` : "";
    await interaction.editReply(
      `Now tracking ${total} linked player(s). Match history loaded.${suffix}`,
    );
  } else {
    const players = getTrackedPlayers(guildId);
    if (!players.length) {
      await interaction.editReply("No players tracked yet.");
      return;
    }
    const list = players.map((id) => {
      const discordId = getDiscordId(id);
      return discordId ? `\u2022 <@${discordId}> \u2014 \`${id}\`` : `\u2022 \`${id}\``;
    });
    await interaction.editReply(`**Tracked players:**\n${list.join("\n")}`);
  }
});
