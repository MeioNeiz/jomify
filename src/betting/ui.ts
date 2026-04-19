// Central style config for /market. Button fills stay neutral grey
// (Secondary) so the UI reads calm, Polymarket-ish — the yes/no signal
// is carried by the coloured emoji on the label, not the button tint.
// Tweak palette and labels here and the whole command picks them up.
import { ButtonStyle } from "discord.js";
import type { EmbedKind } from "../ui.js";

/**
 * In-game currency label. Centralised so a rename (shekels → gelt →
 * whatever) touches this one file. `format` handles singular/plural
 * so "1 shekel" reads right alongside "5 shekels".
 */
export const CURRENCY = {
  singular: "shekel",
  plural: "shekels",
  /** "1 shekel" / "5 shekels". Use for running copy. */
  format: (n: number) => `${n} ${n === 1 ? "shekel" : "shekels"}`,
  /** "Shekels" — sentence/label case, plural. Use for field titles. */
  label: "Shekels",
} as const;

export const MARKET_COPY = {
  title: (id: number, question: string) => `Market #${id} \u2014 ${question}`,
  volumeLabel: "Pool",
  betsLabel: "Bets",
  emptyBets: "_No bets yet._",
  footerOpen: "-# Tap Bet Yes / Bet No to back a side. Creator resolves below.",
  creatorPrefix: "Created by",
  resolvedPrefix: "Resolved",
  cancelledLine: "\u26A0\uFE0F Market cancelled \u2014 bets refunded.",
} as const;

/**
 * Market embed border colour. Stays on the brand pink in every state —
 * a big green/red slab feels too loud for an in-flight thread. The
 * title + emoji carry the status signal instead.
 */
export const MARKET_EMBED_COLOUR: EmbedKind = "brand";

export const MARKET_EMOJI = {
  yes: "\uD83D\uDFE2", // 🟢
  no: "\uD83D\uDD34", // 🔴
  resolved: "\u2705", // ✅
  cancelled: "\u26A0\uFE0F", // ⚠️
} as const;

export const MARKET_BUTTONS = {
  betYes: {
    style: ButtonStyle.Secondary,
    emoji: MARKET_EMOJI.yes,
    label: "Bet Yes",
  },
  betNo: {
    style: ButtonStyle.Secondary,
    emoji: MARKET_EMOJI.no,
    label: "Bet No",
  },
  resolveYes: {
    style: ButtonStyle.Secondary,
    label: "Resolve: Yes wins",
  },
  resolveNo: {
    style: ButtonStyle.Secondary,
    label: "Resolve: No wins",
  },
} as const;

export const MARKET_DURATIONS: { name: string; hours: number }[] = [
  { name: "1 hour", hours: 1 },
  { name: "6 hours", hours: 6 },
  { name: "1 day", hours: 24 },
  { name: "3 days", hours: 72 },
  { name: "1 week", hours: 168 },
];
