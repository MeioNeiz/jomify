// Stock price resolvers: price-above, price-below, pct-move. All three
// share the same poll/state pattern: skip outside trading hours, skip
// if last check was < 15 min ago, resolve YES the moment the condition
// is met, NO at the market deadline. Excluded from auto-cancel sweep.
//
// Requires ALPHA_VANTAGE_KEY in env. If missing, all three return
// "pending" indefinitely (markets just drift until manual resolution or
// expiry — not ideal, but silent rather than crashing).
import { config } from "../../config.js";
import { fetchQuote, isDuringTradingHours, shouldPoll } from "./alpha-vantage.js";
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

// ── Shared helpers ────────────────────────────────────────────────────

type PriceArgs = { ticker: string; target: number };
type PctArgs = { ticker: string; pct: number; direction: "up" | "down" };
type StockState = { lastCheckedIso?: string; startPrice?: number };

function parsePriceArgs(raw: unknown): PriceArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ticker !== "string" || typeof o.target !== "number") return null;
  return { ticker: o.ticker, target: o.target };
}

function parsePctArgs(raw: unknown): PctArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.ticker !== "string" ||
    typeof o.pct !== "number" ||
    (o.direction !== "up" && o.direction !== "down")
  )
    return null;
  return { ticker: o.ticker, pct: o.pct, direction: o.direction };
}

function parseState(raw: unknown): StockState {
  if (!raw || typeof raw !== "object") return {};
  return raw as StockState;
}

function isExpired(ctx: ResolverContext): boolean {
  if (!ctx.bet.expiresAt) return false;
  return ctx.now >= new Date(`${ctx.bet.expiresAt}Z`);
}

async function poll(
  ctx: ResolverContext,
  ticker: string,
): Promise<{ price: number | null; nextState: StockState }> {
  const state = parseState(ctx.state);
  const apiKey = config.alphaVantageKey;
  if (
    !apiKey ||
    !isDuringTradingHours(ctx.now) ||
    !shouldPoll(state.lastCheckedIso, ctx.now)
  ) {
    return { price: null, nextState: state };
  }
  const quote = await fetchQuote(ticker, apiKey, ctx.fetch);
  const nextState: StockState = { ...state, lastCheckedIso: ctx.now.toISOString() };
  return { price: quote?.price ?? null, nextState };
}

// ── stock:price-above ─────────────────────────────────────────────────

register({
  kind: "stock:price-above",
  describe: (raw) => {
    const args = parsePriceArgs(raw);
    if (!args) return "Auto-resolves on stock price.";
    return `YES if ${args.ticker} closes above $${args.target.toFixed(2)} before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parsePriceArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };
    if (isExpired(ctx)) {
      return {
        kind: "resolve",
        outcome: "no",
        note: `Deadline passed — ${args.ticker} didn't clear $${args.target.toFixed(2)}.`,
      };
    }
    const { price, nextState } = await poll(ctx, args.ticker);
    if (price !== null && price > args.target) {
      return {
        kind: "resolve",
        outcome: "yes",
        note: `${args.ticker} at $${price.toFixed(2)} (> $${args.target.toFixed(2)}).`,
      };
    }
    return { kind: "pending", nextState };
  },
});

// ── stock:price-below ─────────────────────────────────────────────────

register({
  kind: "stock:price-below",
  describe: (raw) => {
    const args = parsePriceArgs(raw);
    if (!args) return "Auto-resolves on stock price.";
    return `YES if ${args.ticker} falls below $${args.target.toFixed(2)} before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parsePriceArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };
    if (isExpired(ctx)) {
      return {
        kind: "resolve",
        outcome: "no",
        note: `Deadline passed — ${args.ticker} stayed above $${args.target.toFixed(2)}.`,
      };
    }
    const { price, nextState } = await poll(ctx, args.ticker);
    if (price !== null && price < args.target) {
      return {
        kind: "resolve",
        outcome: "yes",
        note: `${args.ticker} at $${price.toFixed(2)} (< $${args.target.toFixed(2)}).`,
      };
    }
    return { kind: "pending", nextState };
  },
});

// ── stock:pct-move ────────────────────────────────────────────────────

register({
  kind: "stock:pct-move",
  describe: (raw) => {
    const args = parsePctArgs(raw);
    if (!args) return "Auto-resolves on stock % move.";
    const dir = args.direction === "up" ? "up" : "down";
    return `YES if ${args.ticker} moves ${dir} ≥ ${args.pct}% before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parsePctArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };
    if (isExpired(ctx)) {
      return {
        kind: "resolve",
        outcome: "no",
        note: `Deadline passed — ${args.ticker} didn't move ${args.direction} ≥ ${args.pct}%.`,
      };
    }
    const { price, nextState } = await poll(ctx, args.ticker);
    if (price === null) return { kind: "pending", nextState };

    if (nextState.startPrice === undefined) {
      nextState.startPrice = price;
      return { kind: "pending", nextState };
    }

    const start = nextState.startPrice;
    const pctChange = ((price - start) / start) * 100;
    const hit = args.direction === "up" ? pctChange >= args.pct : pctChange <= -args.pct;

    if (hit) {
      const sign = pctChange >= 0 ? "+" : "";
      return {
        kind: "resolve",
        outcome: "yes",
        note: `${args.ticker} ${sign}${pctChange.toFixed(2)}% from $${start.toFixed(2)}.`,
      };
    }
    return { kind: "pending", nextState };
  },
});
