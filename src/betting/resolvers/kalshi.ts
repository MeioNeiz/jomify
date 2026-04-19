// Kalshi mirror resolver. Fetches market state from the Kalshi API
// (requires KALSHI_API_KEY env var). Maps their market status onto
// our shekel market — YES/NO/Cancel follow the same pattern as the
// Polymarket mirror.
import { config } from "../../config.js";
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

type KalshiMarket = {
  status?: string; // 'open' | 'closed' | 'settled' | 'finalized' | 'determined'
  result?: string; // 'yes' | 'no' | '' (empty when not yet settled)
  title?: string;
};

async function fetchKalshiMarket(
  ticker: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<KalshiMarket | null> {
  try {
    const resp = await fetchFn(
      `https://trading-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
      {
        headers: { Authorization: `Token ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { market?: KalshiMarket };
    return data.market ?? null;
  } catch {
    return null;
  }
}

type KalshiArgs = { ticker: string };
type KalshiState = { lastHash?: string };

function parseArgs(raw: unknown): KalshiArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ticker !== "string") return null;
  return { ticker: o.ticker };
}

function parseState(raw: unknown): KalshiState {
  if (!raw || typeof raw !== "object") return {};
  return raw as KalshiState;
}

register({
  kind: "external:kalshi",
  describe: (raw) => {
    const args = parseArgs(raw);
    if (!args) return "Mirrors a Kalshi market — their resolution flips ours.";
    return `Mirrors Kalshi market ${args.ticker} — their resolution flips ours.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parseArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing ticker — refunded." };

    const apiKey = config.kalshiApiKey;
    if (!apiKey) {
      // No key configured — market stays pending. Operator must add
      // KALSHI_API_KEY or manually resolve via dispute flow.
      return { kind: "pending" };
    }

    const state = parseState(ctx.state);
    const market = await fetchKalshiMarket(args.ticker, apiKey, ctx.fetch);
    if (!market) return { kind: "pending" };

    const hash = JSON.stringify({ status: market.status, result: market.result });
    if (hash === state.lastHash) return { kind: "pending" };

    const nextState: KalshiState = { lastHash: hash };

    if (market.status === "finalized" || market.status === "settled") {
      if (market.result === "yes") {
        return {
          kind: "resolve",
          outcome: "yes",
          note: `Kalshi resolved YES on ${args.ticker}.`,
        };
      }
      if (market.result === "no") {
        return {
          kind: "resolve",
          outcome: "no",
          note: `Kalshi resolved NO on ${args.ticker}.`,
        };
      }
      // Settled with no result → voided.
      return { kind: "cancel", note: `Kalshi voided ${args.ticker} — refunded.` };
    }

    return { kind: "pending", nextState };
  },
});
