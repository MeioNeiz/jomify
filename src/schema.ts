import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(datetime('now'))`;

export const linkedAccounts = sqliteTable("linked_accounts", {
  discordId: text("discord_id").primaryKey(),
  steamId: text("steam_id").notNull().unique(),
});

export const guildConfig = sqliteTable("guild_config", {
  guildId: text("guild_id").primaryKey(),
  notifyChannelId: text("notify_channel_id"),
  activityPings: integer("activity_pings").notNull().default(0),
});

// Per-invocation timing + API-call attribution for slash commands.
// Written once per command by runWithMetrics; queried by /jomify metrics.
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
