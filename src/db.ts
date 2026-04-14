import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "..", "jomify.db");

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

db.run(`
  CREATE TABLE IF NOT EXISTS tracked_players (
    guild_id  TEXT NOT NULL,
    steam_id  TEXT NOT NULL,
    added_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (guild_id, steam_id)
  )
`);

db.run(`
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

db.run(`
  CREATE INDEX IF NOT EXISTS idx_snapshots_steam
    ON snapshots (steam_id, recorded_at)
`);

// Link Discord users to Steam IDs
db.run(`
  CREATE TABLE IF NOT EXISTS linked_accounts (
    discord_id  TEXT PRIMARY KEY,
    steam_id    TEXT NOT NULL UNIQUE
  )
`);

// Track which matches we've already seen
db.run(`
  CREATE TABLE IF NOT EXISTS processed_matches (
    match_id    TEXT NOT NULL,
    steam_id    TEXT NOT NULL,
    finished_at TEXT,
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (match_id, steam_id)
  )
`);

// Per-guild config (notification channel, etc.)
db.run(`
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id          TEXT PRIMARY KEY,
    notify_channel_id TEXT
  )
`);

// Leaderboard snapshots for tracking changes
db.run(`
  CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
    guild_id    TEXT NOT NULL,
    steam_id    TEXT NOT NULL,
    premier     INTEGER,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (guild_id, steam_id, recorded_at)
  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_leaderboard_guild
    ON leaderboard_snapshots (guild_id, recorded_at)
`);

// Match metadata
db.run(`
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

// Per-player match stats (full data as JSON + key
// columns for fast queries)
db.run(`
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
    raw               TEXT NOT NULL,
    PRIMARY KEY (match_id, steam_id),
    FOREIGN KEY (match_id) REFERENCES matches(match_id)
  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_match_stats_steam
    ON match_stats (steam_id)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_matches_finished
    ON matches (finished_at)
`);

export default db;
