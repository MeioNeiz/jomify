import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";

const rest = new REST().setToken(config.discordToken);

const body = commands.map(([, cmd]) => cmd.data.toJSON());

console.log(`Registering ${body.length} slash commands...`);

await rest.put(
  Routes.applicationCommands(config.discordClientId),
  { body }
);

console.log("Done!");
