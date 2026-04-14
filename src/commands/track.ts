import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import {
  addTrackedPlayer,
  removeTrackedPlayer,
  getTrackedPlayers,
  getSteamId,
  getAllLinkedAccounts,
} from "../store.js";
import { backfillPlayer } from "../watcher.js";

export const data = new SlashCommandBuilder()
  .setName("track")
  .setDescription("Add or remove a player from tracking")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Start tracking a player")
      .addUserOption((opt) =>
        opt
          .setName("user")
          .setDescription("Discord user (must be linked)")
      )
      .addStringOption((opt) =>
        opt
          .setName("steamid")
          .setDescription("Steam64 ID (if not linked)")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Stop tracking a player")
      .addUserOption((opt) =>
        opt
          .setName("user")
          .setDescription("Discord user")
      )
      .addStringOption((opt) =>
        opt
          .setName("steamid")
          .setDescription("Steam64 ID")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("Show all tracked players")
  )
  .addSubcommand((sub) =>
    sub
      .setName("all")
      .setDescription(
        "Track all linked users in this server"
      )
  );

function resolveSteamId(
  interaction: ChatInputCommandInteraction
): string | null {
  const user = interaction.options.getUser("user");
  if (user) {
    const steamId = getSteamId(user.id);
    if (!steamId) return null;
    return steamId;
  }
  return interaction.options.getString("steamid");
}

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply("Use this in a server.");
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "add") {
    const user = interaction.options.getUser("user");
    const steamId = resolveSteamId(interaction);
    if (!steamId) {
      const msg = user
        ? `<@${user.id}> hasn't linked their account. `
          + "They need to run `/link` first."
        : "Provide a `user` or `steamid`.";
      await interaction.reply(msg);
      return;
    }
    await interaction.deferReply();
    addTrackedPlayer(guildId, steamId);
    const count = await backfillPlayer(steamId);
    const label = user
      ? `<@${user.id}>`
      : `\`${steamId}\``;
    await interaction.editReply(
      `Now tracking ${label}. `
      + `Loaded ${count} matches.`
    );
  } else if (sub === "remove") {
    const user = interaction.options.getUser("user");
    const steamId = resolveSteamId(interaction);
    if (!steamId) {
      const msg = user
        ? `<@${user.id}> hasn't linked their account.`
        : "Provide a `user` or `steamid`.";
      await interaction.reply(msg);
      return;
    }
    removeTrackedPlayer(guildId, steamId);
    const label = user
      ? `<@${user.id}>`
      : `\`${steamId}\``;
    await interaction.reply(
      `Stopped tracking ${label}.`
    );
  } else if (sub === "all") {
    const linked = getAllLinkedAccounts();
    if (!linked.length) {
      await interaction.reply(
        "No one has linked their account yet. "
        + "Use `/link` first."
      );
      return;
    }
    await interaction.deferReply();
    let total = 0;
    for (const { steamId } of linked) {
      addTrackedPlayer(guildId, steamId);
      await backfillPlayer(steamId);
      total++;
    }
    await interaction.editReply(
      `Now tracking ${total} linked player(s). `
      + "Match history loaded."
    );
  } else {
    const players = getTrackedPlayers(guildId);
    if (!players.length) {
      await interaction.reply("No players tracked yet.");
      return;
    }
    const list = players.map((id) => `\u2022 \`${id}\``);
    await interaction.reply(
      `**Tracked players:**\n${list.join("\n")}`
    );
  }
}
