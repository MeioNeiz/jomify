import { SlashCommandBuilder } from "discord.js";
import { analyseStats, SUSPECT_THRESHOLD } from "../analyse.js";
import { freshnessSuffix } from "../helpers.js";
import { fetchInventorySummary, type InventorySummary } from "../inventory.js";
import { refreshPlayers } from "../refresh.js";
import {
  getLatestSnapshot,
  getPlayerMatchStats,
  getPlayerStatAverages,
} from "../store.js";
import { type EmbedKind, embed } from "../ui.js";
import { requireLinkedUser, respondWithRevalidate, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("sus")
  .setDescription("Is this player sussy?")
  .addUserOption((opt) => opt.setName("user").setDescription("Player to investigate"));

type InvResult = InventorySummary | "private" | "error" | null;

type Stat = { name: string; value: string; z: number; flagged: boolean };

type View = {
  verdict: string;
  icon: string;
  kind: EmbedKind;
  basic: string[];
  flagged: Stat[];
  elevated: Stat[];
  normal: Stat[];
  inv: InvResult;
  matchCount: number;
  latest: string | null;
};

function verdict(score: number): { verdict: string; icon: string; kind: EmbedKind } {
  if (score >= 8) return { verdict: "Suss", icon: "\u{1F6A9}", kind: "danger" };
  if (score >= SUSPECT_THRESHOLD)
    return { verdict: "Sussy", icon: "\u26A0\uFE0F", kind: "warn" };
  return { verdict: "Clean", icon: "\u2705", kind: "success" };
}

function buildBasicStats(steamId: string, inv: InvResult): string[] {
  const lines: string[] = [];

  const avgs = getPlayerStatAverages(steamId, 30);
  if (avgs) {
    lines.push(
      `\u{1F3AF} K/D **${avgs.avg_kd.toFixed(2)}**, ` +
        `HS **${(avgs.avg_hs * 100).toFixed(0)}%**, ` +
        `DPR **${avgs.avg_dpr.toFixed(0)}**, ` +
        `Leetify **${avgs.avg_rating.toFixed(2)}**`,
    );
  }

  const snap = getLatestSnapshot(steamId);
  if (snap?.premier) {
    lines.push(`\u{1F4C8} Premier **${snap.premier.toLocaleString()}**`);
  }

  if (inv && inv !== "private" && inv !== "error") {
    const top = inv.topItem
      ? `, top: ${inv.topItem.name} (£${inv.topItem.price.toFixed(2)})`
      : "";
    lines.push(
      `\u{1F4B0} Inventory **£${inv.totalValue.toFixed(2)}** (${inv.totalItems} items)${top}`,
    );
  } else if (inv === "private") {
    lines.push("\u{1F512} Inventory private");
  } else if (inv === "error") {
    lines.push("\u26A0\uFE0F Inventory: couldn't fetch");
  }

  return lines;
}

function buildView(steamId: string, label: string, inv: InvResult): View | null {
  const matches = getPlayerMatchStats(steamId, 30);
  if (!matches.length) return null;

  const { checks, score } = analyseStats(matches.map((m) => m.raw));
  const { verdict: v, icon, kind } = verdict(score);

  const flagged: Stat[] = [];
  const elevated: Stat[] = [];
  const normal: Stat[] = [];
  for (const c of checks) {
    if (c.flagged) flagged.push(c);
    else if (c.z > 1.5) elevated.push(c);
    else normal.push(c);
  }
  // Consistent order within each bucket: highest z first.
  flagged.sort((a, b) => b.z - a.z);
  elevated.sort((a, b) => b.z - a.z);
  normal.sort((a, b) => b.z - a.z);

  void label; // present to keep signature symmetric with future label-aware checks
  return {
    verdict: v,
    icon,
    kind,
    basic: buildBasicStats(steamId, inv),
    flagged,
    elevated,
    normal,
    inv,
    matchCount: matches.length,
    latest: matches[0]?.finishedAt ?? null,
  };
}

function renderChecks(stats: Stat[], icon: string): string {
  return stats.map((c) => `${icon} **${c.name}** ${c.value}`).join("\n");
}

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;
  const { steamId, label } = resolved;

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const v = buildView(steamId, label, null);
      return v && { data: v, snapshotAt: v.latest };
    },
    fetchFresh: async () => {
      // Swallow Leetify failures so the inventory still renders when the
      // API is down — match data stays stale but the rest of the embed
      // (basic stats, inventory) still updates.
      const [, inv] = await Promise.all([
        refreshPlayers([steamId]).catch(() => undefined),
        fetchInventorySummary(steamId).catch(() => "error" as const),
      ]);
      const v = buildView(steamId, label, inv);
      if (!v) throw new Error(`No match data for ${label}.`);
      return v;
    },
    render: ({
      verdict,
      icon,
      kind,
      basic,
      flagged,
      elevated,
      normal,
      matchCount,
      latest,
    }) => {
      const sections: string[] = [`${icon} **${verdict}**`];
      if (basic.length) sections.push(basic.join("\n"));

      const analysisParts: string[] = [];
      if (flagged.length) analysisParts.push(renderChecks(flagged, "\u{1F6A9}"));
      if (elevated.length) analysisParts.push(renderChecks(elevated, "\u26A0\uFE0F"));
      if (normal.length) analysisParts.push(renderChecks(normal, "\u2705"));
      if (analysisParts.length) sections.push(analysisParts.join("\n"));

      const e = embed(kind)
        .setTitle(`Sus Check: ${label}`)
        .setDescription(sections.join("\n\n") + freshnessSuffix(latest, "last match"))
        .setFooter({
          text: `${matchCount} matches, z-scores vs competitive avg, not definitive`,
        });
      return { embeds: [e] };
    },
    missingMessage: `No match data for ${label}. Track them first.`,
  });
});
