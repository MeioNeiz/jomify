// Framework-level typed event bus.
//
// Synchronous in-memory dispatch: listeners run on the emit stack, so
// stack traces flow through emit() into handlers like any normal call.
// Errors are caught per-listener and written to the errors table via
// logError, so one bad handler can't take down the emitter or hide the
// others. If we ever split the bot into multiple processes, swap this
// file's internals for a networked dispatcher; call sites don't change.
import { logError } from "./errors.js";

export type EventMap = {
  "cs:match-completed": {
    matchId: string;
    steamId: string;
    discordId: string | null;
    // Per-match Leetify rating (tiny signed decimal like +0.08 / -0.05),
    // not the 0-100 overall rating on the profile.
    rating: number;
    outcome: "win" | "loss" | "tie";
    // Signed Premier delta for this match, or null if pre-match Premier
    // was unknown (first match since boot, or unranked player).
    premierDelta: number | null;
    // Other tracked players on the emitter's team in this match.
    trackedTeammates: string[];
    mapName: string;
    finishedAt: string;
    // Raw per-match stats CS callers might need for their own rules
    // (e.g. betting penalty computation). Null when match details
    // weren't available at emit time; subscribers must tolerate it.
    stats: {
      flashbangHitFriend: number;
      heFriendsDamageAvg: number;
      shotsHitFriend: number;
      shotsHitFriendHead: number;
      // Current streak after this match. Type is "win" | "loss" | "tie",
      // count is how many in a row (1 after a single win). Zero-count
      // means no active streak (tie resets streakCount to 0).
      streakType: "win" | "loss" | "tie";
      streakCount: number;
    } | null;
  };
};

// Storage is erased to unknown so the internal dispatch loop doesn't
// fight TS's mapped-type variance. `on`/`emit` keep the generic
// signatures at the API boundary, so callers still get full
// type-checking on event names and payloads.
type AnyListener = (payload: unknown) => void;
const listeners = new Map<keyof EventMap, AnyListener[]>();

export function on<K extends keyof EventMap>(
  key: K,
  handler: (payload: EventMap[K]) => void,
): void {
  const arr = listeners.get(key) ?? [];
  arr.push(handler as AnyListener);
  listeners.set(key, arr);
}

export function emit<K extends keyof EventMap>(key: K, payload: EventMap[K]): void {
  const hs = listeners.get(key);
  if (!hs) return;
  for (const h of hs) {
    try {
      h(payload);
    } catch (err) {
      logError(`event:${key}`, err, { payload });
    }
  }
}
