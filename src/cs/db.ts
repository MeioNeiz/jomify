import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.js";

// Separate DB file on purpose: keeps CS's backup + Datasette surfaces
// independent of the core DB (linked_accounts, metrics, errors) and
// betting. Tests share the same in-memory flag as the other DBs.
const DB_PATH =
  process.env.JOMIFY_DB === ":memory:"
    ? ":memory:"
    : join(import.meta.dir, "..", "..", "jomify-cs.db");

const MAIN_DB_PATH =
  process.env.JOMIFY_DB === ":memory:"
    ? ":memory:"
    : join(import.meta.dir, "..", "..", "jomify.db");

const sqlite = new Database(DB_PATH, { create: true });
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

sqlite.run(`
  CREATE TABLE IF NOT EXISTS tracked_players (
    guild_id  TEXT NOT NULL,
    steam_id  TEXT NOT NULL,
    added_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (guild_id, steam_id)
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_tracked_players_steam
    ON tracked_players (steam_id)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    steam_id      TEXT NOT NULL,
    name          TEXT NOT NULL,
    premier       INTEGER,
    leetify       REAL,
    aim           REAL,
    positioning   REAL,
    utility       REAL,
    clutch        REAL,
    recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_snapshots_steam
    ON snapshots (steam_id, recorded_at)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS processed_matches (
    match_id    TEXT NOT NULL,
    steam_id    TEXT NOT NULL,
    finished_at TEXT,
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (match_id, steam_id)
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
    guild_id    TEXT NOT NULL,
    steam_id    TEXT NOT NULL,
    premier     INTEGER,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (guild_id, steam_id, recorded_at)
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_leaderboard_guild
    ON leaderboard_snapshots (guild_id, recorded_at)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS matches (
    match_id        TEXT PRIMARY KEY,
    finished_at     TEXT NOT NULL,
    data_source     TEXT,
    data_source_match_id TEXT,
    map_name        TEXT NOT NULL,
    team1_score     INTEGER,
    team2_score     INTEGER,
    has_banned_player BOOLEAN DEFAULT 0,
    replay_url      TEXT
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS match_stats (
    match_id          TEXT NOT NULL,
    steam_id          TEXT NOT NULL,
    name              TEXT,
    team_number       INTEGER,
    total_kills       INTEGER,
    total_deaths      INTEGER,
    total_assists     INTEGER,
    kd_ratio          REAL,
    dpr               REAL,
    total_damage      INTEGER,
    leetify_rating    REAL,
    ct_leetify_rating REAL,
    t_leetify_rating  REAL,
    accuracy_head     REAL,
    spray_accuracy    REAL,
    flashbang_hit_friend INTEGER,
    flashbang_hit_foe    INTEGER,
    flashbang_thrown   INTEGER,
    multi3k           INTEGER,
    multi4k           INTEGER,
    multi5k           INTEGER,
    rounds_count      INTEGER,
    rounds_won        INTEGER,
    rounds_lost       INTEGER,
    premier_after     INTEGER,
    flash_score       REAL,
    raw               TEXT NOT NULL,
    PRIMARY KEY (match_id, steam_id),
    FOREIGN KEY (match_id) REFERENCES matches(match_id)
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_match_stats_steam
    ON match_stats (steam_id)
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_matches_finished
    ON matches (finished_at)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS api_usage (
    endpoint    TEXT NOT NULL,
    day         TEXT NOT NULL DEFAULT (date('now')),
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (endpoint, day)
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS analysed_opponents (
    match_id  TEXT NOT NULL,
    steam_id  TEXT NOT NULL,
    PRIMARY KEY (match_id, steam_id)
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS player_streaks (
    steam_id          TEXT PRIMARY KEY,
    streak_type       TEXT NOT NULL DEFAULT 'win',
    streak_count      INTEGER NOT NULL DEFAULT 0,
    last_alerted_count INTEGER NOT NULL DEFAULT 0,
    updated_at        TEXT NOT NULL
      DEFAULT (datetime('now'))
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS guild_win_streak_records (
    guild_id        TEXT PRIMARY KEY,
    record_count    INTEGER NOT NULL DEFAULT 0,
    holder_steam_id TEXT,
    set_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS leetify_unknown (
    steam_id     TEXT PRIMARY KEY,
    first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const CS_TABLES = [
  "tracked_players",
  "snapshots",
  "processed_matches",
  "leaderboard_snapshots",
  "matches",
  "match_stats",
  "api_usage",
  "analysed_opponents",
  "player_streaks",
  "leetify_unknown",
];

// One-shot copy of CS tables from the pre-split core DB. Runs only when
// jomify-cs.db is empty and jomify.db exists — so a fresh install, a
// re-run after success, or tests all skip it. Leaves the source rows
// in jomify.db for manual clean-up (belt-and-braces in case the copy
// goes wrong).
function migrateFromMainDb(sql: Database): void {
  if (MAIN_DB_PATH === ":memory:") return;
  if (!existsSync(MAIN_DB_PATH)) return;
  // Bail early if any CS table here already has rows — we assume the
  // migration ran on a prior boot.
  for (const t of CS_TABLES) {
    const row = sql.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${t}`).get();
    if ((row?.c ?? 0) > 0) return;
  }
  sql.run(`ATTACH DATABASE '${MAIN_DB_PATH.replaceAll("'", "''")}' AS main_db`);
  try {
    sql.transaction(() => {
      for (const t of CS_TABLES) {
        const mainRow = sql
          .query<{ name: string }, [string]>(
            "SELECT name FROM main_db.sqlite_master WHERE type='table' AND name = ?",
          )
          .get(t);
        if (!mainRow) continue;
        sql.run(`INSERT INTO ${t} SELECT * FROM main_db.${t}`);
      }
    })();
  } finally {
    sql.run("DETACH DATABASE main_db");
  }
}

migrateFromMainDb(sqlite);

const db = drizzle(sqlite, { schema });

export { sqlite };
export default db;
