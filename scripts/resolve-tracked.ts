#!/usr/bin/env bun
// One-shot: walks tracked_players for any row whose steam_id isn't a
// valid Steam64, resolves it via Steam's vanity URL API, and rewrites
// the row. Run once after landing vanity-URL resolution in /track.
//
// Usage: bun scripts/resolve-tracked.ts [--dry]
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { resolveSteamId } from "../src/steam/client.js";

const DRY = process.argv.includes("--dry");
const DB = join(import.meta.dir, "..", "jomify.db");
const db = new Database(DB);

const STEAM64_RE = /^7656119\d{10}$/;

type Row = { guild_id: string; steam_id: string };

const rows = db
  .query<Row, []>(
    "SELECT guild_id, steam_id FROM tracked_players ORDER BY guild_id, steam_id",
  )
  .all();

const stale = rows.filter((r) => !STEAM64_RE.test(r.steam_id));
console.log(`${rows.length} total rows, ${stale.length} need resolution`);

for (const row of stale) {
  const result = await resolveSteamId(row.steam_id);
  if (!result.ok) {
    console.log(`  ✗ ${row.steam_id} (${row.guild_id}): ${result.reason}`);
    continue;
  }
  const newId = result.steamId;
  console.log(`  ✓ ${row.steam_id} -> ${newId} (${row.guild_id})`);

  if (DRY) continue;

  // If the resolved id is already tracked in this guild, just drop the
  // stale row. Otherwise rewrite it in place.
  const clash = db
    .query<{ c: number }, [string, string]>(
      "SELECT COUNT(*) AS c FROM tracked_players WHERE guild_id = ? AND steam_id = ?",
    )
    .get(row.guild_id, newId);
  if (clash && clash.c > 0) {
    db.run("DELETE FROM tracked_players WHERE guild_id = ? AND steam_id = ?", [
      row.guild_id,
      row.steam_id,
    ]);
    console.log(`    (dropped duplicate; ${newId} was already tracked)`);
  } else {
    db.run(
      "UPDATE tracked_players SET steam_id = ? WHERE guild_id = ? AND steam_id = ?",
      [newId, row.guild_id, row.steam_id],
    );
  }
}

console.log(DRY ? "(dry run — no writes)" : "done");
