import { Database } from "bun:sqlite";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.js";

const DB_PATH =
  process.env.JOMIFY_DB === ":memory:"
    ? ":memory:"
    : join(import.meta.dir, "..", "jomify.db");

const sqlite = new Database(DB_PATH, { create: true });
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

// Core-only DDL: linked_accounts (Discord↔Steam), guild_config, and
// the observability tables (metrics, errors, api_calls). CS-specific
// tables (tracked_players, matches, …) live in jomify-cs.db — see
// src/cs/db.ts. Betting has its own DB at jomify-betting.db.
sqlite.run(`
  CREATE TABLE IF NOT EXISTS linked_accounts (
    discord_id  TEXT PRIMARY KEY,
    steam_id    TEXT NOT NULL UNIQUE
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id          TEXT PRIMARY KEY,
    notify_channel_id TEXT
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS metrics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    command       TEXT NOT NULL,
    started_at    TEXT NOT NULL DEFAULT (datetime('now')),
    ttf_ms        INTEGER,
    ttl_ms        INTEGER,
    total_ms      INTEGER NOT NULL,
    api_calls     TEXT,
    options       TEXT,
    success       INTEGER NOT NULL,
    error_message TEXT,
    user_id       TEXT,
    guild_id      TEXT
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_metrics_command_started
    ON metrics (command, started_at)
`);
// Post-install migrations for columns added after initial rollout.
// Safe to run every start; each try swallows the usual "column already
// exists" error from SQLite.
for (const col of [
  "ALTER TABLE metrics ADD COLUMN options TEXT",
  "ALTER TABLE metrics ADD COLUMN cache_hit INTEGER",
  "ALTER TABLE guild_config ADD COLUMN activity_pings INTEGER NOT NULL DEFAULT 0",
]) {
  try {
    sqlite.run(col);
  } catch {
    /* already exists */
  }
}

sqlite.run(`
  CREATE TABLE IF NOT EXISTS errors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
    source      TEXT NOT NULL,
    level       TEXT NOT NULL,
    message     TEXT NOT NULL,
    stack       TEXT,
    extra       TEXT
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_errors_occurred
    ON errors (occurred_at)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS api_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at  TEXT NOT NULL DEFAULT (datetime('now')),
    endpoint     TEXT NOT NULL,
    duration_ms  INTEGER NOT NULL,
    status       INTEGER,
    retry_count  INTEGER NOT NULL DEFAULT 0
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_api_calls_occurred
    ON api_calls (occurred_at)
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_api_calls_endpoint
    ON api_calls (endpoint, occurred_at)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS command_registrations (
    scope         TEXT PRIMARY KEY,
    hash          TEXT NOT NULL,
    count         INTEGER NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const db = drizzle(sqlite, { schema });

export { sqlite };
export default db;
