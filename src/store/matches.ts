import { and, desc, eq, inArray, sql } from "drizzle-orm";
import db, { sqlite } from "../db.js";
import type { LeetifyMatchDetails, LeetifyPlayerStats } from "../leetify/types.js";
import { matches, matchStats, processedMatches } from "../schema.js";

export function isMatchProcessed(matchId: string, steamId: string): boolean {
  const row = db
    .select({ one: sql<number>`1` })
    .from(processedMatches)
    .where(
      and(eq(processedMatches.matchId, matchId), eq(processedMatches.steamId, steamId)),
    )
    .get();
  return !!row;
}

export function markMatchProcessed(
  matchId: string,
  steamId: string,
  finishedAt: string,
): void {
  db.insert(processedMatches)
    .values({ matchId, steamId, finishedAt })
    .onConflictDoNothing()
    .run();
}

export function getProcessedMatchCount(steamId: string): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(processedMatches)
    .where(eq(processedMatches.steamId, steamId))
    .get();
  return row?.count ?? 0;
}

export function getStoredMatchCount(steamId: string): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(matchStats)
    .where(eq(matchStats.steamId, steamId))
    .get();
  return row?.count ?? 0;
}

export function saveMatchDetails(match: LeetifyMatchDetails): void {
  const [t1, t2] = match.team_scores;

  db.insert(matches)
    .values({
      matchId: match.id,
      finishedAt: match.finished_at,
      dataSource: match.data_source,
      dataSourceMatchId: match.data_source_match_id,
      mapName: match.map_name,
      team1Score: t1.score,
      team2Score: t2.score,
      hasBannedPlayer: match.has_banned_player,
      replayUrl: match.replay_url ?? null,
    })
    .onConflictDoNothing()
    .run();

  db.transaction((tx) => {
    for (const p of match.stats) {
      tx.insert(matchStats)
        .values({
          matchId: match.id,
          steamId: p.steam64_id,
          name: p.name,
          teamNumber: p.initial_team_number,
          totalKills: p.total_kills,
          totalDeaths: p.total_deaths,
          totalAssists: p.total_assists,
          kdRatio: p.kd_ratio,
          dpr: p.dpr,
          totalDamage: p.total_damage,
          leetifyRating: p.leetify_rating,
          ctLeetifyRating: p.ct_leetify_rating,
          tLeetifyRating: p.t_leetify_rating,
          accuracyHead: p.accuracy_head,
          sprayAccuracy: p.spray_accuracy,
          flashbangHitFriend: p.flashbang_hit_friend,
          flashbangHitFoe: p.flashbang_hit_foe,
          flashbangThrown: p.flashbang_thrown,
          multi3k: p.multi3k,
          multi4k: p.multi4k,
          multi5k: p.multi5k,
          roundsCount: p.rounds_count,
          roundsWon: p.rounds_won,
          roundsLost: p.rounds_lost,
          flashScore: computeFlashScore(p),
          raw: JSON.stringify(p),
        })
        .onConflictDoNothing()
        .run();
    }
  });
}

/**
 * Per-match flash-throwing score. Balances enemy duration-weighted hits,
 * flash-into-kill setups, and flash assists against friendly blinds. Per
 * round so match length doesn't dominate. Pre-computed on save so
 * "best game" lookups are a cheap ORDER BY instead of per-row arithmetic.
 */
function computeFlashScore(p: LeetifyPlayerStats): number | null {
  if (!p.rounds_count) return null;
  const enemies = p.flashbang_hit_foe ?? 0;
  const duration = p.flashbang_hit_foe_avg_duration ?? 0;
  const leading = p.flashbang_leading_to_kill ?? 0;
  const assists = p.flash_assist ?? 0;
  const team = p.flashbang_hit_friend ?? 0;
  return (enemies * duration + 2 * leading + assists - 2 * team) / p.rounds_count;
}

export type BestStatKey =
  | "rating"
  | "kills"
  | "kd"
  | "adr"
  | "hs"
  | "aim"
  | "positioning"
  | "utility"
  | "clutch"
  | "flash"
  | "multikill";

// Per-stat config. `sortExpr` is a SQL expression ranked DESC to pick
// the best match. Leetify doesn't publish per-match aim/positioning/
// utility/clutch breakdowns in their public API, so the composite
// scores below are documented approximations derived from fields we
// already store.
export const BEST_STATS: Record<
  BestStatKey,
  { label: string; sortExpr: string; format: (v: number) => string }
