import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "./config.js";
import { loadPlayers } from "./store.js";

import * as stats from "./commands/stats.js";
import * as compare from "./commands/compare.js";
import * as shame from "./commands/shame.js";
import * as leaderboard from "./commands/leaderboard.js";
import * as track from "./commands/track.js";

type Command = {
  data: SlashCommandBuilder;
  execute: (i: ChatInputCommandInteraction) => Promise<void>;
};

export const commands: [string, Command][] = [
  ["stats", stats],
  ["compare", compare],
  ["shame", shame],
  ["leaderboard", leaderboard],
  ["track", track],
];

const commandMap = new Collection<string, Command>();
for (const [name, cmd] of commands) {
  commandMap.set(name, cmd);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Jomify online as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(
      `Error in /${interaction.commandName}:`, err
    );
    const reply = interaction.deferred || interaction.replied
      ? interaction.editReply
      : interaction.reply;
    await reply.call(
      interaction,
      "Something went wrong."
    );
  }
});

loadPlayers();
client.login(config.discordToken);
