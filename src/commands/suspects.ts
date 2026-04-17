import { SlashCommandBuilder } from "discord.js";
import { analyseStats, SUSPECT_THRESHOLD } from "../analyse.js";
import { relTime } from "../helpers.js";
import { type EncounterRow, getEncounters, getPlayerMatchStats } from "../store.js";
import { embed } from "../ui.js";
import { requireLinkedUser, wrapCommand } from "./handler.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const MIN_MATCHES_FOR_ANALYSIS = 10;
const ANALYSIS_HISTORY = 30;
const MAX_SURFACED = 10;

export const data = new SlashCommandBuilder()
  .setName("suspects")
  .setDescription("Find sus players you've recently queued with or against")
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
  flagged: string[];
  encounters: EncounterRow[];
}

function verdictFor(score: number): { label: string; icon: string } {
  if (score >= 8) return { label: "Suss", icon: "\u{1F6A9}" };
  return { label: "Sussy", icon: "\u26A0\uFE0F" };
}

/** Group encounters by the other player's steam id, preserving order. */
function groupByPlayer(encounters: EncounterRow[]): Map<string, EncounterRow[]> {
  const byId = new Map<string, EncounterRow[]>();
  for (const e of encounters) {
    const list = byId.get(e.otherSteamId);
    if (list) list.push(e);
    else byId.set(e.otherSteamId, [e]);
  }
  return byId;
}

function analyseCandidate(
  steamId: string,
  displayName: string,
  encounters: EncounterRow[],
): SuspectEntry | null {
  const history = getPlayerMatchStats(steamId, ANALYSIS_HISTORY);
  if (history.length < MIN_MATCHES_FOR_ANALYSIS) return null;

  const { checks, score } = analyseStats(history.map((m) => m.raw));
  if (score < SUSPECT_THRESHOLD) return null;

  const flagged = checks
    .filter((c) => c.flagged)
    .sort((a, b) => b.z - a.z)
    .map((c) => c.name);

  return {
    steamId,
    name: displayName,
    score,
    matchCount: history.length,
    flagged,
    encounters,
  };
}

function formatEncounter(e: EncounterRow): string {
  const side = e.relationship === "with" ? "with" : "vs";
  const map = e.mapName.replace(/^de_/, "");
  return `${side} on ${map}, ${relTime(e.finishedAt)}`;
}

function renderField(s: SuspectEntry): { name: string; value: string } {
  const v = verdictFor(s.score);
  const profile = `https://steamcommunity.com/profiles/${s.steamId}`;
  const header =
    `${v.icon} **[${s.name}](${profile})** ` +
    `\u2014 ${v.label} (score ${s.score.toFixed(1)}, ${s.matchCount} recent matches)`;
  const flagLine = s.flagged.length
    ? `\u{1F6A9} ${s.flagged.join(", ")}`
    : "No individual stat flagged, but composite score is elevated.";
  // Cap encounters shown per player so a single repeat offender doesn't
  // blow out the embed's 1024-char field limit. Matches are surfaced newest
  // first (encounters are ordered DESC by finished_at).
  const shown = s.encounters.slice(0, 5);
  const more = s.encounters.length - shown.length;
  const lines = shown.map(formatEncounter);
  if (more > 0) lines.push(`\u2026 and ${more} more`);
  return {
    name: `${s.name}`,
    value: `${header}\n${flagLine}\n${lines.join("\n")}`,
  };
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

  const suspects: SuspectEntry[] = [];
  for (const [otherId, rows] of groupByPlayer(encounters)) {
    // Skip the target themselves — shouldn't happen given the SQL, but be safe.
    if (otherId === steamId) continue;
    const entry = analyseCandidate(otherId, rows[0]?.otherName ?? otherId, rows);
    if (entry) suspects.push(entry);
  }

  // Highest score first so the worst offenders are at the top of the embed.
  suspects.sort((a, b) => b.score - a.score);
  const shown = suspects.slice(0, MAX_SURFACED);

  const uniqueEncountered = new Set(encounters.map((e) => e.otherSteamId)).size;
  const title = `Suspects \u2014 ${label} (last ${days}d)`;

  if (!shown.length) {
    const e = embed("success")
      .setTitle(title)
      .setDescription(
        `No sus players found across ${encounters.length} encounter(s) with ` +
          `${uniqueEncountered} unique player(s).\n` +
          "-# Sus score is a z-score composite vs competitive averages. " +
          "Non-definitive \u2014 players need 10+ recent matches to be analysed.",
      );
    await interaction.editReply({ embeds: [e] });
    return;
  }

  const e = embed("danger")
    .setTitle(title)
    .setDescription(
      `Flagged **${shown.length}** of ${uniqueEncountered} unique players ` +
        `across ${encounters.length} encounter(s).\n` +
        "-# Sus score is a z-score composite vs competitive averages. " +
        "Non-definitive \u2014 z-scores amplify small samples and legit pros flag too.",
    )
    .addFields(shown.map(renderField));

  if (suspects.length > MAX_SURFACED) {
    e.setFooter({
      text: `${suspects.length - MAX_SURFACED} more suspect(s) hidden \u2014 narrow the window with days:`,
    });
  }

  await interaction.editReply({ embeds: [e] });
});