> = {
  rating: {
    label: "Leetify rating",
    sortExpr: "ms.leetify_rating",
    format: (v) => v.toFixed(2),
  },
  kills: {
    label: "Kills",
    sortExpr: "ms.total_kills",
    format: (v) => v.toFixed(0),
  },
  kd: {
    label: "K/D ratio",
    sortExpr: "ms.kd_ratio",
    format: (v) => v.toFixed(2),
  },
  adr: { label: "ADR", sortExpr: "ms.dpr", format: (v) => v.toFixed(0) },
  hs: {
    label: "Headshot accuracy",
    sortExpr: "ms.accuracy_head",
    format: (v) => `${v.toFixed(1)}%`,
  },
  // Composite: head accuracy dominates, spray contributes half, preaim
  // penalises (preaim = cm of crosshair drift before firing, lower is
  // better). Dimensionless score — only useful ordinally.
  aim: {
    label: "Aim score",
    sortExpr:
      "(COALESCE(ms.accuracy_head, 0)" +
      " + 0.5 * COALESCE(ms.spray_accuracy, 0)" +
      " - 0.3 * COALESCE(CAST(json_extract(ms.raw, '$.preaim') AS REAL), 0))",
    format: (v) => v.toFixed(1),
  },
  // % of rounds survived. Proxy for positioning/trade discipline.
  positioning: {
    label: "Survival %",
    sortExpr:
      "((1.0 - CAST(ms.total_deaths AS REAL) / NULLIF(ms.rounds_count, 0)) * 100)",
    format: (v) => `${v.toFixed(1)}%`,
  },
  // Flash impact + HE damage to enemies, penalised for friendly HE
  // damage. Covers most of Leetify's "utility" concept.
  utility: {
    label: "Utility score",
    sortExpr:
      "(COALESCE(ms.flash_score, 0)" +
      " + 0.5 * COALESCE(CAST(json_extract(ms.raw, '$.he_foes_damage_avg') AS REAL), 0)" +
      " - 0.3 * COALESCE(CAST(json_extract(ms.raw, '$.he_friends_damage_avg') AS REAL), 0))",
    format: (v) => v.toFixed(2),
  },
  // Leetify doesn't expose clutch rounds via match API, so we proxy
  // with weighted multikills — biggest-impact moments in the match.
  clutch: {
    label: "Clutch score",
    sortExpr:
      "(COALESCE(ms.multi5k, 0) * 10 + COALESCE(ms.multi4k, 0) * 5 + COALESCE(ms.multi3k, 0) * 3)",
    format: (v) => v.toFixed(0),
  },
  flash: {
    label: "Flash impact",
    sortExpr: "ms.flash_score",
    format: (v) => v.toFixed(2),
  },
  // Lexicographic on tier — 5k beats any 4k, 4k beats any 3k, etc.
  multikill: {
    label: "Biggest multikill",
    sortExpr:
      "(COALESCE(ms.multi5k, 0) * 100 + COALESCE(ms.multi4k, 0) * 10 + COALESCE(ms.multi3k, 0))",
    format: (v) => v.toFixed(0),
  },
};

export interface BestMatch {
  steamId: string;
  name: string;
  matchId: string;
  mapName: string;
  finishedAt: string;
  roundsWon: number | null;
  roundsLost: number | null;
  kills: number;
  deaths: number;
  assists: number;
  dpr: number;
  rating: number | null;
  multi3k: number | null;
  multi4k: number | null;
  multi5k: number | null;
  statValue: number;
}

export function getBestMatch(
  steamIds: string[],
  stat: BestStatKey,
  days: number,
): BestMatch | null {
  if (!steamIds.length) return null;
  const placeholders = steamIds.map(() => "?").join(",");
  const { sortExpr } = BEST_STATS[stat];
  const row = sqlite
    .query(
      `SELECT
         ms.match_id AS matchId,
         ms.steam_id AS steamId,
         ms.name AS name,
         ms.rounds_won AS roundsWon,
         ms.rounds_lost AS roundsLost,
         ms.total_kills AS kills,
         ms.total_deaths AS deaths,
         ms.total_assists AS assists,
         ms.dpr AS dpr,
         ms.leetify_rating AS rating,
         ms.multi3k AS multi3k,
         ms.multi4k AS multi4k,
         ms.multi5k AS multi5k,
         m.map_name AS mapName,
         m.finished_at AS finishedAt,
         ${sortExpr} AS statValue
       FROM match_stats ms
       JOIN matches m ON m.match_id = ms.match_id
       WHERE ms.steam_id IN (${placeholders})
         AND (${sortExpr}) IS NOT NULL
         AND m.finished_at >= datetime('now', '-' || ? || ' days')
       ORDER BY statValue DESC, m.finished_at DESC
       LIMIT 1`,
    )
    .get(...steamIds, days) as BestMatch | null;
  return row;
}

/**
 * Stamp a player's post-match Premier rating onto a match row. Called by
 * the watcher when it processes a freshly-finished match. Enables the
 * /carry math by letting us compute per-match rating deltas later.
 */
export function recordPremierAfter(
  matchId: string,
  steamId: string,
  premier: number,
): void {
  db.update(matchStats)
    .set({ premierAfter: premier })
    .where(and(eq(matchStats.matchId, matchId), eq(matchStats.steamId, steamId)))
    .run();
}

type MatchRow = {
  matchId: string;
  mapName: string;
  finishedAt: string;
  raw: LeetifyPlayerStats;
};

