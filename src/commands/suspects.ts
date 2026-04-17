import { SlashCommandBuilder } from "discord.js";
import { analyseStats } from "../analyse.js";
import { type EncounterRow, getEncounters, getPlayerMatchStats } from "../store.js";
import { embed } from "../ui.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const MIN_MATCHES_FOR_ANALYSIS = 10;
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

  const entries: SuspectEntry[] = [];
  let skipped = 0;
  for (const [otherId, rows] of groupByPlayer(encounters)) {
    if (otherId === steamId) continue;
    const entry = buildEntry(otherId, rows[0]?.otherName ?? otherId, rows);
    if (entry) entries.push(entry);
    else skipped++;
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
  const header =
    `**${flaggedCount}** flagged of ${entries.length} analysed ` +
    `(${uniqueEncountered} unique players, ${encounters.length} total encounters)` +
    (skipped > 0
      ? `\n-# ${skipped} player(s) skipped — fewer than ${MIN_MATCHES_FOR_ANALYSIS} recent matches stored.`
      : "");

  const body = shown.map(renderLine).join("\n");
  const hidden = entries.length - shown.length;
  const hiddenLine =
    hidden > 0 ? `\n-# ${hidden} more hidden — try a shorter window.` : "";

  const e = embed(kind)
    .setTitle(title)
    .setDescription(`${header}\n\n${body}${hiddenLine}\n\n${subtext}`);

  await interaction.editReply({ embeds: [e] });
});
