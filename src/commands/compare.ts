import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { fmt, freshnessSuffix, leetifyEmbed } from "../helpers.js";
import { getProfile } from "../leetify/client.js";
import type { LeetifyProfile } from "../leetify/types.js";
import {
  getHeadToHead,
  getLatestSnapshot,
  getPlayerMatchStats,
  getPlayerStatAverages,
  getSteamId,
  type PlayerAverages,
} from "../store.js";
import { respondWithRevalidate } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("compare")
  .setDescription("Compare two players side by side")
  .addUserOption((opt) =>
    opt.setName("user2").setDescription("Other player").setRequired(true),
  )
  .addUserOption((opt) =>
    opt.setName("user1").setDescription("First player (defaults to you)"),
  )
  .addStringOption((opt) =>
    opt
      .setName("focus")
      .setDescription("Drill into a stat area")
      .addChoices(
        { name: "ratings", value: "ratings" },
        { name: "combat", value: "combat" },
        { name: "utility", value: "utility" },
        { name: "h2h", value: "h2h" },
        { name: "form", value: "form" },
      ),
  );

function bold(
  v1: number | null | undefined,
  v2: number | null | undefined,
  dec = 1,
  higherIsBetter = true,
): [string, string] {
  const s1 = fmt(v1, dec);
  const s2 = fmt(v2, dec);
  if (v1 == null || v2 == null) return [s1, s2];
  const better = higherIsBetter ? v1 - v2 : v2 - v1;
  if (better > 0) return [`**${s1}**`, s2];
  if (better < 0) return [s1, `**${s2}**`];
  return [s1, s2];
}

// ── Default: brief overview ──

// ── Focus: detailed views ──

function ratingsDetail(p1: LeetifyProfile, p2: LeetifyProfile): EmbedBuilder {
  const pairs: [string, number?, number?][] = [
    ["Leetify", p1.ranks?.leetify ?? undefined, p2.ranks?.leetify ?? undefined],
    ["Aim", p1.rating.aim, p2.rating.aim],
    ["Positioning", p1.rating.positioning, p2.rating.positioning],
    ["Utility", p1.rating.utility, p2.rating.utility],
    ["Clutch", p1.rating.clutch, p2.rating.clutch],
    ["Opening", p1.rating.opening, p2.rating.opening],
  ];

  const lines = pairs.map(([label, v1, v2]) => {
    const [s1, s2] = bold(v1, v2);
    return `${label}: ${s1} vs ${s2}`;
  });

  return leetifyEmbed(`${p1.name} vs ${p2.name} \u2014 Ratings`).setDescription(
    lines.join("\n"),
  );
}

type Row = {
  label: string;
  key: keyof PlayerAverages;
  dec: number;
  higherIsBetter: boolean;
};

function averagesEmbed(
  title: string,
  rows: Row[],
  a1: PlayerAverages,
  a2: PlayerAverages,
): EmbedBuilder {
  const lines = rows.map(({ label, key, dec, higherIsBetter }) => {
    const [s1, s2] = bold(a1[key], a2[key], dec, higherIsBetter);
    return `${label}: ${s1} vs ${s2}`;
  });
  return leetifyEmbed(title).setDescription(lines.join("\n"));
}

function combatDetail(
  p1Name: string,
  p2Name: string,
  a1: PlayerAverages,
  a2: PlayerAverages,
): EmbedBuilder {
  return averagesEmbed(
    `${p1Name} vs ${p2Name} \u2014 Combat (last 30)`,
    [
      { label: "Kills", key: "avg_kills", dec: 1, higherIsBetter: true },
      { label: "Deaths", key: "avg_deaths", dec: 1, higherIsBetter: false },
      { label: "KD", key: "avg_kd", dec: 2, higherIsBetter: true },
      { label: "HS %", key: "avg_hs", dec: 1, higherIsBetter: true },
      { label: "Spray", key: "avg_spray", dec: 1, higherIsBetter: true },
      { label: "DPR", key: "avg_dpr", dec: 1, higherIsBetter: true },
    ],
    a1,
    a2,
  );
}

