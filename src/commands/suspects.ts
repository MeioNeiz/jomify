import {
  ActionRowBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { analyseStats } from "../analyse.js";
import { registerComponent } from "../components.js";
import {
  type EncounterRow,
  getAllTrackedSteamIds,
  getEncounters,
  getPlayerMatchStats,
} from "../store.js";
import { embed } from "../ui.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
// Lower than /sus's 10 — most randoms only appear in a handful of
// our stored matches (we save all 10 players whenever a tracked
// player is in a game), so a strict threshold would filter them out.
// The noise this adds is acceptable given /suspects is a scan not a
// verdict — worst case we flag a legit pro alongside the cheater.
const MIN_MATCHES_FOR_ANALYSIS = 5;
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
  score: number;
  matchCount: number;
  encounterCount: number;
  withCount: number;
  vsCount: number;
}

// Verdict bands. The underlying threshold for "flagged" in /sus is 4;
// here we widen to surface context (nothing happens at the cliff-edge
// of 4.0 looking dramatically different from 3.9).
function verdictFor(score: number): { icon: string } {
  if (score >= 8) return { icon: "\u{1F6A9}" }; // strong sus
  if (score >= 5) return { icon: "\u26A0\uFE0F" }; // sussy
  if (score >= 3) return { icon: "\u{1F914}" }; // slightly elevated — thinking-face
  return { icon: "\u2705" }; // clean
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
  return {
    steamId,
    name: displayName,
    score,
    matchCount: history.length,
    encounterCount: encounters.length,
    withCount,
    vsCount,
  };
}

function renderLine(s: SuspectEntry): string {
  const v = verdictFor(s.score);
  const profile = `https://steamcommunity.com/profiles/${s.steamId}`;
  // Score bold so it's the visual anchor; encounter split in parens.
  return (
    `${v.icon} [${s.name}](${profile}) **${s.score.toFixed(1)}**` +
    ` \u2014 ${s.encounterCount} games (${s.withCount} with, ${s.vsCount} vs)`
  );
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

  // Focus on randoms: tracked squadmates only show when their score
  // is actually suspicious (≥3, matching the "elevated" band). User
  // knows their friends are clean — no point cluttering the list with
  // them unless something looks off.
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

  entries.sort((a, b) => b.score - a.score);
  const shown = entries.slice(0, MAX_SURFACED);
  const flaggedCount = entries.filter((e) => e.score >= 4).length;
  const uniqueEncountered = new Set(encounters.map((e) => e.otherSteamId)).size;

  const title = `Suspects \u2014 ${label} (last ${days}d)`;
  // Colour leans on the strongest signal in the list: red if anyone is
  // genuinely flagged, yellow for elevated-only, green for clean.
  const topScore = entries[0]?.score ?? 0;
  const kind = topScore >= 5 ? "danger" : topScore >= 3 ? "warn" : "success";

  const subtext =
    "-# \uD83D\uDEA9 \u22658 strong sus \u00B7 \u26A0\uFE0F \u22655 sussy " +
    "\u00B7 \uD83E\uDD14 \u22653 elevated \u00B7 \u2705 clean. " +
    "Score is a z-score composite vs competitive averages, non-definitive.";
  const notes: string[] = [];
  if (hiddenCleanFriends > 0) {
    notes.push(`${hiddenCleanFriends} clean squadmate(s) hidden`);
  }
  if (skipped > 0) {
    notes.push(
      `${skipped} player(s) skipped (fewer than ${MIN_MATCHES_FOR_ANALYSIS} stored matches)`,
    );
  }
  const header =
    `**${flaggedCount}** flagged of ${entries.length} analysed ` +
    `across ${uniqueEncountered} unique players, ${encounters.length} encounters` +
    (notes.length ? `\n-# ${notes.join(" \u00B7 ")}.` : "");

  const body = shown.map(renderLine).join("\n");
  const hidden = entries.length - shown.length;
  const hiddenLine =
    hidden > 0 ? `\n-# ${hidden} more hidden — try a shorter window.` : "";

  const e = embed(kind)
    .setTitle(title)
    .setDescription(`${header}\n\n${body}${hiddenLine}\n\n${subtext}`);

  // Select menu lets the caller pull up a full /sus-style breakdown for
  // any listed player — the one-line format deliberately skips per-stat
  // flags, so this is how you dig in.
  const components = shown.length ? [buildDetailSelect(shown)] : [];
  await interaction.editReply({ embeds: [e], components });
});

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

// Select-menu handler: ephemeral per-player breakdown (flagged stats).
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
  const profile = `https://steamcommunity.com/profiles/${steamId}`;
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
  const e = embed(kind).setTitle(name).setURL(profile).setDescription(lines.join("\n"));
  await interaction.reply({ embeds: [e], ephemeral: true });
});
