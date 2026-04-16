import { Client, Collection, Events, GatewayIntentBits } from "discord.js";
import { type Command, commands } from "./commands/index.js";
import { config } from "./config.js";
import log from "./logger.js";
import { startWatcher } from "./watcher.js";
import { startWeeklyLeaderboard } from "./weekly.js";

const commandMap = new Collection<string, Command>();
for (const [name, cmd] of commands) commandMap.set(name, cmd);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  log.info({ tag: c.user.tag }, "Jomify online");
  startWatcher(client);
  startWeeklyLeaderboard(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    if ((err as { code?: number })?.code === 10062) return;
    log.error({ cmd: interaction.commandName, err }, "Unhandled command error");
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Something went wrong.");
      } else {
        await interaction.reply("Something went wrong.");
      }
    } catch {
      /* interaction gone */
    }
  }
});

client.login(config.discordToken);
