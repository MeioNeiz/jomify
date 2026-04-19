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

const sqlite = new Database(DB_PATH, { create: true });
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

sqlite.run(`
  CREATE TABLE IF NOT EXISTS accounts (
    steam_id   TEXT PRIMARY KEY,
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
    resolved_at        TEXT
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_bets_guild_status
    ON bets (guild_id, status)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS wagers (
    bet_id     INTEGER NOT NULL REFERENCES bets(id),
    steam_id   TEXT NOT NULL,
    outcome    TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    placed_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (bet_id, steam_id)
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_wagers_bet ON wagers (bet_id)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS ledger (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    steam_id  TEXT NOT NULL,
    delta     INTEGER NOT NULL,
    reason    TEXT NOT NULL,
    ref       TEXT,
    at        TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_ledger_steam_at
    ON ledger (steam_id, at)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS weekly_wins (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_ending      TEXT NOT NULL,
    steam_id         TEXT NOT NULL,
    rank             INTEGER NOT NULL,
    balance_snapshot INTEGER NOT NULL
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_weekly_wins_week
    ON weekly_wins (week_ending)
`);

const db = drizzle(sqlite, { schema });

export default db;
