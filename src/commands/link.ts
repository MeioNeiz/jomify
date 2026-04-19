import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from "discord.js";
import { registerComponent } from "../components.js";
import { getProfile, LeetifyNotFoundError } from "../cs/leetify/client.js";
import { resolveSteamId } from "../cs/steam/client.js";
import { addTrackedPlayer, linkAccount } from "../cs/store.js";
import log from "../logger.js";
import { embed } from "../ui.js";
import { wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("link")
  .setDescription("Link a Discord account to a Steam profile")
  .addStringOption((opt) =>
    opt
      .setName("steamid")
      .setDescription("Steam64 ID, vanity URL, or handle")
      .setRequired(true),
  )
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Discord user to link (defaults to yourself)"),
  );

/**
 * Build a preview of the resolved profile so the caller can eyeball
 * it before committing. Steam's vanity resolver happily returns
 * strangers who share a display name (the "two JOMs" incident); this
 * is the cheapest way to stop that class of error.
 */
async function previewLines(steamId: string): Promise<string[]> {
  try {
    const p = await getProfile(steamId);
    const premier = p.ranks?.premier
      ? `${p.ranks.premier.toLocaleString()} Premier`
      : "Unranked";
    const matches = p.total_matches ?? 0;
    return [
      `**${p.name}** (${premier}, ${matches} matches on Leetify)`,
      `https://steamcommunity.com/profiles/${steamId}`,
    ];
  } catch (err) {
    if (err instanceof LeetifyNotFoundError) {
      return [
        `_Steam account found but no Leetify profile yet._`,
        `https://steamcommunity.com/profiles/${steamId}`,
      ];
    }
    return [
      `_Couldn't reach Leetify to preview the profile — double-check the Steam page below._`,
      `https://steamcommunity.com/profiles/${steamId}`,
    ];
  }
}

function confirmRow(
  invokerId: string,
  targetDiscordId: string,
  steamId: string,
  guildId: string | null,
) {
  const payload = `${invokerId}:${targetDiscordId}:${steamId}:${guildId ?? "-"}`;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`link:confirm:${payload}`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`link:cancel:${payload}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

export const execute = wrapCommand(async (interaction) => {
  const raw = interaction.options.getString("steamid", true);
  const user = interaction.options.getUser("user");
  const discordId = user?.id ?? interaction.user.id;
  const invokerId = interaction.user.id;

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

  const lines = await previewLines(steamId);
  const label = user ? `<@${user.id}>` : "you";
  const guildId = interaction.guildId;
  const trackNote = guildId
    ? "Confirming will also track this profile in this server."
    : "Confirming will only link — run this in a server to also track.";

  const e = embed()
    .setTitle(`Link ${label}?`)
    .setDescription(
      [
        ...lines,
        "",
        trackNote,
        "-# Vanity names aren't unique — make sure this is the right person.",
      ].join("\n"),
    );

  await interaction.editReply({
    embeds: [e],
    components: [confirmRow(invokerId, discordId, steamId, guildId)],
  });
});

// Confirm/Cancel handler. customId payload is
// `link:<action>:<invokerId>:<targetDiscordId>:<steamId>:<guildId or ->`.
registerComponent("link", async (interaction) => {
  if (!interaction.isButton()) return;
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const invokerId = parts[2];
  const targetDiscordId = parts[3];
  const steamId = parts[4];
  const guildIdRaw = parts[5];
  if (!action || !invokerId || !targetDiscordId || !steamId) return;

  if (interaction.user.id !== invokerId) {
    await interaction.reply({
      content: "Only the person who ran `/link` can confirm.",
      ephemeral: true,
    });
    return;
  }

  if (action === "cancel") {
    await interaction.update({ content: "Cancelled.", embeds: [], components: [] });
    return;
  }

  if (action !== "confirm") return;

  try {
    const { previousSteamId, previousDiscordId } = linkAccount(targetDiscordId, steamId);
    const guildId = guildIdRaw !== "-" ? guildIdRaw : null;
    let trackNote = "";
    if (guildId) {
      try {
        addTrackedPlayer(guildId, steamId);
        trackNote = " Now tracked in this server.";
      } catch (err) {
        log.warn({ err, guildId, steamId }, "Auto-track on /link failed");
      }
    }
    const notes: string[] = [];
    if (previousSteamId && previousSteamId !== steamId) {
      notes.push(`was previously linked to \`${previousSteamId}\``);
    }
    if (previousDiscordId && previousDiscordId !== targetDiscordId) {
      notes.push(`\`${steamId}\` was previously linked to <@${previousDiscordId}>`);
    }
    const suffix = notes.length ? ` (${notes.join("; ")})` : "";
    await interaction.update({
      content: `Linked <@${targetDiscordId}> to \`${steamId}\`.${trackNote}${suffix}`,
      embeds: [],
      components: [],
    });
  } catch (err) {
    log.warn({ err }, "Link confirm failed");
    await interaction.update({
      content: "Something went wrong — try again.",
      embeds: [],
      components: [],
    });
  }
});
