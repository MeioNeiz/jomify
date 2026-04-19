import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

const now = sql`(datetime('now'))`;
const today = sql`(date('now'))`;

export const trackedPlayers = sqliteTable(
  "tracked_players",
  {
    guildId: text("guild_id").notNull(),
    steamId: text("steam_id").notNull(),
    addedAt: text("added_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.steamId] }),
    index("idx_tracked_players_steam").on(t.steamId),
  ],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    steamId: text("steam_id").notNull(),
    name: text("name").notNull(),
    premier: integer("premier"),
    leetify: real("leetify"),
    aim: real("aim"),
    positioning: real("positioning"),
    utility: real("utility"),
    clutch: real("clutch"),
    recordedAt: text("recorded_at").notNull().default(now),
  },
  (t) => [index("idx_snapshots_steam").on(t.steamId, t.recordedAt)],
);

export const linkedAccounts = sqliteTable("linked_accounts", {
  discordId: text("discord_id").primaryKey(),
  steamId: text("steam_id").notNull().unique(),
});

export const processedMatches = sqliteTable(
  "processed_matches",
  {
    matchId: text("match_id").notNull(),
    steamId: text("steam_id").notNull(),
    finishedAt: text("finished_at"),
    processedAt: text("processed_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.steamId] })],
);

export const guildConfig = sqliteTable("guild_config", {
  guildId: text("guild_id").primaryKey(),
  notifyChannelId: text("notify_channel_id"),
});

export const leaderboardSnapshots = sqliteTable(
  "leaderboard_snapshots",
  {
    guildId: text("guild_id").notNull(),
    steamId: text("steam_id").notNull(),
    premier: integer("premier"),
    recordedAt: text("recorded_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.steamId, t.recordedAt] }),
    index("idx_leaderboard_guild").on(t.guildId, t.recordedAt),
  ],
);

export const matches = sqliteTable(
  "matches",
  {
    matchId: text("match_id").primaryKey(),
    finishedAt: text("finished_at").notNull(),
    dataSource: text("data_source"),
    dataSourceMatchId: text("data_source_match_id"),
    mapName: text("map_name").notNull(),
    team1Score: integer("team1_score"),
    team2Score: integer("team2_score"),
    hasBannedPlayer: integer("has_banned_player", { mode: "boolean" }).default(false),
    replayUrl: text("replay_url"),
  },
  (t) => [index("idx_matches_finished").on(t.finishedAt)],
);

export const matchStats = sqliteTable(
  "match_stats",
  {
    matchId: text("match_id").notNull(),
    steamId: text("steam_id").notNull(),
    name: text("name"),
    teamNumber: integer("team_number"),
    totalKills: integer("total_kills"),
    totalDeaths: integer("total_deaths"),
    totalAssists: integer("total_assists"),
    kdRatio: real("kd_ratio"),
    dpr: real("dpr"),
    totalDamage: integer("total_damage"),
    leetifyRating: real("leetify_rating"),
    ctLeetifyRating: real("ct_leetify_rating"),
    tLeetifyRating: real("t_leetify_rating"),
    accuracyHead: real("accuracy_head"),
    sprayAccuracy: real("spray_accuracy"),
    flashbangHitFriend: integer("flashbang_hit_friend"),
    flashbangHitFoe: integer("flashbang_hit_foe"),
    flashbangThrown: integer("flashbang_thrown"),
    multi3k: integer("multi3k"),
    multi4k: integer("multi4k"),
    multi5k: integer("multi5k"),
    roundsCount: integer("rounds_count"),
    roundsWon: integer("rounds_won"),
    roundsLost: integer("rounds_lost"),
    premierAfter: integer("premier_after"),
    flashScore: real("flash_score"),
    raw: text("raw").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.steamId] }),
    foreignKey({ columns: [t.matchId], foreignColumns: [matches.matchId] }),
    index("idx_match_stats_steam").on(t.steamId),
  ],
);

export const apiUsage = sqliteTable(
  "api_usage",
  {
    endpoint: text("endpoint").notNull(),
    day: text("day").notNull().default(today),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.endpoint, t.day] })],
);

export const analysedOpponents = sqliteTable(
  "analysed_opponents",
  {
    matchId: text("match_id").notNull(),
    steamId: text("steam_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.steamId] })],
);

export const playerStreaks = sqliteTable("player_streaks", {
  steamId: text("steam_id").primaryKey(),
  streakType: text("streak_type").notNull().default("win"),
  streakCount: integer("streak_count").notNull().default(0),
  lastAlertedCount: integer("last_alerted_count").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(now),
});

// Steam accounts the user is tracking that don't have a Leetify profile.
// We cache these so the watcher stops polling (and logging) them every
// cycle. Re-checked after RECHECK_HOURS in case they sign up later.
export const leetifyUnknown = sqliteTable("leetify_unknown", {
  steamId: text("steam_id").primaryKey(),
  firstSeen: text("first_seen").notNull().default(now),
  lastChecked: text("last_checked").notNull().default(now),
});

// Per-invocation timing + API-call attribution for slash commands.
// Written once per command by runWithMetrics; queried by /metrics.
export const metrics = sqliteTable(
  "metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    command: text("command").notNull(),
    startedAt: text("started_at").notNull().default(now),
    ttfMs: integer("ttf_ms"),
    ttlMs: integer("ttl_ms"),
    totalMs: integer("total_ms").notNull(),
    apiCalls: text("api_calls"),
    // JSON snapshot of interaction.options.data — name of the
    // subcommand (if any) and each option the user supplied. Lets
    // you see "who ran /stats on @LaryIsland" in Datasette.
    options: text("options"),
    // 1 = fetchCached returned data and we served it before the
    // revalidate finished. 0 = no cached data, user saw only the
    // fresh render. null = not a respondWithRevalidate command.
    cacheHit: integer("cache_hit"),
    success: integer("success").notNull(),
    errorMessage: text("error_message"),
    userId: text("user_id"),
    guildId: text("guild_id"),
  },
  (t) => [index("idx_metrics_command_started").on(t.command, t.startedAt)],
);

// Durable error log. Mirrors what pino prints to journald but queryable
// via Datasette / scripts/db.ts so future investigations don't require
// scrolling log output.
export const errors = sqliteTable(
  "errors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    occurredAt: text("occurred_at").notNull().default(now),
    // Free-form but by convention: "command:/stats", "watcher:tick",
    // "leetify:fetch", "refresh:player", "scan:opponents", …
    source: text("source").notNull(),
    level: text("level").notNull(), // "warn" | "error"
    message: text("message").notNull(),
    stack: text("stack"),
    extra: text("extra"), // JSON context
  },
  (t) => [index("idx_errors_occurred").on(t.occurredAt)],
);

// Per-call outbound API log. Captures duration and final status so we
// can spot slow endpoints without manually tailing journald. One row
// per logical call (not per HTTP attempt); retry_count tells us how
// many retries that call burned.
export const apiCalls = sqliteTable(
  "api_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    occurredAt: text("occurred_at").notNull().default(now),
    endpoint: text("endpoint").notNull(),
    durationMs: integer("duration_ms").notNull(),
    status: integer("status"), // HTTP status; null if pre-HTTP failure
    retryCount: integer("retry_count").notNull().default(0),
  },
  (t) => [
    index("idx_api_calls_occurred").on(t.occurredAt),
    index("idx_api_calls_endpoint").on(t.endpoint, t.occurredAt),
  ],
);
