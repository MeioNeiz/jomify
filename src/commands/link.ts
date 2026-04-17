import { SlashCommandBuilder } from "discord.js";
import { resolveSteamId } from "../steam/client.js";
import { linkAccount } from "../store.js";
import { wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("link")
  .setDescription("Link a Discord account to a Steam ID")
  .addStringOption((opt) =>
    opt.setName("steamid").setDescription("Steam64 ID").setRequired(true),
  )
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Discord user to link (defaults to yourself)"),
  );

export const execute = wrapCommand(async (interaction) => {
  const raw = interaction.options.getString("steamid", true);
  const user = interaction.options.getUser("user");
  const discordId = user?.id ?? interaction.user.id;

  const result = await resolveSteamId(raw);
  if (!result.ok) {
    const msg =
      result.reason === "not-found"
        ? `Couldn't find a Steam profile for \`${raw}\`.`
        : result.reason === "invalid-input"
          ? `\`${raw}\` doesn't look like a Steam ID, profile URL, or vanity name.`
          : "Steam API is unreachable — try again in a moment.";
    await interaction.editReply(msg);
    return;
  }
  const steamId = result.steamId;

  const { previousSteamId, previousDiscordId } = linkAccount(discordId, steamId);

  const notes: string[] = [];
  if (previousSteamId) {
    notes.push(`<@${discordId}> was previously linked to \`${previousSteamId}\``);
  }
  if (previousDiscordId) {
    notes.push(`\`${steamId}\` was previously linked to <@${previousDiscordId}>`);
  }

  const suffix = notes.length ? ` (${notes.join("; ")})` : "";
  await interaction.editReply(`Linked <@${discordId}> to \`${steamId}\`.${suffix}`);
});
