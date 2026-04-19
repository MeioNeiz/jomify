import { Database } from "bun:sqlite";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.js";

// Separate DB file on purpose: keeps betting's backup + Datasette
// surfaces independent of the CS DB, and means a bad migration on one
// side can't corrupt the other. Tests share the same in-memory flag
// as the main DB so both modules are purged between test runs.
const DB_PATH =
  process.env.JOMIFY_DB === ":memory:"
    ? ":memory:"
    : join(import.meta.dir, "..", "..", "jomify-betting.db");

const MAIN_DB_PATH =
  process.env.JOMIFY_DB === ":memory:"
    ? ":memory:"
    : join(import.meta.dir, "..", "..", "jomify.db");

const sqlite = new Database(DB_PATH, { create: true });
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

// One-shot rekey from steam_id → discord_id. Any row whose steam_id
// has no matching linked_accounts entry gets dropped (no Discord user
// to attribute the wallet to). Safe to run on a fresh DB — the gate
// checks for the old column before doing anything.
rekeyToDiscord(sqlite);

sqlite.run(`
  CREATE TABLE IF NOT EXISTS accounts (
    discord_id TEXT PRIMARY KEY,
    balance    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS bets (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id           TEXT NOT NULL,
    question           TEXT NOT NULL,
    creator_discord_id TEXT NOT NULL,
    status             TEXT NOT NULL,
    winning_outcome    TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at        TEXT,
    expires_at         TEXT,
    channel_id         TEXT,
    message_id         TEXT
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_bets_guild_status
    ON bets (guild_id, status)
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_bets_expires
    ON bets (expires_at)
`);
// Post-install migrations for installs that predate the auto-expiry
// columns. Each try swallows the usual "column already exists" error.
for (const col of [
  "ALTER TABLE bets ADD COLUMN expires_at TEXT",
  "ALTER TABLE bets ADD COLUMN channel_id TEXT",
  "ALTER TABLE bets ADD COLUMN message_id TEXT",
]) {
  try {
    sqlite.run(col);
  } catch {
    /* already exists */
  }
}
sqlite.run(`
  CREATE TABLE IF NOT EXISTS wagers (
    bet_id     INTEGER NOT NULL REFERENCES bets(id),
    discord_id TEXT NOT NULL,
    outcome    TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    placed_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (bet_id, discord_id)
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_wagers_bet ON wagers (bet_id)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    delta      INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    ref        TEXT,
    at         TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_ledger_discord_at
    ON ledger (discord_id, at)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS weekly_wins (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_ending      TEXT NOT NULL,
    discord_id       TEXT NOT NULL,
    rank             INTEGER NOT NULL,
    balance_snapshot INTEGER NOT NULL
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_weekly_wins_week
    ON weekly_wins (week_ending)
`);

function hasColumn(sql: Database, table: string, column: string): boolean {
  const rows = sql.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function tableExists(sql: Database, table: string): boolean {
  const row = sql
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(table);
  return !!row;
}

function rekeyToDiscord(sql: Database): void {
  // Only fire if any of the four tables still carries the old column.
  // A fresh DB hasn't created the tables yet — nothing to migrate.
  const targets = ["accounts", "ledger", "wagers", "weekly_wins"].filter(
    (t) => tableExists(sql, t) && hasColumn(sql, t, "steam_id"),
  );
  if (!targets.length) return;
  if (MAIN_DB_PATH === ":memory:") {
    // Tests provision fresh DBs every run, so there's never an old
    // shape to translate. Guard against accidentally ATTACHing a
    // memory handle we can't address.
    return;
  }
  sql.run(`ATTACH DATABASE '${MAIN_DB_PATH.replaceAll("'", "''")}' AS main_db`);
  try {
    sql.transaction(() => {
      for (const t of targets) {
        // Drop rows whose steam_id never linked — we can't attribute a
        // wallet, ledger entry, wager, or weekly win to anyone without
        // a Discord id.
        sql.run(`
          DELETE FROM ${t} WHERE NOT EXISTS (
            SELECT 1 FROM main_db.linked_accounts la WHERE la.steam_id = ${t}.steam_id
          )
        `);
        // Translate in place. linked_accounts.steam_id is UNIQUE so
        // the subquery is always single-valued.
        sql.run(`
          UPDATE ${t} SET steam_id = (
            SELECT la.discord_id FROM main_db.linked_accounts la
            WHERE la.steam_id = ${t}.steam_id
          )
        `);
        sql.run(`ALTER TABLE ${t} RENAME COLUMN steam_id TO discord_id`);
      }
    })();
  } finally {
    sql.run("DETACH DATABASE main_db");
  }
}

const db = drizzle(sqlite, { schema });

export default db;
