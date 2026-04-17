#!/usr/bin/env bun
// One-shot: for every tracked player, pull full match history from
// Leetify and save any match_stats rows we're missing. Fixes the
// fallout from the pre-fix watcher that marked matches "processed"
// before (and sometimes instead of) actually saving their details.
//
// Safe to re-run — saveMatchDetails is onConflictDoNothing.
import { getMatchHistory, LeetifyNotFoundError } from "../src/leetify/client.js";
import {
  getAllTrackedSteamIds,
  hasMatchStats,
  isLeetifyUnknown,
  saveMatchDetails,
} from "../src/store.js";

const MIN_GAP_MS = 500;
const ids = getAllTrackedSteamIds();
console.log(`Repairing ${ids.length} tracked players...`);

for (const id of ids) {
  if (isLeetifyUnknown(id)) {
    console.log(`  ${id} — skipped (not on Leetify)`);
    continue;
  }
  try {
    const matches = await getMatchHistory(id);
    let saved = 0;
    for (const m of matches) {
      if (hasMatchStats(m.id, id)) continue;
      saveMatchDetails(m);
      saved++;
    }
    console.log(`  ${id} — ${saved} saved / ${matches.length} total`);
  } catch (err) {
    if (err instanceof LeetifyNotFoundError) {
      console.log(`  ${id} — 404 (marked unknown)`);
      continue;
    }
    console.log(`  ${id} — error: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((r) => setTimeout(r, MIN_GAP_MS));
}
console.log("done");
