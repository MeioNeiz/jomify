import { AsyncLocalStorage } from "node:async_hooks";
import log from "./logger.js";
import { saveMetric } from "./store/metrics.js";

/**
 * Per-invocation metrics state. Mutated throughout a command's lifecycle
 * by bumpApiCall / markFirstReply / markLastReply; persisted by
 * runWithMetrics once the command resolves (or throws).
 */
export type Collector = {
  command: string;
  userId?: string;
  guildId?: string;
  /** JSON snapshot of interaction options — subcommand + option values. */
  options?: string;
  startedAtIso: string;
  startMs: number;
  apiCalls: Record<string, number>;
  firstReplyAt: number | null;
  lastReplyAt: number | null;
};

const storage = new AsyncLocalStorage<Collector>();

/** No-op when called outside an active runWithMetrics scope. */
export function bumpApiCall(endpoint: string): void {
  const c = storage.getStore();
  if (!c) return;
  c.apiCalls[endpoint] = (c.apiCalls[endpoint] ?? 0) + 1;
}

/** Sticky: first caller wins, later calls are ignored. */
export function markFirstReply(): void {
  const c = storage.getStore();
  if (!c) return;
  if (c.firstReplyAt == null) c.firstReplyAt = Date.now();
}

/** Moves on every call — tracks the most recent editReply. */
export function markLastReply(): void {
  const c = storage.getStore();
  if (!c) return;
  c.lastReplyAt = Date.now();
}

export async function runWithMetrics<T>(
  opts: { command: string; userId?: string; guildId?: string; options?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const collector: Collector = {
    command: opts.command,
    userId: opts.userId,
    guildId: opts.guildId,
    options: opts.options,
    startedAtIso: new Date().toISOString(),
    startMs: Date.now(),
    apiCalls: {},
    firstReplyAt: null,
    lastReplyAt: null,
  };

  try {
    const result = await storage.run(collector, fn);
    persist(collector, { success: true });
    return result;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    persist(collector, { success: false, errorMessage: message });
    throw err;
  }
}

function persist(
  c: Collector,
  outcome: { success: boolean; errorMessage?: string },
): void {
  const totalMs = Date.now() - c.startMs;
  const ttfMs = c.firstReplyAt != null ? c.firstReplyAt - c.startMs : null;
  const ttlMs =
    c.firstReplyAt != null && c.lastReplyAt != null && c.lastReplyAt > c.firstReplyAt
      ? c.lastReplyAt - c.firstReplyAt
      : null;
  const apiCallsJson = Object.keys(c.apiCalls).length ? JSON.stringify(c.apiCalls) : null;

  try {
    saveMetric({
      command: c.command,
      startedAt: c.startedAtIso,
      ttfMs,
      ttlMs,
      totalMs,
      apiCalls: apiCallsJson,
      options: c.options ?? null,
      success: outcome.success ? 1 : 0,
      errorMessage: outcome.errorMessage ?? null,
      userId: c.userId ?? null,
      guildId: c.guildId ?? null,
    });
  } catch (err) {
    log.warn({ err, cmd: c.command }, "Failed to persist metrics row");
  }
}
