import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
} from "discord.js";
import { config } from "./config.js";
import { commands, type Command } from "./commands/index.js";
import { startWatcher } from "./watcher.js";

const commandMap = new Collection<string, Command>();
for (const [name, cmd] of commands) {
  commandMap.set(name, cmd);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Jomify online as ${c.user.tag}`);
  startWatcher(client);
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

client.login(config.discordToken);
