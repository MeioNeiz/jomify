import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";
import { config } from "./config.js";

const rest = new REST().setToken(config.discordToken);
const body = commands.map(([, cmd]) => cmd.data.toJSON());

// Always register globally
console.log(`Registering ${body.length} commands globally...`);
await rest.put(Routes.applicationCommands(config.discordClientId), { body });

// Also register to dev guild for instant updates
const guildId = config.devGuildId;
if (guildId) {
  console.log(`Registering to dev guild ${guildId}...`);
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), {
    body,
  });

  // Schedule dev guild cleanup after global propagation (~1 hr)
  console.log("Dev guild commands will be cleaned up in 1 hour...");
  setTimeout(
    async () => {
      try {
        await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), {
          body: [],
        });
        console.log("Dev guild commands cleared (global has propagated)");
      } catch (err) {
        console.error("Failed to clear dev guild commands:", err);
      }
    },
    60 * 60 * 1000,
  );
}

console.log("Done!");
