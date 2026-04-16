import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { fmt, freshnessSuffix, leetifyEmbed } from "../helpers.js";
import type { LeetifyProfile } from "../leetify/types.js";
import {
  getHeadToHead,
  getPlayerMatchStats,
  getPlayerStatAverages,
  getSteamId,
  type PlayerSnapshot,
} from "../store.js";
import { getProfileWithFallback, isFullProfile } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("compare")
  .setDescription("Compare two players side by side")
  .addUserOption((opt) =>
    opt.setName("user1").setDescription("First player").setRequired(true),
  )
  .addUserOption((opt) =>
    opt.setName("user2").setDescription("Second player").setRequired(true),
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

function combatDetail(
  p1Name: string,
  p2Name: string,
  a1: Record<string, number>,
  a2: Record<string, number>,
): EmbedBuilder {
  const rows: [string, string, number, boolean][] = [
    ["Kills", "avg_kills", 1, true],
    ["Deaths", "avg_deaths", 1, false],
    ["KD", "avg_kd", 2, true],
    ["HS %", "avg_hs", 1, true],
    ["Spray", "avg_spray", 1, true],
    ["DPR", "avg_dpr", 1, true],
  ];

  const lines = rows.map(([label, key, dec, hib]) => {
    const [s1, s2] = bold(a1[key], a2[key], dec, hib);
    return `${label}: ${s1} vs ${s2}`;
  });

  return leetifyEmbed(`${p1Name} vs ${p2Name} \u2014 Combat`).setDescription(
    lines.join("\n"),
  );
}

function utilityDetail(
  p1Name: string,
  p2Name: string,
  a1: Record<string, number>,
  a2: Record<string, number>,
): EmbedBuilder {
  const rows: [string, string, number, boolean][] = [
    ["Flash Enemies", "avg_flash_enemies", 1, true],
    ["HE Damage", "avg_he_damage", 1, true],
    ["Util on Death", "avg_util_on_death", 0, false],
    ["Team Flash %", "avg_team_flash_rate", 2, false],
  ];

  const lines = rows.map(([label, key, dec, hib]) => {
    const [s1, s2] = bold(a1[key], a2[key], dec, hib);
    return `${label}: ${s1} vs ${s2}`;
  });

  return leetifyEmbed(`${p1Name} vs ${p2Name} \u2014 Utility`).setDescription(
    lines.join("\n"),
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

function getName(p: LeetifyProfile | PlayerSnapshot): string {
  return isFullProfile(p) ? p.name : p.name;
}

function getRanks(p: LeetifyProfile | PlayerSnapshot) {
  if (isFullProfile(p)) return { premier: p.ranks?.premier, leetify: p.ranks?.leetify };
  return { premier: p.premier, leetify: p.leetify };
}

function getRating(p: LeetifyProfile | PlayerSnapshot) {
  if (isFullProfile(p)) return p.rating;
  return {
    aim: p.aim,
    positioning: p.positioning,
    utility: p.utility,
    clutch: p.clutch,
    opening: 0,
  };
}

// ── Execute ──

import { wrapCommand } from "./handler.js";

export const execute = wrapCommand(async (interaction) => {
  const u1 = interaction.options.getUser("user1", true);
  const u2 = interaction.options.getUser("user2", true);
  const id1 = getSteamId(u1.id);
  const id2 = getSteamId(u2.id);

  if (!id1 || !id2) {
    const who = !id1 ? u1.displayName : u2.displayName;
    await interaction.editReply(`${who} hasn't linked. Use \`/link\` first.`);
    return;
  }

  const focus = interaction.options.getString("focus");

  const [r1, r2] = await Promise.all([
    getProfileWithFallback(id1),
    getProfileWithFallback(id2),
  ]);

  const cached = r1.cached || r2.cached;
  const oldestSnapshot =
    [r1.snapshotAt, r2.snapshotAt].filter((s): s is string => !!s).sort()[0] ?? null;
  const p1 = r1.data;
  const p2 = r2.data;

  // For focus modes that only need local DB, skip profile entirely
  if (focus === "combat" || focus === "utility") {
    const a1 = getPlayerStatAverages(id1);
    const a2 = getPlayerStatAverages(id2);
    if (!a1 || !a2) {
      await interaction.editReply("Need match data for both players.");
      return;
    }
    const n1 = getName(p1),
      n2 = getName(p2);
    const embed =
      focus === "combat" ? combatDetail(n1, n2, a1, a2) : utilityDetail(n1, n2, a1, a2);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (focus === "h2h") {
    await interaction.editReply({
      embeds: [h2hDetail(getName(p1), getName(p2), id1, id2)],
    });
    return;
  }

  if (focus === "form") {
    await interaction.editReply({
      embeds: [formDetail(getName(p1), getName(p2), id1, id2)],
    });
    return;
  }

  // Default overview or ratings — need profile/snapshot data
  if (focus === "ratings" && isFullProfile(p1) && isFullProfile(p2)) {
    await interaction.editReply({ embeds: [ratingsDetail(p1, p2)] });
    return;
  }

  // Overview — works with either type
  const ranks1 = getRanks(p1),
    ranks2 = getRanks(p2);
  const rat1 = getRating(p1),
    rat2 = getRating(p2);
  const n1 = getName(p1),
    n2 = getName(p2);

  const [pr1, pr2] = bold(ranks1.premier, ranks2.premier, 0);
  const [lr1, lr2] = bold(ranks1.leetify, ranks2.leetify);
  const [a1, a2] = bold(rat1?.aim, rat2?.aim);
  const [u1v, u2v] = bold(rat1?.utility, rat2?.utility);
  const [pos1, pos2] = bold(rat1?.positioning, rat2?.positioning);

  const lines = [
    `Premier: ${pr1} vs ${pr2}`,
    `Leetify: ${lr1} vs ${lr2}`,
    `Aim: ${a1} vs ${a2}`,
    `Positioning: ${pos1} vs ${pos2}`,
    `Utility: ${u1v} vs ${u2v}`,
  ];

  const title = cached ? `${n1} vs ${n2} (cached)` : `${n1} vs ${n2}`;
  const desc = cached
    ? lines.join("\n") + freshnessSuffix(oldestSnapshot, "cached \u2014 last synced")
    : lines.join("\n");
  const embed = leetifyEmbed(title).setDescription(desc).setFooter({
    text: "Use focus option for detail: ratings, combat, utility, h2h, form",
  });

  await interaction.editReply({ embeds: [embed] });
});