function toMatchRow(r: {
  matchId: string;
  mapName: string;
  finishedAt: string;
  raw: string;
}): MatchRow {
  return {
    matchId: r.matchId,
    mapName: r.mapName,
    finishedAt: r.finishedAt,
    raw: JSON.parse(r.raw) as LeetifyPlayerStats,
  };
}

export function getPlayerMatchStats(steamId: string, limit = 20): MatchRow[] {
  return db
    .select({
      matchId: matchStats.matchId,
      mapName: matches.mapName,
      finishedAt: matches.finishedAt,
      raw: matchStats.raw,
    })
    .from(matchStats)
    .innerJoin(matches, eq(matches.matchId, matchStats.matchId))
    .where(eq(matchStats.steamId, steamId))
    .orderBy(desc(matches.finishedAt))
    .limit(limit)
    .all()
    .map(toMatchRow);
}

/** Get matches within the last N hours. */
export function getRecentMatchesSince(steamId: string, hours: number): MatchRow[] {
  return db
    .select({
      matchId: matchStats.matchId,
      mapName: matches.mapName,
      finishedAt: matches.finishedAt,
      raw: matchStats.raw,
    })
    .from(matchStats)
    .innerJoin(matches, eq(matches.matchId, matchStats.matchId))
    .where(
      and(
        eq(matchStats.steamId, steamId),
        sql`${matches.finishedAt} >= datetime('now', '-' || ${hours} || ' hours')`,
      ),
    )
    .orderBy(desc(matches.finishedAt))
    .all()
    .map(toMatchRow);
}

/** Latest finished_at (ISO, UTC) across the given steam IDs, or null. */
export function getMostRecentMatchTime(steamIds: string[]): string | null {
  if (!steamIds.length) return null;
  const row = db
    .select({ latest: sql<string | null>`MAX(${matches.finishedAt})` })
    .from(matches)
    .innerJoin(matchStats, eq(matchStats.matchId, matches.matchId))
    .where(inArray(matchStats.steamId, steamIds))
    .get();
  return row?.latest ?? null;
}

export interface PlayerAverages {
  avg_kills: number;
  avg_deaths: number;
  avg_kd: number;
  avg_dpr: number;
  avg_rating: number;
  avg_hs: number;
  avg_spray: number;
  /** Fraction of thrown flashes that hit a teammate (0-1). */
  flash_friend_rate: number;
  /** Fraction of thrown flashes that hit an enemy (0-1). */
  flash_enemy_rate: number;
  /** Average flashes thrown per match, for context. */
  avg_flash_thrown: number;
  avg_he_damage: number;
  avg_he_friends_damage: number;
  avg_he_thrown: number;
  avg_molotov_thrown: number;
  avg_smoke_thrown: number;
  avg_util_on_death: number;
  match_count: number;
}

/**
 * Averages over the player's last `limit` matches (most recent first).
 * Defaults to 30 — recent form over career stats. Pass Infinity for all-time.
 */
export function getPlayerStatAverages(
  steamId: string,
  limit = 30,
): PlayerAverages | null {
  // Raw bun:sqlite — drizzle's `db.get(sql\`\`)` returns arrays on this
  // driver, but we want a named-field object. Query shape is too complex
  // for the typed select builder (subquery for LIMIT + json_extract).
  const row = sqlite
    .query(
      `SELECT
         AVG(total_kills) AS avg_kills,
         AVG(total_deaths) AS avg_deaths,
         AVG(kd_ratio) AS avg_kd,
         AVG(dpr) AS avg_dpr,
         AVG(leetify_rating) AS avg_rating,
         AVG(accuracy_head) AS avg_hs,
         AVG(spray_accuracy) AS avg_spray,
         CAST(SUM(flashbang_hit_friend) AS REAL) / NULLIF(SUM(flashbang_thrown), 0)
           AS flash_friend_rate,
         CAST(SUM(flashbang_hit_foe) AS REAL) / NULLIF(SUM(flashbang_thrown), 0)
           AS flash_enemy_rate,
         AVG(flashbang_thrown) AS avg_flash_thrown,
         AVG(json_extract(raw, '$.he_foes_damage_avg')) AS avg_he_damage,
         AVG(json_extract(raw, '$.he_friends_damage_avg')) AS avg_he_friends_damage,
         AVG(json_extract(raw, '$.he_thrown')) AS avg_he_thrown,
         AVG(json_extract(raw, '$.molotov_thrown')) AS avg_molotov_thrown,
         AVG(json_extract(raw, '$.smoke_thrown')) AS avg_smoke_thrown,
         AVG(json_extract(raw, '$.utility_on_death_avg')) AS avg_util_on_death,
         COUNT(*) AS match_count
       FROM (
         SELECT ms.*
         FROM match_stats ms
         JOIN matches m ON m.match_id = ms.match_id
         WHERE ms.steam_id = ?
         ORDER BY m.finished_at DESC
         LIMIT ?
       )`,
    )
    .get(steamId, limit) as PlayerAverages | null;
  return row?.match_count ? row : null;
}
