// Shared embed primitives. All commands should build their embeds via
// `embed()` and use these helpers so the bot presents a consistent
// visual language across ~15 slash commands. Raw `new EmbedBuilder()`
// is only acceptable where a command genuinely needs a one-off colour
// the palette doesn't cover (rare — prefer adding to COLOURS).
import { EmbedBuilder } from "discord.js";

/**
 * Canonical colour palette. Use semantic names (success/warn/danger)
 * for outcome-class embeds; use `brand` as the default; other keys
 * are topical flourishes used by exactly one command.
 */
export const COLOURS = {
  brand: 0xf84982, // Leetify pink — default for stat embeds
  success: 0x57f287, // Discord green — rank-ups, win streaks, "clean"
  warn: 0xfee75c, // Discord yellow — elevated/suspect
  danger: 0xed4245, // Discord red — rough games, "sus" flagged
  flash: 0xffff00, // /flash accent
  kobe: 0xff9933, // /kobe accent
} as const;

export type EmbedKind = keyof typeof COLOURS;

/** Branded EmbedBuilder. Pick the colour via `kind`; default is brand. */
export function embed(kind: EmbedKind = "brand"): EmbedBuilder {
  return new EmbedBuilder().setColor(COLOURS[kind]);
}

/** Rank prefix for leaderboard lists: medal for top 3, number otherwise. */
const MEDALS = ["\u{1F947}", "\u{1F948}", "\u{1F949}"] as const;
export function rankPrefix(index: number): string {
  return MEDALS[index] ?? `${index + 1}.`;
}

/**
 * Wrap rows in a monospace code block for aligned numeric columns
 * (leaderboards, /shame tables). Emoji render inline in code blocks
 * but don't preserve monospaced width, so keep symbols out of the
 * aligned columns.
 */
export function table(rows: string[]): string {
  return `\`\`\`\n${rows.join("\n")}\n\`\`\``;
}

/**
 * Pad a string to `width` with trailing spaces. String.prototype.padEnd
 * is Unicode-naive (counts code units), which breaks for wide chars;
 * this keeps it simple for ASCII-ish names. For fancy names the table
 * might wobble by a char — acceptable trade-off.
 */
export function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}
