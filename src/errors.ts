// Structured error capture. logError always prints to pino (so live
// journalctl tailing still works) AND writes a durable row to the
// `errors` table — future investigations can query via Datasette or
// `scripts/db.ts` without scrolling journald.
//
// Call this instead of `log.warn` / `log.error` for anything you'd
// want to find later. Keep pino for ephemeral breadcrumbs
// (log.debug/info).
import log from "./logger.js";
import { saveError } from "./store.js";

export function logError(
  source: string,
  err: unknown,
  extra?: Record<string, unknown>,
  level: "warn" | "error" = "error",
): void {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  const stack = err instanceof Error ? (err.stack ?? null) : null;

  // Keep the pino side unchanged — journald remains the primary live
  // feed; the DB row is the retrospective index.
  if (level === "error") log.error({ source, err, ...extra }, message);
  else log.warn({ source, err, ...extra }, message);

  try {
    saveError({
      source,
      level,
      message,
      stack,
      extra: extra ? JSON.stringify(extra) : null,
    });
  } catch (persistErr) {
    // Never let the error-logger itself take out the caller. Falling
    // back to pino means we at least see the failure live.
    log.warn({ persistErr }, "Failed to persist error row");
  }
}
