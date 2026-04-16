import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { fmt, freshnessSuffix, requireGuild } from "../helpers.js";
import {
  getMostRecentMatchTime,
  getRecentMatchesSince,
  getTrackedPlayers,
} from "../store.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("shame")
  .setDescription("Wall of shame — worst game in the last 2 days")
  .addUserOption((opt) => opt.setName("user").setDescription("Shame a specific player"))
  .addStringOption((opt) =>
    opt
      .setName("focus")
      .setDescription("What to shame")
      .addChoices(
        { name: "rating", value: "rating" },
        { name: "adr", value: "adr" },
        { name: "deaths", value: "deaths" },
        { name: "teamkills", value: "teamkills" },
      ),
  );

export const execute = wrapCommand(async (interaction) => {
  const targetUser = interaction.options.getUser("user");

  // Shame a specific player
  if (targetUser) {
    const resolved = await requireLinkedUser(interaction);
    if (!resolved) return;
    const matches = getRecentMatchesSince(resolved.steamId, 48);
    if (!matches.length) {
      await interaction.editReply("No matches in the last 2 days.");
      return;
    }
    const worst = matches.reduce((w, m) => (m.raw.dpr < w.raw.dpr ? m : w));
    const r = worst.raw;
    const embed = new EmbedBuilder()
      .setTitle("Wall of Shame")
      .setColor(0xff0000)
      .setDescription(
        `<@${targetUser.id}>'s worst game (last 2 days):\n` +
          `**${fmt(r.dpr, 0)} ADR** on **${worst.mapName}**\n` +
          `${r.total_kills}/${r.total_deaths}/${r.total_assists} KDA` +
          ` \u2022 ${fmt(r.leetify_rating, 2)} rating` +
          ` \u2022 ${fmt(r.accuracy_head * 100, 0)}% HS` +
          freshnessSuffix(worst.finishedAt, "played"),
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // Shame all tracked players
  const guildId = requireGuild(interaction);
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  const steamIds = getTrackedPlayers(guildId);
  if (!steamIds.length) {
    await interaction.editReply("No tracked players. Use `/track` to add some.");
    return;
  }

  const focus = interaction.options.getString("focus") ?? "adr";

  const results: {
    name: string;
    value: number;
    map: string;
    kills: number;
    deaths: number;
    assists: number;
    dpr: number;
    rating: number | null;
    hs: number;
  }[] = [];

  for (const id of steamIds) {
    const matches = getRecentMatchesSince(id, 48);
    if (!matches.length) continue;

    // Find the worst match by focus stat
    const worst = matches.reduce((w, m) => {
      const wv =
        focus === "deaths"
          ? -w.raw.total_deaths
          : focus === "teamkills"
            ? -w.raw.flashbang_hit_friend
            : focus === "rating"
              ? (w.raw.leetify_rating ?? 0)
              : w.raw.dpr;
      const mv =
        focus === "deaths"
          ? -m.raw.total_deaths
          : focus === "teamkills"
            ? -m.raw.flashbang_hit_friend
            : focus === "rating"
              ? (m.raw.leetify_rating ?? 0)
              : m.raw.dpr;
      return mv < wv ? m : w;
    });

    const r = worst.raw;
    results.push({
      name: r.name,
      value:
        focus === "deaths"
          ? -r.total_deaths
          : focus === "teamkills"
            ? -r.flashbang_hit_friend
            : focus === "rating"
              ? (r.leetify_rating ?? 0)
              : r.dpr,
      map: worst.mapName,
      kills: r.total_kills,
      deaths: r.total_deaths,
      assists: r.total_assists,
      dpr: r.dpr,
      rating: r.leetify_rating,
      hs: r.accuracy_head,
    });
  }

  if (!results.length) {
    await interaction.editReply("No matches in the last 2 days.");
    return;
  }

  results.sort((a, b) => a.value - b.value);

  const titles: Record<string, string> = {
    adr: "Lowest ADR",
    rating: "Worst Rating",
    deaths: "Most Deaths",
    teamkills: "Most Team Flashes",
  };

  const lines = results.map(
    (r, i) =>
      `${i + 1}. **${r.name}** \u2014 ${fmt(r.dpr, 0)} ADR` +
      ` \u2022 ${r.kills}/${r.deaths}/${r.assists}` +
      ` \u2022 ${fmt(r.rating, 2)} rating` +
      ` on ${r.map}`,
  );

  const latest = getMostRecentMatchTime(steamIds);
  const embed = new EmbedBuilder()
    .setTitle(`Wall of Shame \u2014 ${titles[focus]}`)
    .setColor(0xff0000)
    .setDescription(
      `**${results[0].name}** takes the crown\n\n` +
        lines.join("\n") +
        freshnessSuffix(latest, "last 2 days \u2022 most recent match"),
    );

  await interaction.editReply({ embeds: [embed] });
});
