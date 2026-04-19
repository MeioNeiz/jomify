import {
  ActionRowBuilder,
  type InteractionEditReplyOptions,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { registerComponent } from "../components.js";
import { analyseStats } from "../cs/analyse.js";
import {
  getProfile,
  isLeetifyCircuitOpen,
  LeetifyNotFoundError,
} from "../cs/leetify/client.js";
import {
  type EncounterRow,
  getAllTrackedSteamIds,
  getEncounters,
  getPlayerMatchStats,
} from "../cs/store.js";
import log from "../logger.js";
import { embed } from "../ui.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
// Lowered to 1 so randoms appear in the initial pass — they typically
// only show up in 1-2 of our stored matches each. The local score is
// noisy at n=1 but the second-phase Leetify profile lookup firms it up.
const MIN_MATCHES_FOR_ANALYSIS = 1;
const ANALYSIS_HISTORY = 30;
const MAX_SURFACED = 25;

export const data = new SlashCommandBuilder()
  .setName("suspects")
  .setDescription("Rank everyone you've recently queued with or against by sus score")
  .addIntegerOption((o) =>
    o
      .setName("days")
      .setDescription(`Look-back window in days (default ${DEFAULT_DAYS})`)
      .setMinValue(1)
      .setMaxValue(MAX_DAYS),
  )
  .addUserOption((o) =>
    o.setName("user").setDescription("Player whose encounters to scan (defaults to you)"),
  );

interface SuspectEntry {
  steamId: string;
  name: string;
  /** Raw local z-score composite from analyseStats — unweighted, for debug. */
  localScore: number;
  /**
   * Sample-size-weighted local score (localScore * min(1, matchCount/3))
   * plus, for strong-sus players only, a bump from extreme Leetify
   * lifetime values. This is what's used for sorting, bands and display.
   */
  score: number;
  matchCount: number;
  encounterCount: number;
  withCount: number;
  vsCount: number;
  /** Lifetime stats from Leetify's /v3/profile, populated in phase 2. */
  profile: {
    aim: number;
    hs: number;
    preaim: number;
    bump: number;
  } | null;
  /** True if we tried to fetch and Leetify gave a usable response. */
  refined: boolean;
}

/**
 * Sample-size weighting: a 1-match player needs 3× the raw local score
 * to tie a 3+ match player. Caps at matchCount ≥ 3 so larger samples
 * aren't further rewarded — we just want to penalise tiny-n noise.
 */
function weightedScore(localScore: number, matchCount: number): number {
  return localScore * Math.min(1, matchCount / 3);
}

function verdictFor(score: number): { icon: string } {
  if (score >= 8) return { icon: "\u{1F6A9}" };
  if (score >= 5) return { icon: "\u26A0\uFE0F" };
  if (score >= 3) return { icon: "\u{1F914}" };
  return { icon: "\u2705" };
}

function groupByPlayer(encounters: EncounterRow[]): Map<string, EncounterRow[]> {
  const byId = new Map<string, EncounterRow[]>();
  for (const e of encounters) {
    const list = byId.get(e.otherSteamId);
    if (list) list.push(e);
    else byId.set(e.otherSteamId, [e]);
  }
  return byId;
}

function buildEntry(
  steamId: string,
  displayName: string,
  encounters: EncounterRow[],
): SuspectEntry | null {
  const history = getPlayerMatchStats(steamId, ANALYSIS_HISTORY);
  if (history.length < MIN_MATCHES_FOR_ANALYSIS) return null;
  const { score } = analyseStats(history.map((m) => m.raw));
  let withCount = 0;
  let vsCount = 0;
  for (const e of encounters) {
    if (e.relationship === "with") withCount++;
    else vsCount++;
  }
  const adjustedScore = weightedScore(score, history.length);
  return {
    steamId,
    name: displayName,
    localScore: score,
    score: adjustedScore,
    matchCount: history.length,
    encounterCount: encounters.length,
    withCount,
    vsCount,
    profile: null,
    refined: false,
  };
}

/**
 * Map Leetify lifetime stats into a score bump. Leetify returns these
 * on a 0-100 percentage scale (not 0-1 decimals) — verified against
 * /v3/profile output: a player at ~80 aim / 20% HS / 9cm preaim is
 * solid but not remarkable, a sus outlier is ≥90 aim / ≥40% HS / <3cm
 * preaim. Non-authoritative; scan signal, not verdict.
 */
function profileBump(aim: number, hs: number, preaim: number): number {
  let bump = 0;
  if (aim >= 90) bump += 2;
  else if (aim >= 80) bump += 1;
  if (hs >= 40) bump += 2;
  else if (hs >= 30) bump += 1;
  // Preaim in cm; lower is better. 0 usually means "no data".
  if (preaim > 0 && preaim < 3.0) bump += 2;
  else if (preaim > 0 && preaim < 5.0) bump += 1;
  return bump;
}

async function refineEntry(entry: SuspectEntry): Promise<SuspectEntry> {
  try {
    const profile = await getProfile(entry.steamId);
    const aim = profile.rating?.aim ?? 0;
    const hs = profile.stats?.accuracy_head ?? 0;
    const preaim = profile.stats?.preaim ?? 0;
    const bump = profileBump(aim, hs, preaim);
    return {
      ...entry,
      profile: { aim, hs, preaim, bump },
      score: weightedScore(entry.localScore, entry.matchCount) + bump,
      refined: true,
    };
  } catch (err) {
    if (err instanceof LeetifyNotFoundError) {
      // Profile doesn't exist on Leetify — nothing to refine with.
      return { ...entry, refined: true };
    }
    // Upstream down, private profile, etc. Leave the entry as-is so
    // the caller still sees a local estimate.
    return entry;
  }
}

function renderLine(s: SuspectEntry): string {
  const v = verdictFor(s.score);
  const profileUrl = `https://steamcommunity.com/profiles/${s.steamId}`;
  const main =
    `${v.icon} [${s.name}](${profileUrl}) **${s.score.toFixed(1)}**` +
    ` \u2014 ${s.encounterCount} games (${s.withCount} with, ${s.vsCount} vs)`;
  if (!s.profile) return main;
  const aim = s.profile.aim.toFixed(1);
  const hs = `${s.profile.hs.toFixed(1)}%`;
  const preaim = `${s.profile.preaim.toFixed(1)}cm`;
  return `${main}\n-# Leetify lifetime: aim ${aim} \u00B7 HS ${hs} \u00B7 preaim ${preaim}`;
}

function buildDetailSelect(entries: SuspectEntry[]) {
  const options = entries.slice(0, 25).map((s) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(s.name.slice(0, 100))
      .setValue(s.steamId)
      .setDescription(
        `Score ${s.score.toFixed(1)} \u00B7 ${s.encounterCount} games`.slice(0, 100),
      ),
  );
  const menu = new StringSelectMenuBuilder()
    .setCustomId("suspects:detail")
    .setPlaceholder("Inspect a player")
    .addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

type Summary = {
  label: string;
  days: number;
  totalEncounters: number;
  uniqueEncountered: number;
  hiddenCleanFriends: number;
  skipped: number;
};

function buildPayload(
  entries: SuspectEntry[],
  summary: Summary,
  phase: "refining" | "done" | "leetify-down",
): InteractionEditReplyOptions {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const shown = sorted.slice(0, MAX_SURFACED);
  const flaggedCount = sorted.filter((e) => e.score >= 4).length;

  const topScore = sorted[0]?.score ?? 0;
  const kind = topScore >= 5 ? "danger" : topScore >= 3 ? "warn" : "success";

  const title = `Suspects \u2014 ${summary.label} (last ${summary.days}d)`;
  const bands =
    "-# \uD83D\uDEA9 \u22658 strong sus \u00B7 \u26A0\uFE0F \u22655 sussy " +
    "\u00B7 \uD83E\uDD14 \u22653 elevated \u00B7 \u2705 clean. " +
    "Score = 30-day local z-score (weighted by match count). " +
    "Leetify lifetime shown for strong-sus players only.";
  const phaseNote =
    phase === "refining"
      ? "-# \u23F3 Refining with Leetify profile lookups\u2026"
      : phase === "leetify-down"
        ? "-# \u26A0\uFE0F Leetify is down \u2014 showing local estimates only."
        : "";

  const notes: string[] = [];
  if (summary.hiddenCleanFriends > 0) {
    notes.push(`${summary.hiddenCleanFriends} clean squadmate(s) hidden`);
  }
  if (summary.skipped > 0) {
    notes.push(`${summary.skipped} player(s) with no stored matches skipped`);
  }
  const header =
    `**${flaggedCount}** flagged of ${sorted.length} analysed ` +
    `across ${summary.uniqueEncountered} unique players, ${summary.totalEncounters} encounters` +
    (notes.length ? `\n-# ${notes.join(" \u00B7 ")}.` : "");

  const body = shown.length ? shown.map(renderLine).join("\n") : "_No candidates._";
  const hidden = sorted.length - shown.length;
  const hiddenLine =
    hidden > 0 ? `\n-# ${hidden} more hidden — try a shorter window.` : "";

  const descParts = [header, "", body];
  if (hiddenLine) descParts.push(hiddenLine);
  if (phaseNote) descParts.push("", phaseNote);
  descParts.push("", bands);

  const e = embed(kind).setTitle(title).setDescription(descParts.join("\n"));
  const components = shown.length ? [buildDetailSelect(shown)] : [];
  return { embeds: [e], components };
}

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;
  const { steamId, label } = resolved;
  const days = interaction.options.getInteger("days") ?? DEFAULT_DAYS;

  const encounters = getEncounters(steamId, days);
  if (!encounters.length) {
    await interaction.editReply(
      `No matches stored for ${label} in the last ${days} days.`,
    );
    return;
  }

  const trackedSet = new Set(getAllTrackedSteamIds());
  const FRIEND_SUS_THRESHOLD = 3;

  const entries: SuspectEntry[] = [];
  let skipped = 0;
  let hiddenCleanFriends = 0;
  for (const [otherId, rows] of groupByPlayer(encounters)) {
    if (otherId === steamId) continue;
    const entry = buildEntry(otherId, rows[0]?.otherName ?? otherId, rows);
    if (!entry) {
      skipped++;
      continue;
    }
    if (trackedSet.has(otherId) && entry.score < FRIEND_SUS_THRESHOLD) {
      hiddenCleanFriends++;
      continue;
    }
    entries.push(entry);
  }

  const summary: Summary = {
    label,
    days,
    totalEncounters: encounters.length,
    uniqueEncountered: new Set(encounters.map((e) => e.otherSteamId)).size,
    hiddenCleanFriends,
    skipped,
  };

  // Phase 1: render the local-only analysis immediately so the user
  // sees *something* fast. If Leetify is currently down we skip
  // phase 2 entirely (no point hammering a dead API).
  const leetifyDown = isLeetifyCircuitOpen();
  const phase1: "refining" | "leetify-down" = leetifyDown ? "leetify-down" : "refining";
  await interaction.editReply(buildPayload(entries, summary, phase1));

  if (leetifyDown) return;

  // Phase 2: fetch Leetify profiles only for players who are *already*
  // strong-sus on the weighted local score (≥8, matches the flag band
  // in verdictFor). Most invocations will do 0-3 fetches instead of
  // 25 — the user only cares about 30-day signal anyway, so we don't
  // need lifetime stats for the marginal cases.
  const STRONG_SUS_THRESHOLD = 8;
  const toRefine = entries.filter((e) => e.score >= STRONG_SUS_THRESHOLD);
  const toRefineIds = new Set(toRefine.map((e) => e.steamId));
  const results = await Promise.allSettled(toRefine.map(refineEntry));
  const refinedById = new Map<string, SuspectEntry>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const original = toRefine[i];
    if (!original) continue;
    refinedById.set(original.steamId, r.status === "fulfilled" ? r.value : original);
  }

  const enriched = entries.map((e) =>
    toRefineIds.has(e.steamId) ? (refinedById.get(e.steamId) ?? e) : e,
  );

  // If the circuit breaker tripped mid-refinement, mark the rendering
  // so the user knows some rows are still on local scores.
  const postPhase = isLeetifyCircuitOpen() ? "leetify-down" : "done";

  try {
    await interaction.editReply(buildPayload(enriched, summary, postPhase));
  } catch (err) {
    log.warn({ err }, "Failed to edit /suspects reply in phase 2");
  }
});

