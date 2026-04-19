import log from "../logger.js";
import { getMatchDetails, getProfile } from "./leetify/client.js";
import { isMatchProcessed, markMatchProcessed, saveMatchDetails } from "./store.js";

/**
 * Fetch a player's profile + any new matches and persist them. Mirrors the
 * watcher's per-player scan, but without the alert side effects, so commands
 * can trigger it on demand.
 */
async function refreshPlayer(steamId: string): Promise<void> {
  const profile = await getProfile(steamId); // write-through saves snapshot
  for (const m of profile.recent_matches ?? []) {
    if (isMatchProcessed(m.id, steamId)) continue;
    markMatchProcessed(m.id, steamId, m.finished_at);
    try {
      const details = await getMatchDetails(m.id);
      saveMatchDetails(details);
    } catch (err) {
      log.warn({ matchId: m.id, err }, "refreshPlayer: failed to fetch match");
    }
  }
}

/** Refresh many players in parallel. Rejects only if *all* fail. */
export async function refreshPlayers(steamIds: string[]): Promise<void> {
  if (!steamIds.length) return;
  const results = await Promise.allSettled(steamIds.map(refreshPlayer));
  const allFailed = results.every((r) => r.status === "rejected");
  if (allFailed) {
    const first = results[0];
    if (first?.status === "rejected") throw first.reason;
  }
}
