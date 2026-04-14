import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { trackedPlayers, savePlayers } from "../store.js";

export const data = new SlashCommandBuilder()
  .setName("track")
  .setDescription("Add or remove a player from tracking")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Start tracking a player")
      .addStringOption((opt) =>
        opt
          .setName("steamid")
          .setDescription("Steam64 ID")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Stop tracking a player")
      .addStringOption((opt) =>
        opt
          .setName("steamid")
          .setDescription("Steam64 ID")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("Show all tracked players")
  );

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply("Use this in a server.");
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (!trackedPlayers.has(guildId)) {
    trackedPlayers.set(guildId, new Set());
  }
  const players = trackedPlayers.get(guildId)!;

  if (sub === "add") {
    const steamId = interaction.options.getString(
      "steamid", true
    );
    players.add(steamId);
    savePlayers();
    await interaction.reply(`Now tracking \`${steamId}\`.`);
  } else if (sub === "remove") {
    const steamId = interaction.options.getString(
      "steamid", true
    );
    players.delete(steamId);
    savePlayers();
    await interaction.reply(
      `Stopped tracking \`${steamId}\`.`
    );
  } else {
    if (!players.size) {
      await interaction.reply("No players tracked yet.");
      return;
    }
    const list = [...players].map((id) => `• \`${id}\``);
    await interaction.reply(
      `**Tracked players:**\n${list.join("\n")}`
    );
  }
}
