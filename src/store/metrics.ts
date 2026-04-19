import { sql } from "drizzle-orm";
import db, { sqlite } from "../db.js";
import { metrics } from "../schema.js";

export type MetricRow = {
  command: string;
  startedAt: string;
  ttfMs: number | null;
  ttlMs: number | null;
  totalMs: number;
  apiCalls: string | null;
  options: string | null;
  cacheHit: number | null;
  success: number;
  errorMessage: string | null;
  userId: string | null;
  guildId: string | null;
};

export function saveMetric(row: MetricRow): void {
  db.insert(metrics)
    .values({
      command: row.command,
      startedAt: row.startedAt,
      ttfMs: row.ttfMs,
      ttlMs: row.ttlMs,
      totalMs: row.totalMs,
      apiCalls: row.apiCalls,
      options: row.options,
      cacheHit: row.cacheHit,
      success: row.success,
      errorMessage: row.errorMessage,
      userId: row.userId,
      guildId: row.guildId,
    })
    .run();
}

export type CommandStats = {
  command: string;
  count: number;
  /** p50 / p95 of total_ms (full wall clock). */
  p50Ms: number;
  p95Ms: number;
  /** p50 of ttf_ms — user-perceived latency before seeing any reply. */
  ttfP50Ms: number;
  avgTotalMs: number;
  avgApiCalls: number;
  failureCount: number;
};

/**
 * One row per command seen in the window. Percentiles use SQLite's
 * OFFSET trick (bundled sqlite 3.51.2 lacks PERCENTILE_CONT); avg
 * API calls sums the JSON values and averages across invocations.
 */
export function getCommandStats(days: number): CommandStats[] {
  const since = sql`datetime('now', '-' || ${days} || ' days')`;

  const commands = db
    .select({ command: metrics.command })
    .from(metrics)
    .where(sql`${metrics.startedAt} >= ${since}`)
    .groupBy(metrics.command)
    .all()
    .map((r) => r.command);

  const results: CommandStats[] = [];
  for (const command of commands) {
    const agg = sqlite
      .query<
        {
          count: number;
          avg_total: number;
          avg_api: number;
          failures: number;
        },
        [string, number]
      >(
        `SELECT
           COUNT(*) as count,
           AVG(total_ms) as avg_total,
           AVG(
             CASE
               WHEN api_calls IS NULL THEN 0
               ELSE (
                 SELECT COALESCE(SUM(value), 0)
                 FROM json_each(api_calls)
               )
             END
           ) as avg_api,
           SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures
         FROM metrics
         WHERE command = ?
           AND started_at >= datetime('now', '-' || ? || ' days')`,
      )
      .get(command, days);
    if (!agg || agg.count === 0) continue;

    results.push({
      command,
      count: agg.count,
      p50Ms: percentile(command, days, 50, "total_ms"),
      p95Ms: percentile(command, days, 95, "total_ms"),
      ttfP50Ms: percentile(command, days, 50, "ttf_ms"),
      avgTotalMs: Math.round(agg.avg_total ?? 0),
      avgApiCalls: Math.round((agg.avg_api ?? 0) * 100) / 100,
      failureCount: agg.failures ?? 0,
    });
  }

  results.sort((a, b) => b.p95Ms - a.p95Ms);
  return results;
}

// OFFSET-based percentile over a chosen numeric column. For N rows,
// pick the row at index floor((N - 1) * pct/100) from an ascending
// sort. Null values (e.g. ttf_ms when no reply was sent) are dropped
// before counting so they don't drag the median down.
function percentile(
  command: string,
  days: number,
  pct: number,
  column: "total_ms" | "ttf_ms",
): number {
  const countRow = sqlite
    .query<{ count: number }, [string, number]>(
      `SELECT COUNT(*) as count FROM metrics
       WHERE command = ?
         AND started_at >= datetime('now', '-' || ? || ' days')
         AND ${column} IS NOT NULL`,
    )
    .get(command, days);
  const count = countRow?.count ?? 0;
  if (count === 0) return 0;
  const offset = Math.floor(((count - 1) * pct) / 100);
  const row = sqlite
    .query<{ value: number }, [string, number, number]>(
      `SELECT ${column} AS value FROM metrics
       WHERE command = ?
         AND started_at >= datetime('now', '-' || ? || ' days')
         AND ${column} IS NOT NULL
       ORDER BY ${column} ASC
       LIMIT 1 OFFSET ?`,
    )
    .get(command, days, offset);
  return row?.value ?? 0;
}
