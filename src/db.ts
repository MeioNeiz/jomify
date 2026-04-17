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

// Schema bootstrap — keeps existing DDL so the file-backed DB and in-memory
// test DB both provision on first use. Drizzle-kit migrations can replace
// this later without touching the rest of the app.
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
  CREATE TABLE IF NOT EXISTS linked_accounts (
    discord_id  TEXT PRIMARY KEY,
    steam_id    TEXT NOT NULL UNIQUE
  )
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
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id          TEXT PRIMARY KEY,
    notify_channel_id TEXT
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
    raw               TEXT NOT NULL,
    PRIMARY KEY (match_id, steam_id),
    FOREIGN KEY (match_id) REFERENCES matches(match_id)
  )
`);

// Post-install migrations for installs that predate newer columns.
for (const col of ["rounds_won", "rounds_lost", "premier_after"]) {
  try {
    sqlite.run(`ALTER TABLE match_stats ADD COLUMN ${col} INTEGER`);
  } catch {
    /* already exists */
  }
}
try {
  sqlite.run(`ALTER TABLE match_stats ADD COLUMN flash_score REAL`);
} catch {
  /* already exists */
}

// Backfill rounds_won/lost from the raw JSON blob. Existed before the
// dedicated columns so they're null for historical matches — restoring
// them unlocks /carry for pre-migration data without needing to refetch.
sqlite.run(`
  UPDATE match_stats
  SET rounds_won = CAST(json_extract(raw, '$.rounds_won') AS INTEGER)
  WHERE rounds_won IS NULL
    AND json_extract(raw, '$.rounds_won') IS NOT NULL
`);
sqlite.run(`
  UPDATE match_stats
  SET rounds_lost = CAST(json_extract(raw, '$.rounds_lost') AS INTEGER)
  WHERE rounds_lost IS NULL
    AND json_extract(raw, '$.rounds_lost') IS NOT NULL
`);

// Backfill flash_score from raw JSON so /flash's "best game" lookup
// works on historical data immediately. Formula matches the one in
// saveMatchDetails (see store/matches.ts).
sqlite.run(`
  UPDATE match_stats
  SET flash_score = (
    COALESCE(flashbang_hit_foe, 0)
      * COALESCE(CAST(json_extract(raw, '$.flashbang_hit_foe_avg_duration') AS REAL), 0)
    + 2 * COALESCE(CAST(json_extract(raw, '$.flashbang_leading_to_kill') AS REAL), 0)
    + COALESCE(CAST(json_extract(raw, '$.flash_assist') AS REAL), 0)
    - 2 * COALESCE(flashbang_hit_friend, 0)
  ) / NULLIF(rounds_count, 0)
  WHERE flash_score IS NULL AND rounds_count IS NOT NULL
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

const db = drizzle(sqlite, { schema });

export { sqlite };
export default db;
