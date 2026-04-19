// Auto-resolver registry.
//
// Each resolver lives in its own file under src/betting/resolvers/ and
// self-registers at import time (same pattern as registerComponent).
// The poller in ./watcher.ts walks every open market with a
// resolver_kind and feeds it through the registered resolver's check().
//
// Resolvers are pure over their ResolverContext: given the bet + now +
// fetch, they return a verdict. Mutations (balance payouts, message
// refresh) are the poller's job — keep the resolvers testable.
import type { Bet } from "../store.js";

export type ResolverVerdict =
  | {
      kind: "pending";
      // Optional scratchpad update persisted via setResolverState.
      // Omit to leave the existing state untouched.
      nextState?: unknown;
    }
  | {
      kind: "resolve";
      outcome: "yes" | "no";
      // Short human note — surfaced on the resolved embed.
      note?: string;
    }
  | {
      kind: "cancel";
      note?: string;
    };

export type ResolverContext = {
  bet: Bet;
  // Pre-parsed resolver_args / resolver_state. Resolvers that need a
  // strict shape should narrow inside `check`.
  args: unknown;
  state: unknown;
  now: Date;
  // Injected so tests can mock upstream HTTP without monkey-patching
  // globalThis.fetch.
  fetch: typeof fetch;
};

export type Resolver = {
  kind: string;
  check: (ctx: ResolverContext) => Promise<ResolverVerdict>;
  // Optional: render a one-line preview shown on the market embed.
  describe?: (args: unknown) => string;
};

const registry = new Map<string, Resolver>();

export function register(resolver: Resolver): void {
  if (registry.has(resolver.kind)) {
    throw new Error(`Resolver '${resolver.kind}' is already registered`);
  }
  registry.set(resolver.kind, resolver);
}

export function lookup(kind: string): Resolver | null {
  return registry.get(kind) ?? null;
}
