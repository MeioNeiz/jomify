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

// Migrate accounts to per-guild composite PK. Runs before CREATE TABLE
// so old DBs get the new shape; fresh DBs skip (table doesn't exist).
if (tableExists(sqlite, "accounts") && !hasColumn(sqlite, "accounts", "guild_id")) {
  sqlite.run(`ALTER TABLE accounts RENAME TO accounts_legacy`);
  sqlite.run(`
    CREATE TABLE accounts (
      discord_id TEXT NOT NULL,
      guild_id   TEXT NOT NULL DEFAULT '',
      balance    INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (discord_id, guild_id)
    )
  `);
  sqlite.run(
    `INSERT OR IGNORE INTO accounts SELECT discord_id, '', balance, created_at FROM accounts_legacy`,
  );
  sqlite.run(`DROP TABLE accounts_legacy`);
}

sqlite.run(`
  CREATE TABLE IF NOT EXISTS accounts (
    discord_id TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    balance    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (discord_id, guild_id)
  )
`);
sqlite.run(`CREATE INDEX IF NOT EXISTS idx_accounts_guild ON accounts (guild_id)`);
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
// Post-install migrations for installs that predate newer columns.
// Each try swallows the usual "column already exists" error. Runs
// BEFORE the dependent indexes so existing DBs have the columns
// before we try to index them.
for (const col of [
  "ALTER TABLE bets ADD COLUMN expires_at TEXT",
  "ALTER TABLE bets ADD COLUMN channel_id TEXT",
  "ALTER TABLE bets ADD COLUMN message_id TEXT",
  "ALTER TABLE bets ADD COLUMN resolver_kind TEXT",
  "ALTER TABLE bets ADD COLUMN resolver_args TEXT",
  "ALTER TABLE bets ADD COLUMN resolver_state TEXT",
  "ALTER TABLE bets ADD COLUMN initial_prob REAL NOT NULL DEFAULT 0.5",
  "ALTER TABLE bets ADD COLUMN b INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE bets ADD COLUMN q_yes REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bets ADD COLUMN q_no REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bets ADD COLUMN challenge_target_discord_id TEXT",
  "ALTER TABLE bets ADD COLUMN challenge_accept_by TEXT",
  "ALTER TABLE bets ADD COLUMN creator_stake INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE bets ADD COLUMN creator_settled INTEGER NOT NULL DEFAULT 0",
]) {
  try {
    sqlite.run(col);
  } catch {
    /* already exists */
  }
}
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_bets_expires
    ON bets (expires_at)
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_bets_resolver
    ON bets (resolver_kind) WHERE resolver_kind IS NOT NULL
`);
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
// Wagers ALTERs run AFTER its CREATE TABLE — the loop above only
// covers bets columns because that table is created earlier in this
// file. Same swallowed-error pattern: fresh installs get the ADD
// COLUMN against the newly-created table, existing installs get the
// "duplicate column" throw, test runs trip the same path as fresh.
for (const col of ["ALTER TABLE wagers ADD COLUMN shares REAL NOT NULL DEFAULT 0"]) {
  try {
    sqlite.run(col);
  } catch {
    /* already exists */
  }
}
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_wagers_bet ON wagers (bet_id)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    guild_id   TEXT NOT NULL DEFAULT '',
    delta      INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    ref        TEXT,
    at         TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
try {
  sqlite.run(`ALTER TABLE ledger ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''`);
} catch {
  /* already exists */
}
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_ledger_discord_at
    ON ledger (discord_id, at)
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_ledger_guild_discord
    ON ledger (guild_id, discord_id)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS disputes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_id              INTEGER NOT NULL REFERENCES bets(id),
    opener_discord_id   TEXT NOT NULL,
    reason              TEXT NOT NULL,
    status              TEXT NOT NULL,
    final_action        TEXT,
    final_outcome       TEXT,
    resolver_discord_id TEXT,
    opened_at           TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at         TEXT,
    channel_id          TEXT,
    message_id          TEXT
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_disputes_bet ON disputes (bet_id)
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes (status)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS dispute_votes (
    dispute_id INTEGER NOT NULL REFERENCES disputes(id),
    discord_id TEXT NOT NULL,
    vote       TEXT NOT NULL,
    voted_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (dispute_id, discord_id)
  )
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS weekly_wins (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_ending      TEXT NOT NULL,
    guild_id         TEXT NOT NULL DEFAULT '',
    discord_id       TEXT NOT NULL,
    rank             INTEGER NOT NULL,
    balance_snapshot INTEGER NOT NULL
  )
`);
try {
  sqlite.run(`ALTER TABLE weekly_wins ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''`);
} catch {
  /* already exists */
}
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_weekly_wins_week
    ON weekly_wins (week_ending, guild_id)
`);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS admin_actions (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       TEXT NOT NULL DEFAULT (datetime('now')),
    admin_id TEXT NOT NULL,
    action   TEXT NOT NULL,
    target   TEXT NOT NULL,
    details  TEXT NOT NULL
  )
`);
sqlite.run(`CREATE INDEX IF NOT EXISTS idx_admin_actions_at ON admin_actions (at)`);
sqlite.run(
  `CREATE INDEX IF NOT EXISTS idx_admin_actions_admin ON admin_actions (admin_id)`,
);
sqlite.run(`
  CREATE TABLE IF NOT EXISTS market_ticks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_id         INTEGER NOT NULL REFERENCES bets(id),
    occurred_at    TEXT NOT NULL DEFAULT (datetime('now')),
    kind           TEXT NOT NULL,
    discord_id     TEXT NOT NULL,
    outcome        TEXT,
    shares         REAL NOT NULL DEFAULT 0,
    amount         INTEGER NOT NULL DEFAULT 0,
    q_yes_before   REAL NOT NULL,
    q_no_before    REAL NOT NULL,
    q_yes_after    REAL NOT NULL,
    q_no_after     REAL NOT NULL,
    b              REAL NOT NULL,
    prob_yes_after REAL NOT NULL
  )
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_market_ticks_bet_at
    ON market_ticks (bet_id, occurred_at)
`);
sqlite.run(`
  CREATE INDEX IF NOT EXISTS idx_market_ticks_user_at
    ON market_ticks (discord_id, occurred_at)
`);

sqlite.run(`
  CREATE TABLE IF NOT EXISTS flips (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id       TEXT NOT NULL,
    challenger_id  TEXT NOT NULL,
    target_id      TEXT NOT NULL,
    amount         INTEGER NOT NULL,
    status         TEXT NOT NULL,
    winner_id      TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at    TEXT,
    expires_at     TEXT NOT NULL,
    channel_id     TEXT,
    message_id     TEXT
  )
`);
sqlite.run(
  `CREATE INDEX IF NOT EXISTS idx_flips_guild_status ON flips (guild_id, status)`,
);
sqlite.run(
  `CREATE INDEX IF NOT EXISTS idx_flips_challenger
    ON flips (challenger_id, guild_id, status)`,
);
sqlite.run(
  `CREATE INDEX IF NOT EXISTS idx_flips_target
    ON flips (target_id, guild_id, status)`,
);
sqlite.run(`CREATE INDEX IF NOT EXISTS idx_flips_expires ON flips (expires_at)`);

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