function utilityDetail(
  p1Name: string,
  p2Name: string,
  a1: PlayerAverages,
  a2: PlayerAverages,
): EmbedBuilder {
  return averagesEmbed(
    `${p1Name} vs ${p2Name} \u2014 Utility (last 30)`,
    [
      {
        label: "Enemy flash %",
        key: "flash_enemy_rate",
        dec: 2,
        higherIsBetter: true,
      },
      {
        label: "Team flash %",
        key: "flash_friend_rate",
        dec: 2,
        higherIsBetter: false,
      },
      { label: "HE Damage", key: "avg_he_damage", dec: 1, higherIsBetter: true },
      { label: "Util on Death", key: "avg_util_on_death", dec: 0, higherIsBetter: false },
    ],
    a1,
    a2,
  );
}

function h2hDetail(
  p1Name: string,
  p2Name: string,
  steamId1: string,
  steamId2: string,
): EmbedBuilder {
  const h2h = getHeadToHead(steamId1, steamId2);

  if (h2h.sharedMatches === 0) {
    return leetifyEmbed(`${p1Name} vs ${p2Name} \u2014 H2H`).setDescription(
      "No shared matches found.",
    );
  }

  const lines = [`Shared matches: **${h2h.sharedMatches}**`];

  if (h2h.sameTeamMatches > 0) {
    const wr = ((h2h.sameTeamWins / h2h.sameTeamMatches) * 100).toFixed(0);
    lines.push(
      `Together: ${h2h.sameTeamWins}W ` +
        `${h2h.sameTeamLosses}L ` +
        `${h2h.sameTeamDraws}D ` +
        `(**${wr}%** WR)`,
    );
  }

  const opp = h2h.sharedMatches - h2h.sameTeamMatches;
  if (opp > 0) {
    lines.push(`Against each other: **${opp}**`);
  }

  return leetifyEmbed(`${p1Name} vs ${p2Name} \u2014 H2H`).setDescription(
    lines.join("\n"),
  );
}

function formDetail(
  p1Name: string,
  p2Name: string,
  steamId1: string,
  steamId2: string,
): EmbedBuilder {
  const m1 = getPlayerMatchStats(steamId1, 5);
  const m2 = getPlayerMatchStats(steamId2, 5);

  const trend = (matches: typeof m1): string => {
    if (!matches.length) return "No data";
    return [...matches]
      .reverse()
      .map((m) => fmt(m.raw.leetify_rating, 2))
      .join(" \u2192 ");
  };

  const arrow = (matches: typeof m1): string => {
    if (matches.length < 2) return "";
    const first = matches[matches.length - 1].raw.leetify_rating;
    const last = matches[0].raw.leetify_rating;
    if (first == null || last == null) return "";
    return last > first ? " \u{1F4C8}" : " \u{1F4C9}";
  };

  const lines = [
    `${p1Name}${arrow(m1)}: ${trend(m1)}`,
    `${p2Name}${arrow(m2)}: ${trend(m2)}`,
  ];

  return leetifyEmbed(`${p1Name} vs ${p2Name} \u2014 Recent Form`).setDescription(
    lines.join("\n"),
  );
}

// ── Helpers for profile/snapshot ──

// ── Execute ──

import { wrapCommand } from "./handler.js";

type OverviewView = {
  n1: string;
  n2: string;
  premier1: number | null;
  premier2: number | null;
  leetify1: number | null;
  leetify2: number | null;
  aim1: number;
  aim2: number;
  positioning1: number;
  positioning2: number;
  utility1: number;
  utility2: number;
};

