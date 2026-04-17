import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  fmt,
  freshnessSuffix,
  kdRatio,
  outcomeTag,
  requireTrackedGuild,
} from "../helpers.js";
import type { LeetifyPlayerStats } from "../leetify/types.js";
import { refreshPlayers } from "../refresh.js";
import { getMostRecentMatchTime, getRecentMatchesSince } from "../store.js";
import { requireLinkedUser, respondWithRevalidate, wrapCommand } from "./handler.js";

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

type Focus = "adr" | "rating" | "deaths" | "teamkills";

function focusValue(r: LeetifyPlayerStats, focus: Focus): number {
  if (focus === "deaths") return -r.total_deaths;
  if (focus === "teamkills") return -r.flashbang_hit_friend;
  if (focus === "rating") return r.leetify_rating ?? 0;
  return r.dpr;
}

const TITLES: Record<Focus, string> = {
  adr: "Lowest ADR",
  rating: "Worst Rating",
  deaths: "Most Deaths",
  teamkills: "Most Team Flashes",
};

export const execute = wrapCommand(async (interaction) => {
  const targetUser = interaction.options.getUser("user");
  const focus = (interaction.options.getString("focus") ?? "adr") as Focus;

  if (targetUser) {
    await shameOne(interaction, targetUser.id);
    return;
  }

  await shameGuild(interaction, focus);
});

async function shameOne(
  interaction: import("discord.js").ChatInputCommandInteraction,
  discordId: string,
) {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;

  type View = {
    dpr: number;
    map: string;
    kills: number;
    deaths: number;
    assists: number;
    rating: number | null;
    hs: number;
    roundsWon: number;
    roundsLost: number;
    finishedAt: string;
  };

  const pickWorst = (): View | null => {
    const matches = getRecentMatchesSince(resolved.steamId, 48);
    if (!matches.length) return null;
    const worst = matches.reduce((w, m) => (m.raw.dpr < w.raw.dpr ? m : w));
    const r = worst.raw;
    return {
      dpr: r.dpr,
      map: worst.mapName,
      kills: r.total_kills,
      deaths: r.total_deaths,
      assists: r.total_assists,
      rating: r.leetify_rating,
      hs: r.accuracy_head,
      roundsWon: r.rounds_won,
      roundsLost: r.rounds_lost,
      finishedAt: worst.finishedAt,
    };
  };

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const v = pickWorst();
      return v && { data: v, snapshotAt: v.finishedAt };
    },
    fetchFresh: async () => {
      await refreshPlayers([resolved.steamId]);
      const v = pickWorst();
      if (!v) throw new Error("No matches in the last 2 days.");
      return v;
    },
    render: (v) => ({
      embeds: [
        new EmbedBuilder()
          .setTitle("Wall of Shame")
          .setColor(0xff0000)
          .setDescription(
            `<@${discordId}>'s worst game (last 2 days):\n` +
              `**${fmt(v.dpr, 0)} ADR** on **${v.map}** \u2014 ` +
              `**${outcomeTag(v.roundsWon, v.roundsLost)}**\n` +
              `${v.kills}/${v.deaths}/${v.assists} KDA` +
              ` \u2022 ${fmt(v.rating, 2)} rating` +
              ` \u2022 ${fmt(v.hs * 100, 0)}% HS` +
              freshnessSuffix(v.finishedAt, "played"),
          ),
      ],
    }),
    missingMessage: "No matches in the last 2 days.",
  });
}

async function shameGuild(
  interaction: import("discord.js").ChatInputCommandInteraction,
  focus: Focus,
) {
  const guild = await requireTrackedGuild(interaction);
  if (!guild) return;
  const { steamIds } = guild;

  type Row = {
    name: string;
    value: number;
    map: string;
    kills: number;
    deaths: number;
    assists: number;
    dpr: number;
    rating: number | null;
    hs: number;
    roundsWon: number;
    roundsLost: number;
  };
  type View = { rows: Row[]; latest: string | null };

  const compute = (): View => {
    const rows: Row[] = [];
    for (const id of steamIds) {
      const matches = getRecentMatchesSince(id, 48);
      if (!matches.length) continue;
      const worst = matches.reduce((w, m) =>
        focusValue(m.raw, focus) < focusValue(w.raw, focus) ? m : w,
      );
      const r = worst.raw;
      rows.push({
        name: r.name,
        value: focusValue(r, focus),
        map: worst.mapName,
        kills: r.total_kills,
        deaths: r.total_deaths,
        assists: r.total_assists,
        dpr: r.dpr,
        rating: r.leetify_rating,
        hs: r.accuracy_head,
        roundsWon: r.rounds_won,
        roundsLost: r.rounds_lost,
      });
    }
    rows.sort((a, b) => a.value - b.value);
    return { rows, latest: getMostRecentMatchTime(steamIds) };
  };

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const v = compute();
      return v.rows.length ? { data: v, snapshotAt: v.latest } : null;
    },
    fetchFresh: async () => {
      await refreshPlayers(steamIds);
      return compute();
    },
    render: ({ rows, latest }) => {
      const top = rows.slice(0, 3);
      const lines = top.map(
        (r, i) =>
          `${i + 1}. **${r.name}** \u2014 ${fmt(r.dpr, 0)} ADR` +
          ` \u2022 ${kdRatio(r.kills, r.deaths)} KD on ${r.map}` +
          ` (${outcomeTag(r.roundsWon, r.roundsLost)})`,
      );
      const embed = new EmbedBuilder()
        .setTitle(`Wall of Shame \u2014 ${TITLES[focus]}`)
        .setColor(0xff0000)
        .setDescription(
          `**${top[0]?.name}** takes the crown\n\n` +
            lines.join("\n") +
            freshnessSuffix(latest, "last 2 days \u2022 most recent match"),
        );
      return { embeds: [embed] };
    },
    missingMessage: "No matches in the last 2 days.",
  });
}
