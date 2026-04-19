import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { respondWithRevalidate } from "../../commands/handler.js";
import { fmt, freshnessSuffix } from "../../helpers.js";
import { embed } from "../../ui.js";
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

// Each comparison row produces a pair of side-by-side inline fields so the
// two players render as aligned columns in Discord's embed layout.
type CompareRow = {
  label: string;
  v1: number | null | undefined;
  v2: number | null | undefined;
  dec?: number;
  higherIsBetter?: boolean;
};

function buildComparisonEmbed(
  title: string,
  p1Name: string,
  p2Name: string,
  rows: CompareRow[],
): EmbedBuilder {
  // Stack values as one multi-line field per player so they sit side by side.
  const labels: string[] = [];
  const col1: string[] = [];
  const col2: string[] = [];
  for (const r of rows) {
    const [s1, s2] = bold(r.v1, r.v2, r.dec ?? 1, r.higherIsBetter ?? true);
    labels.push(r.label);
    col1.push(s1);
    col2.push(s2);
  }
  const rowLabel = labels.map((l) => `**${l}**`).join("\n");
  return embed()
    .setTitle(title)
    .addFields(
      { name: "Stat", value: rowLabel, inline: true },
      { name: p1Name, value: col1.join("\n"), inline: true },
      { name: p2Name, value: col2.join("\n"), inline: true },
    );
}

function ratingsDetail(p1: LeetifyProfile, p2: LeetifyProfile): EmbedBuilder {
  return buildComparisonEmbed(`${p1.name} vs ${p2.name}: Ratings`, p1.name, p2.name, [
    { label: "Leetify", v1: p1.ranks?.leetify, v2: p2.ranks?.leetify },
    { label: "Aim", v1: p1.rating.aim, v2: p2.rating.aim },
    { label: "Positioning", v1: p1.rating.positioning, v2: p2.rating.positioning },
    { label: "Utility", v1: p1.rating.utility, v2: p2.rating.utility },
    { label: "Clutch", v1: p1.rating.clutch, v2: p2.rating.clutch },
    { label: "Opening", v1: p1.rating.opening, v2: p2.rating.opening },
  ]);
}

function averagesEmbed(
  title: string,
  p1Name: string,
  p2Name: string,
  rows: (Omit<CompareRow, "v1" | "v2"> & { key: keyof PlayerAverages })[],
  a1: PlayerAverages,
  a2: PlayerAverages,
): EmbedBuilder {
  return buildComparisonEmbed(
    title,
    p1Name,
    p2Name,
    rows.map((r) => ({
      label: r.label,
      v1: a1[r.key],
      v2: a2[r.key],
      dec: r.dec,
      higherIsBetter: r.higherIsBetter,
    })),
  );
}

function combatDetail(
  p1Name: string,
  p2Name: string,
  a1: PlayerAverages,
  a2: PlayerAverages,
): EmbedBuilder {
  return averagesEmbed(
    `${p1Name} vs ${p2Name}: Combat (Last 30)`,
    p1Name,
    p2Name,
    [
      { label: "Kills", key: "avg_kills", dec: 1, higherIsBetter: true },
      { label: "Deaths", key: "avg_deaths", dec: 1, higherIsBetter: false },
      { label: "K/D", key: "avg_kd", dec: 2, higherIsBetter: true },
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
    `${p1Name} vs ${p2Name}: Utility (Last 30)`,
    p1Name,
    p2Name,
    [
      { label: "Enemy Flash %", key: "flash_enemy_rate", dec: 2, higherIsBetter: true },
      {
        label: "Team Flash %",
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
  const title = `${p1Name} vs ${p2Name}: H2H`;

  if (h2h.sharedMatches === 0) {
    return embed().setTitle(title).setDescription("No shared matches found.");
  }

  const e = embed()
    .setTitle(title)
    .addFields({
      name: "Shared Matches",
      value: `**${h2h.sharedMatches}**`,
      inline: true,
    });

  if (h2h.sameTeamMatches > 0) {
    const wr = ((h2h.sameTeamWins / h2h.sameTeamMatches) * 100).toFixed(0);
    e.addFields({
      name: "Together",
      value:
        `${h2h.sameTeamWins}W ${h2h.sameTeamLosses}L ${h2h.sameTeamDraws}D ` +
        `(**${wr}%** WR)`,
      inline: true,
    });
  }

  const opp = h2h.sharedMatches - h2h.sameTeamMatches;
  if (opp > 0) {
    e.addFields({ name: "Opposing", value: `**${opp}** matches`, inline: true });
  }
  return e;
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

  return embed()
    .setTitle(`${p1Name} vs ${p2Name}: Recent Form`)
    .addFields(
      { name: `${p1Name}${arrow(m1)}`, value: trend(m1), inline: false },
      { name: `${p2Name}${arrow(m2)}`, value: trend(m2), inline: false },
    );
}

// ── Helpers for profile/snapshot ──

// ── Execute ──

import { wrapCommand } from "../../commands/handler.js";

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
      const e = buildComparisonEmbed(`${v.n1} vs ${v.n2}`, v.n1, v.n2, [
        { label: "Premier", v1: v.premier1, v2: v.premier2, dec: 0 },
        { label: "Leetify", v1: v.leetify1, v2: v.leetify2 },
        { label: "Aim", v1: v.aim1, v2: v.aim2 },
        { label: "Positioning", v1: v.positioning1, v2: v.positioning2 },
        { label: "Utility", v1: v.utility1, v2: v.utility2 },
      ]).setFooter({
        text: "Use focus option for detail: ratings, combat, utility, h2h, form",
      });
      if (cached) e.setDescription(freshnessSuffix(snapshotAt, "snapshot from").trim());
      return { embeds: [e] };
    },
  });
});
