// Polymarket mirror resolver. Fetches market state from the Gamma API
// (public, no key) and reflects its resolution onto our shekel market.
// Uses a hash of the upstream response in resolver_state to skip DB
// writes when nothing has changed — keeps the resolver_state quiet.
//
// Edge cases:
//   voided upstream → cancel + refund
//   resolution delayed (resolvedOutcome = 'Unresolved') → pending
//   404 / fetch error → stay pending, don't cancel on a blip
import type { ResolverContext, ResolverVerdict } from "./index.js";
import { register } from "./index.js";

const GAMMA_BASE = "https://gamma-api.polymarket.com/markets";

export type GammaMarket = {
  question?: string;
  closed?: boolean;
  archived?: boolean;
  resolvedOutcome?: string; // 'Yes' | 'No' | 'Unresolved' | null
  active?: boolean;
};

export async function fetchGammaMarket(
  slug: string,
  fetchFn: typeof fetch = fetch,
): Promise<GammaMarket | null> {
  try {
    const resp = await fetchFn(`${GAMMA_BASE}?slug=${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as GammaMarket[] | GammaMarket | null;
    if (Array.isArray(data)) return data[0] ?? null;
    return data;
  } catch {
    return null;
  }
}

type PolyArgs = { slug: string };
type PolyState = { lastHash?: string };

function parseArgs(raw: unknown): PolyArgs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== "string") return null;
  return { slug: o.slug };
}

function parseState(raw: unknown): PolyState {
  if (!raw || typeof raw !== "object") return {};
  return raw as PolyState;
}

function hashMarket(m: GammaMarket): string {
  return JSON.stringify({
    closed: m.closed,
    archived: m.archived,
    resolved: m.resolvedOutcome,
  });
}

register({
  kind: "external:polymarket",
  describe: (raw) => {
    const args = parseArgs(raw);
    if (!args) return "Mirrors a Polymarket market — their resolution flips ours.";
    return `Mirrors polymarket.com/event/${args.slug} — their resolution flips ours.`;
  },
  async check(ctx: ResolverContext): Promise<ResolverVerdict> {
    const args = parseArgs(ctx.args);
    if (!args) return { kind: "cancel", note: "Missing slug — refunded." };

    const state = parseState(ctx.state);
    const market = await fetchGammaMarket(args.slug, ctx.fetch);

    if (!market) {
      // Transient fetch failure — stay pending. Don't cancel on a blip.
      return { kind: "pending" };
    }

    const hash = hashMarket(market);
    if (hash === state.lastHash) {
      // Nothing changed upstream.
      return { kind: "pending" };
    }

    const nextState: PolyState = { lastHash: hash };

    // Voided upstream (archived without a resolved outcome) → cancel.
    if (market.archived && !market.resolvedOutcome) {
      return { kind: "cancel", note: "Polymarket voided this market — refunded." };
    }

    if (market.resolvedOutcome === "Yes") {
      return {
        kind: "resolve",
        outcome: "yes",
        note: `Polymarket resolved YES on ${args.slug}.`,
      };
    }
    if (market.resolvedOutcome === "No") {
      return {
        kind: "resolve",
        outcome: "no",
        note: `Polymarket resolved NO on ${args.slug}.`,
      };
    }

    // Unresolved, still active, or delayed → stay pending with updated state.
    return { kind: "pending", nextState };
  },
});