registerComponent("suspects", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  const [, action] = interaction.customId.split(":");
  if (action !== "detail") return;
  const steamId = interaction.values[0];
  if (!steamId) return;
  const history = getPlayerMatchStats(steamId, ANALYSIS_HISTORY);
  if (history.length < MIN_MATCHES_FOR_ANALYSIS) {
    await interaction.reply({
      content: "Not enough match history stored to analyse this player.",
      ephemeral: true,
    });
    return;
  }
  const { checks, score } = analyseStats(history.map((m) => m.raw));
  const flagged = checks.filter((c) => c.flagged).sort((a, b) => b.z - a.z);
  const elevated = checks
    .filter((c) => !c.flagged && c.z > 1.5)
    .sort((a, b) => b.z - a.z);
  const name = history[0]?.raw.name ?? steamId;
  const profileUrl = `https://steamcommunity.com/profiles/${steamId}`;
  const lines: string[] = [];
  lines.push(`Score **${score.toFixed(1)}** across ${history.length} recent matches.`);
  if (flagged.length) {
    lines.push("", "🚩 **Flagged**");
    for (const c of flagged) lines.push(`• ${c.name}: ${c.value}`);
  }
  if (elevated.length) {
    lines.push("", "⚠️ **Elevated**");
    for (const c of elevated) lines.push(`• ${c.name}: ${c.value}`);
  }
  if (!flagged.length && !elevated.length) {
    lines.push("No individual stats stand out.");
  }
  const kind = score >= 5 ? "danger" : score >= 3 ? "warn" : "success";
  const e = embed(kind)
    .setTitle(name)
    .setURL(profileUrl)
    .setDescription(lines.join("\n"));
  await interaction.reply({ embeds: [e], ephemeral: true });
});