export const execute = wrapCommand(async (interaction) => {
  const u1 = interaction.options.getUser("user1") ?? interaction.user;
  const u2 = interaction.options.getUser("user2", true);
  const id1 = getSteamId(u1.id);
  const id2 = getSteamId(u2.id);

  if (!id1 || !id2) {
    const who = !id1 ? u1.displayName : u2.displayName;
    await interaction.editReply(`${who} hasn't linked. Use \`/link\` first.`);
    return;
  }

  const focus = interaction.options.getString("focus");

  // Focus modes backed purely by local match data — no API needed.
  if (focus === "combat" || focus === "utility") {
    const [a1, a2] = [getPlayerStatAverages(id1), getPlayerStatAverages(id2)];
    const [s1, s2] = [getLatestSnapshot(id1), getLatestSnapshot(id2)];
    if (!a1 || !a2) {
      await interaction.editReply("Need match data for both players.");
      return;
    }
    const n1 = s1?.name ?? u1.displayName;
    const n2 = s2?.name ?? u2.displayName;
    const embed =
      focus === "combat" ? combatDetail(n1, n2, a1, a2) : utilityDetail(n1, n2, a1, a2);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (focus === "h2h" || focus === "form") {
    const [s1, s2] = [getLatestSnapshot(id1), getLatestSnapshot(id2)];
    const n1 = s1?.name ?? u1.displayName;
    const n2 = s2?.name ?? u2.displayName;
    const embed =
      focus === "h2h" ? h2hDetail(n1, n2, id1, id2) : formDetail(n1, n2, id1, id2);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // `ratings` focus needs the full LeetifyProfile (includes `opening`),
  // so it blocks on a fresh API call. No cached variant possible.
  if (focus === "ratings") {
    const [p1, p2] = await Promise.all([getProfile(id1), getProfile(id2)]);
    await interaction.editReply({ embeds: [ratingsDetail(p1, p2)] });
    return;
  }

  // Default overview — stale-while-revalidate.
  await respondWithRevalidate<OverviewView>(interaction, {
    fetchCached: () => {
      const [s1, s2] = [getLatestSnapshot(id1), getLatestSnapshot(id2)];
      if (!s1 || !s2) return null;
      const oldest = [s1.recordedAt, s2.recordedAt].sort()[0] ?? null;
      return {
        data: {
          n1: s1.name,
          n2: s2.name,
          premier1: s1.premier,
          premier2: s2.premier,
          leetify1: s1.leetify,
          leetify2: s2.leetify,
          aim1: s1.aim,
          aim2: s2.aim,
          positioning1: s1.positioning,
          positioning2: s2.positioning,
          utility1: s1.utility,
          utility2: s2.utility,
        },
        snapshotAt: oldest,
      };
    },
    fetchFresh: async () => {
      const [p1, p2] = await Promise.all([getProfile(id1), getProfile(id2)]);
      return {
        n1: p1.name,
        n2: p2.name,
        premier1: p1.ranks?.premier ?? null,
        premier2: p2.ranks?.premier ?? null,
        leetify1: p1.ranks?.leetify ?? null,
        leetify2: p2.ranks?.leetify ?? null,
        aim1: p1.rating?.aim ?? 0,
        aim2: p2.rating?.aim ?? 0,
        positioning1: p1.rating?.positioning ?? 0,
        positioning2: p2.rating?.positioning ?? 0,
        utility1: p1.rating?.utility ?? 0,
        utility2: p2.rating?.utility ?? 0,
      };
    },
    render: (v, { cached, snapshotAt }) => {
      const [pr1, pr2] = bold(v.premier1, v.premier2, 0);
      const [lr1, lr2] = bold(v.leetify1, v.leetify2);
      const [a1, a2] = bold(v.aim1, v.aim2);
      const [u1v, u2v] = bold(v.utility1, v.utility2);
      const [pos1, pos2] = bold(v.positioning1, v.positioning2);
      const lines = [
        `Premier: ${pr1} vs ${pr2}`,
        `Leetify: ${lr1} vs ${lr2}`,
        `Aim: ${a1} vs ${a2}`,
        `Positioning: ${pos1} vs ${pos2}`,
        `Utility: ${u1v} vs ${u2v}`,
      ];
      const desc = cached
        ? lines.join("\n") + freshnessSuffix(snapshotAt, "snapshot from")
        : lines.join("\n");
      const embed = leetifyEmbed(`${v.n1} vs ${v.n2}`).setDescription(desc).setFooter({
        text: "Use focus option for detail: ratings, combat, utility, h2h, form",
      });
      return { embeds: [embed] };
    },
  });
});
