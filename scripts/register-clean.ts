// Clears all dev-guild slash commands. Run manually once you've
// confirmed your new commands have propagated globally (~1h after
// `bun run register`) — leaves only the global set, no duplicates in
// the dev guild's command picker.
//
// Usage: bun run register:clean
import { REST, Routes } from "discord.js";
import { config } from "../src/config.js";

const guildId = config.devGuildId;
if (!guildId) {
  console.log("No DEV_GUILD_ID configured — nothing to clean.");
  process.exit(0);
}

const rest = new REST().setToken(config.discordToken);
console.log(`Clearing dev-guild commands in ${guildId}...`);
await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), {
  body: [],
});
console.log("Done.");
