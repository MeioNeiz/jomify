import { SlashCommandBuilder } from "discord.js";
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
import { embed, rankPrefix } from "../ui.js";
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
        embed("danger")
          .setTitle("Wall of Shame")
          .setDescription(
            `<@${discordId}>'s worst game in the last 2 days.` +
              freshnessSuffix(v.finishedAt, "played"),
          )
          .addFields(
            {
              name: "Map",
              value: `${v.map} (${outcomeTag(v.roundsWon, v.roundsLost)})`,
              inline: true,
            },
            { name: "ADR", value: fmt(v.dpr, 0), inline: true },
            { name: "Rating", value: fmt(v.rating, 2), inline: true },
            {
              name: "KDA",
              value: `${v.kills}/${v.deaths}/${v.assists}`,
              inline: true,
            },
            { name: "K/D", value: kdRatio(v.kills, v.deaths), inline: true },
            { name: "HS %", value: `${fmt(v.hs * 100, 0)}%`, inline: true },
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
      const lines = top.map((r, i) => {
        const stat = `${fmt(r.dpr, 0)} ADR, ${kdRatio(r.kills, r.deaths)} K/D`;
        return (
          `${rankPrefix(i)} **${r.name}** on ${r.map} ` +
          `(${outcomeTag(r.roundsWon, r.roundsLost)})\n    ${stat}`
        );
      });
      const e = embed("danger")
        .setTitle(`Wall of Shame: ${TITLES[focus]}`)
        .setDescription(
          `**${top[0]?.name}** takes the crown.\n\n` +
            lines.join("\n") +
            freshnessSuffix(latest, "last match"),
        );
      return { embeds: [e] };
    },
    missingMessage: "No matches in the last 2 days.",
  });
}
