#!/usr/bin/env bun
// One-shot: sweeps every table that stores steam_ids from user input
// (linked_accounts, tracked_players) and resolves any remaining vanity
// handles to their steam64s. Idempotent; rows already in steam64 form
// are skipped.
//
// Replaces the earlier resolve-tracked.ts, which only walked
// tracked_players and missed linked_accounts — that omission was the
// root cause of /carry and /suspects returning empty for users whose
// linked_accounts row held a literal vanity string.
//
// Usage: bun scripts/resolve-vanity.ts [--dry]
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { resolveSteamId } from "../src/cs/steam/client.js";

const DRY = process.argv.includes("--dry");
// linked_accounts lives in the core DB; tracked_players in the CS DB.
const db = new Database(join(import.meta.dir, "..", "jomify.db"));
const csDb = new Database(join(import.meta.dir, "..", "jomify-cs.db"));

const STEAM64_RE = /^7656119\d{10}$/;

async function resolveOne(handle: string): Promise<string | null> {
  const result = await resolveSteamId(handle);
  return result.ok ? result.steamId : null;
}

async function sweepLinkedAccounts() {
  const rows = db
    .query<{ discord_id: string; steam_id: string }, []>(
      "SELECT discord_id, steam_id FROM linked_accounts",
    )
    .all();
  const stale = rows.filter((r) => !STEAM64_RE.test(r.steam_id));
  console.log(`linked_accounts: ${rows.length} rows, ${stale.length} need resolution`);

  for (const row of stale) {
    const resolved = await resolveOne(row.steam_id);
    if (!resolved) {
      console.log(`  ✗ ${row.steam_id} — unresolvable`);
      continue;
    }
    console.log(`  ✓ ${row.steam_id} -> ${resolved}`);
    if (DRY) continue;
    // UNIQUE constraint on steam_id — drop the vanity row if the
    // resolved id is already linked to a (possibly different) discord.
    const clash = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM linked_accounts WHERE steam_id = ?",
      )
      .get(resolved);
    if (clash && clash.c > 0) {
      db.run("DELETE FROM linked_accounts WHERE steam_id = ?", [row.steam_id]);
      console.log(`    (dropped duplicate; ${resolved} was already linked)`);
    } else {
      db.run("UPDATE linked_accounts SET steam_id = ? WHERE steam_id = ?", [
        resolved,
        row.steam_id,
      ]);
    }
  }
}

async function sweepTrackedPlayers() {
  const rows = csDb
    .query<{ guild_id: string; steam_id: string }, []>(
      "SELECT guild_id, steam_id FROM tracked_players ORDER BY guild_id, steam_id",
    )
    .all();
  const stale = rows.filter((r) => !STEAM64_RE.test(r.steam_id));
  console.log(`tracked_players: ${rows.length} rows, ${stale.length} need resolution`);

  for (const row of stale) {
    const resolved = await resolveOne(row.steam_id);
    if (!resolved) {
      console.log(`  ✗ ${row.steam_id} (${row.guild_id}) — unresolvable`);
      continue;
    }
    console.log(`  ✓ ${row.steam_id} -> ${resolved} (${row.guild_id})`);
    if (DRY) continue;
    const clash = csDb
      .query<{ c: number }, [string, string]>(
        "SELECT COUNT(*) AS c FROM tracked_players WHERE guild_id = ? AND steam_id = ?",
      )
      .get(row.guild_id, resolved);
    if (clash && clash.c > 0) {
      csDb.run("DELETE FROM tracked_players WHERE guild_id = ? AND steam_id = ?", [
        row.guild_id,
        row.steam_id,
      ]);
      console.log(`    (dropped duplicate; ${resolved} was already tracked)`);
    } else {
      csDb.run(
        "UPDATE tracked_players SET steam_id = ? WHERE guild_id = ? AND steam_id = ?",
        [resolved, row.guild_id, row.steam_id],
      );
    }
  }
}

await sweepLinkedAccounts();
await sweepTrackedPlayers();
console.log(DRY ? "(dry run — no writes)" : "done");
