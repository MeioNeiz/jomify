import { Client, Collection, Events, GatewayIntentBits } from "discord.js";
import { type Command, commands } from "./commands/index.js";
import { dispatchComponent } from "./components.js";
// Side-effect import: subscribes betting to cs:match-completed. Keeps
// the CS module ignorant of betting while ensuring grants land in the
// same process.
import "./betting/listeners/cs-match-completed.js";
// Side-effect import: registers the CS next-match resolver kinds. Must
// land before the watcher starts so the registry is populated when the
// first tick fires.
import "./betting/resolvers/cs-next-match.js";
import "./betting/resolvers/cs-rating-goal.js";
import "./betting/resolvers/cs-premier-milestone.js";
import "./betting/resolvers/cs-win-streak.js";
import "./betting/resolvers/cs-clutch-count.js";
import "./betting/resolvers/stock.js";
import "./betting/resolvers/polymarket.js";
import "./betting/resolvers/kalshi.js";
import { startExpiryWatcher } from "./betting/expiry.js";
import { startResolverWatcher } from "./betting/resolvers/watcher.js";
import { config } from "./config.js";
import { startWatcher } from "./cs/watcher.js";
import log from "./logger.js";
import { startWeekly } from "./weekly.js";

const commandMap = new Collection<string, Command>();
for (const [name, cmd] of commands) commandMap.set(name, cmd);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  // Default: never ping anyone. Mentions still render as clickable
  // names but don't trigger notifications. Commands can override
  // per-message if they need to ping (e.g. alerts).
  allowedMentions: { parse: [] },
});

client.once(Events.ClientReady, (c) => {
  log.info({ tag: c.user.tag }, "Jomify online");
  startWatcher(client);
  startWeekly(client);
  startExpiryWatcher(client);
  startResolverWatcher(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isModalSubmit()
  ) {
    await dispatchComponent(interaction);
    return;
  }
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
