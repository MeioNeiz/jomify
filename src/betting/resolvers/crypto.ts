// Crypto price resolvers: price-above, price-below, pct-move. Same
// poll/state pattern as the stock resolvers but without a trading-hours
// gate (crypto trades 24/7) and with a shorter 5-minute poll interval.
// Excluded from the auto-cancel sweep so expiry can resolve NO.
//
// No API key required — CoinGecko's simple-price endpoint is public.
import { fetchCryptoPrice, shouldPoll } from "./coingecko.js";
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

// ── Shared helpers ────────────────────────────────────────────────────

type PriceArgs = { symbol: string; target: number };
type PctArgs = { symbol: string; pct: number; direction: "up" | "down" };
type CryptoState = { lastCheckedIso?: string; startPrice?: number };

function parsePriceArgs(raw: unknown): PriceArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.symbol !== "string" || typeof o.target !== "number") return null;
  return { symbol: o.symbol, target: o.target };
}

function parsePctArgs(raw: unknown): PctArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.symbol !== "string" ||
    typeof o.pct !== "number" ||
    (o.direction !== "up" && o.direction !== "down")
  )
    return null;
  return { symbol: o.symbol, pct: o.pct, direction: o.direction };
}

function parseState(raw: unknown): CryptoState {
  if (!raw || typeof raw !== "object") return {};
  return raw as CryptoState;
}

function isExpired(ctx: ResolverContext): boolean {
  if (!ctx.bet.expiresAt) return false;
  return ctx.now >= new Date(`${ctx.bet.expiresAt}Z`);
}

async function poll(
  ctx: ResolverContext,
  symbol: string,
): Promise<{ price: number | null; nextState: CryptoState }> {
  const state = parseState(ctx.state);
  if (!shouldPoll(state.lastCheckedIso, ctx.now)) {
    return { price: null, nextState: state };
  }
  const quote = await fetchCryptoPrice(symbol, ctx.fetch);
  const nextState: CryptoState = { ...state, lastCheckedIso: ctx.now.toISOString() };
  return { price: quote?.price ?? null, nextState };
}

// ── crypto:price-above ────────────────────────────────────────────────

register({
  kind: "crypto:price-above",
  describe: (raw) => {
    const args = parsePriceArgs(raw);
    if (!args) return "Auto-resolves on crypto price.";
    return `YES if ${args.symbol} trades above $${args.target.toLocaleString()} before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parsePriceArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };
    if (isExpired(ctx)) {
      return {
        kind: "resolve",
        outcome: "no",
        note: `Deadline passed — ${args.symbol} didn't clear $${args.target.toLocaleString()}.`,
      };
    }
    const { price, nextState } = await poll(ctx, args.symbol);
    if (price !== null && price > args.target) {
      return {
        kind: "resolve",
        outcome: "yes",
        note: `${args.symbol} at $${price.toLocaleString()} (> $${args.target.toLocaleString()}).`,
      };
    }
    return { kind: "pending", nextState };
  },
});

// ── crypto:price-below ────────────────────────────────────────────────

register({
  kind: "crypto:price-below",
  describe: (raw) => {
    const args = parsePriceArgs(raw);
    if (!args) return "Auto-resolves on crypto price.";
    return `YES if ${args.symbol} falls below $${args.target.toLocaleString()} before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parsePriceArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };
    if (isExpired(ctx)) {
      return {
        kind: "resolve",
        outcome: "no",
        note: `Deadline passed — ${args.symbol} stayed above $${args.target.toLocaleString()}.`,
      };
    }
    const { price, nextState } = await poll(ctx, args.symbol);
    if (price !== null && price < args.target) {
      return {
        kind: "resolve",
        outcome: "yes",
        note: `${args.symbol} at $${price.toLocaleString()} (< $${args.target.toLocaleString()}).`,
      };
    }
    return { kind: "pending", nextState };
  },
});

// ── crypto:pct-move ───────────────────────────────────────────────────

register({
  kind: "crypto:pct-move",
  describe: (raw) => {
    const args = parsePctArgs(raw);
    if (!args) return "Auto-resolves on crypto % move.";
    const dir = args.direction === "up" ? "up" : "down";
    return `YES if ${args.symbol} moves ${dir} ≥ ${args.pct}% before deadline; NO at deadline.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parsePctArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing args — refunded." };
    if (isExpired(ctx)) {
      return {
        kind: "resolve",
        outcome: "no",
        note: `Deadline passed — ${args.symbol} didn't move ${args.direction} ≥ ${args.pct}%.`,
      };
    }
    const { price, nextState } = await poll(ctx, args.symbol);
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
        note: `${args.symbol} ${sign}${pctChange.toFixed(2)}% from $${start.toLocaleString()}.`,
      };
    }
    return { kind: "pending", nextState };
  },
});
