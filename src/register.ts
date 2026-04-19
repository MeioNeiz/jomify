import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";
import { config } from "./config.js";

const rest = new REST().setToken(config.discordToken);
const body = commands.map(([, cmd]) => cmd.data.toJSON());

// Always register globally
console.log(`Registering ${body.length} commands globally...`);
await rest.put(Routes.applicationCommands(config.discordClientId), { body });

// Also register to dev guild for instant updates. Dev-guild entries
// duplicate the global ones until Discord propagates globally (~1h),
// which is fine — global and guild slash commands merge in the picker.
// If you want to clear dev guild duplicates, run `bun run register:clean`.
const guildId = config.devGuildId;
if (guildId) {
  console.log(`Registering to dev guild ${guildId}...`);
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), {
    body,
  });
}

console.log("Done!");
