#!/usr/bin/env bun
// One-shot: rebuild match_stats with the full 10-player rows per match.
//
// The original repair only called /v3/profile/matches, which returns
// an abbreviated stats array (the target's team only — 3-5 entries).
// That left /suspects with no opponent data. This script walks every
// known match for every tracked player and re-fetches via the
// /v2/matches/{id} endpoint, which returns all 10 stats entries.
//
// Only matches with fewer than 10 existing rows get re-fetched, so
// re-runs are cheap after the first full sweep.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  getMatchDetails,
  getMatchHistory,
  LeetifyNotFoundError,
} from "../src/cs/leetify/client.js";
import {
  getAllTrackedSteamIds,
  isLeetifyUnknown,
  saveMatchDetails,
} from "../src/cs/store.js";

const MIN_GAP_MS = 200;
const DB = join(import.meta.dir, "..", "jomify-cs.db");
const rawDb = new Database(DB, { readonly: true });

function playerCount(matchId: string): number {
  const row = rawDb
    .query<{ c: number }, [string]>(
      "SELECT COUNT(*) AS c FROM match_stats WHERE match_id = ?",
    )
    .get(matchId);
  return row?.c ?? 0;
}

const ids = getAllTrackedSteamIds();
console.log(`Repairing ${ids.length} tracked players...`);

let totalRefetched = 0;
let totalSkipped = 0;
let totalErrored = 0;

for (const id of ids) {
  if (isLeetifyUnknown(id)) {
    console.log(`  ${id} — skipped (not on Leetify)`);
    continue;
  }
  let history: Awaited<ReturnType<typeof getMatchHistory>>;
  try {
    history = await getMatchHistory(id);
  } catch (err) {
    if (err instanceof LeetifyNotFoundError) {
      console.log(`  ${id} — 404 (marked unknown)`);
      continue;
    }
    console.log(`  ${id} — history error: ${err instanceof Error ? err.message : err}`);
    continue;
  }

  let refetched = 0;
  let skipped = 0;
  let errored = 0;
  for (const match of history) {
    if (playerCount(match.id) >= 10) {
      skipped++;
      continue;
    }
    try {
      const full = await getMatchDetails(match.id);
      saveMatchDetails(full);
      refetched++;
    } catch (err) {
      errored++;
      if (!(err instanceof LeetifyNotFoundError)) {
        console.log(`    ${match.id} error: ${err instanceof Error ? err.message : err}`);
      }
    }
    await new Promise((r) => setTimeout(r, MIN_GAP_MS));
  }
  totalRefetched += refetched;
  totalSkipped += skipped;
  totalErrored += errored;
  console.log(
    `  ${id} — refetched ${refetched} / skipped ${skipped} (already complete) / errored ${errored}`,
  );
}

console.log(
  `done — refetched ${totalRefetched}, skipped ${totalSkipped}, errored ${totalErrored}`,
);
