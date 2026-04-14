import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import {
  saveSnapshots,
  saveLeaderboardSnapshot,
  getLastLeaderboard,
  type PlayerSnapshot,
} from "../store.js";
import {
  requireGuild,
  fetchGuildProfiles,
  leetifyEmbed,
} from "../helpers.js";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription(
    "Rank tracked players by Premier rating"
  );

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  const guildId = requireGuild(interaction);
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  const profiles = await fetchGuildProfiles(guildId);
  if (!profiles) {
    await interaction.editReply(
      "No tracked players. Use `/track` to add some."
    );
    return;
  }

  try {
    const snapshots: PlayerSnapshot[] = profiles.map(
      (p) => ({
        steamId: p.steam64_id,
        name: p.name,
        premier: p.ranks?.premier ?? null,
        leetify: p.ranks?.leetify ?? null,
        aim: p.rating?.aim,
        positioning: p.rating?.positioning,
        utility: p.rating?.utility,
        clutch: p.rating?.clutch,
      })
    );
    saveSnapshots(snapshots);

    const previous = getLastLeaderboard(guildId);
    const prevMap = new Map(
      previous.map((e) => [e.steamId, e.premier])
    );

    const entries = profiles
      .map((p) => ({
        steamId: p.steam64_id,
        name: p.name,
        premier: p.ranks?.premier ?? 0,
      }))
      .sort((a, b) => b.premier - a.premier);

    saveLeaderboardSnapshot(
      guildId,
      entries.map((e) => ({
        steamId: e.steamId,
        premier: e.premier,
      }))
    );

    const prevOrder = [...previous]
      .sort(
        (a, b) => (b.premier ?? 0) - (a.premier ?? 0)
      )
      .map((e) => e.steamId);

    const medals = ["\u{1f947}", "\u{1f948}", "\u{1f949}"];

    const lines = entries.map((e, i) => {
      const prefix = medals[i] ?? `${i + 1}.`;
      const rating = e.premier
        ? e.premier.toLocaleString()
        : "Unranked";

      let change = "";
      const prev = prevMap.get(e.steamId);
      if (prev != null && e.premier) {
        const diff = e.premier - prev;
        if (diff > 0) change = ` (+${diff})`;
        else if (diff < 0) change = ` (${diff})`;
      }

      let posChange = "";
      if (prevOrder.length) {
        const oldPos = prevOrder.indexOf(e.steamId);
        if (oldPos !== -1 && oldPos !== i) {
          const moved = oldPos - i;
          posChange = moved > 0
            ? " \u2B06\uFE0F"
            : " \u2B07\uFE0F";
        }
      }

      return (
        `${prefix} **${e.name}** \u2014 `
        + `${rating}${change}${posChange}`
      );
    });

    const embed = leetifyEmbed("Leaderboard")
      .setDescription(lines.join("\n"));

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("Leaderboard error:", err);
    await interaction.editReply(
      "Failed to fetch stats. Try again later."
    );
  }
}
