import { sqlite } from "../db.js";

/**
 * Per-pair carry attribution.
 *
 * For each shared match M where viewer V and teammate T were on the same
 * team, we compute two metrics:
 *
 *   overperf(T, M) = T.leetify_rating - mean(leetify_rating of team in M)
 *
 * Using |ΔPremier| (magnitude, not signed) keeps the sign of `carry`
 * driven purely by `overperf`: overperformers in any match (win or loss)
 * get positive credit for trying; underperformers get negative (dragged
 * the team down) regardless of outcome. The product with a signed Δ
 * would give the wrong sign when both factors are negative — e.g. Dong
 * playing badly in a loss would read as "positive carry", which is
 * counterintuitive.
 *
 * Phase 1 — Leetify proxy (works on historical data):
 *   proxy(T → V, M) = overperf(T, M) × outcomeWeight(V, M)
 *                     weight: 1 win/loss, 0.5 tie, 0 unknown.
 *
 * Phase 2 — Premier rating delta (matches with captured Premier):
 *   premier(T → V, M) = overperf(T, M) × |ΔPremier(V, M)|
 *                       ΔPremier = V's premier_after(M) - V's premier_after(prev match)
 *
 * This is a simplified form of Regularized Adjusted Plus-Minus (RAPM)
 * used in NBA analytics: each player's over/under performance relative
 * to team-mean, weighted by how much the match mattered. Proper RAPM
 * fits a ridge regression across many matches and controls for roster
 * variance — unnecessary here since the same squad queues together most
 * nights, and we want pairwise (not just per-player) attribution.
 */
export interface CarryRow {
  teammateSteamId: string;
  teammateName: string;
  proxyScore: number;
  premierScore: number;
  /**
   * Signed sum of the viewer's ΔPremier across shared matches — i.e.
   * "when I played with T, my rating moved by this much overall".
   * Unweighted (unlike premierScore): answers the user question
   * "did this teammate net me points or cost me points".
   */
  premierNetDelta: number;
  sharedMatches: number;
  premierSamples: number;
}

/** Who has carried `viewerSteamId`? Returns all teammates ranked by carry. */
export function getCarryStats(viewerSteamId: string, days?: number): CarryRow[] {
  // Self-join match_stats on match_id for shared matches, then per-match
  // Premier deltas via LAG over viewer's match timeline.
  // LAG runs before the window filter so the delta for the earliest
  // match in-window is still the true change from the prior game, not
  // null-truncated by the filter.
  const windowClause =
    days != null ? "AND m.finished_at >= datetime('now', '-' || ? || ' days')" : "";
  const rows = sqlite
    .query(
      `WITH viewer_matches AS (
         SELECT
           vs.match_id,
           vs.team_number AS viewer_team,
           vs.leetify_rating AS viewer_lr,
           vs.rounds_won AS v_won,
           vs.rounds_lost AS v_lost,
           vs.premier_after AS v_premier,
           LAG(vs.premier_after) OVER (
             ORDER BY m.finished_at
           ) AS prev_premier,
           m.finished_at AS finished_at
         FROM match_stats vs
         JOIN matches m ON m.match_id = vs.match_id
         WHERE vs.steam_id = ?
       ),
       team_means AS (
         SELECT
           ms.match_id,
           ms.team_number,
           AVG(ms.leetify_rating) AS team_mean
         FROM match_stats ms
         GROUP BY ms.match_id, ms.team_number
       )
       SELECT
         t.steam_id              AS teammate_steam_id,
         t.name                  AS teammate_name,
         t.leetify_rating        AS t_lr,
         tm.team_mean            AS team_mean,
         vm.v_won                AS v_won,
         vm.v_lost               AS v_lost,
         vm.v_premier            AS v_premier,
         vm.prev_premier         AS prev_premier
       FROM viewer_matches vm
       JOIN match_stats t
         ON t.match_id = vm.match_id
        AND t.team_number = vm.viewer_team
        AND t.steam_id != ?
       JOIN team_means tm
         ON tm.match_id = vm.match_id
        AND tm.team_number = vm.viewer_team
       WHERE 1=1 ${windowClause.replace("m.finished_at", "vm.finished_at")}`,
    )
    .all(
      ...(days != null
        ? [viewerSteamId, viewerSteamId, days]
        : [viewerSteamId, viewerSteamId]),
    ) as Array<{
    teammate_steam_id: string;
    teammate_name: string | null;
    t_lr: number | null;
    team_mean: number | null;
    v_won: number | null;
    v_lost: number | null;
    v_premier: number | null;
    prev_premier: number | null;
  }>;

  const byMate = new Map<string, CarryRow>();
  for (const r of rows) {
    if (r.t_lr == null || r.team_mean == null) continue;
    const overperf = r.t_lr - r.team_mean;

    // Outcome weight: win/loss = 1, tie = 0.5 (played but undecided),
    // unknown = 0. Sign is driven by `overperf` alone so an
    // underperformer-in-a-loss doesn't flip positive.
    const weight =
      r.v_won == null || r.v_lost == null ? 0 : r.v_won === r.v_lost ? 0.5 : 1;
    const proxyDelta = overperf * weight;

    const premierDelta =
      r.v_premier != null && r.prev_premier != null ? r.v_premier - r.prev_premier : null;
    const premierContribution =
      premierDelta != null ? overperf * Math.abs(premierDelta) : 0;

    const entry = byMate.get(r.teammate_steam_id) ?? {
      teammateSteamId: r.teammate_steam_id,
      teammateName: r.teammate_name ?? r.teammate_steam_id,
      proxyScore: 0,
      premierScore: 0,
      premierNetDelta: 0,
      sharedMatches: 0,
      premierSamples: 0,
    };
    entry.proxyScore += proxyDelta;
    entry.premierScore += premierContribution;
    entry.sharedMatches += 1;
    if (premierDelta != null) {
      entry.premierNetDelta += premierDelta;
      entry.premierSamples += 1;
    }
    // Prefer the most recent non-null name.
    if (r.teammate_name) entry.teammateName = r.teammate_name;
    byMate.set(r.teammate_steam_id, entry);
  }

  return [...byMate.values()].sort((a, b) => b.proxyScore - a.proxyScore);
}

/** Guild-wide carry: sum each player's contribution across all teammates. */
export interface TeamCarryRow {
  steamId: string;
  name: string;
  proxyScore: number;
  premierScore: number;
  partnerCount: number;
  sharedMatches: number;
  premierSamples: number;
}

export function getTeamCarryStats(
  guildSteamIds: string[],
  days?: number,
): TeamCarryRow[] {
  if (guildSteamIds.length < 2) return [];

  // Compute per-player contribution once per match rather than summing
  // per-viewer carries (which double-counts every match where >=3
  // tracked players shared a team). The SQL:
  //   eligible = matches where tracked player P was on a team with
  //              at least one other tracked player
  //   team_means = per (match, team) Leetify-rating mean
  //   then sum overperf * outcome_weight once per row
  const placeholders = guildSteamIds.map(() => "?").join(",");
  const windowClause =
    days != null ? "AND m.finished_at >= datetime('now', '-' || ? || ' days')" : "";
  const rows = sqlite
    .query(
      `WITH eligible AS (
         SELECT
           ms.match_id, ms.steam_id, ms.team_number, ms.name,
           ms.leetify_rating, ms.rounds_won, ms.rounds_lost,
           ms.premier_after,
           LAG(ms.premier_after) OVER (
             PARTITION BY ms.steam_id ORDER BY m.finished_at
           ) AS prev_premier
         FROM match_stats ms
         JOIN matches m ON m.match_id = ms.match_id
         WHERE ms.steam_id IN (${placeholders})
           ${windowClause}
           AND EXISTS (
             SELECT 1 FROM match_stats other
             WHERE other.match_id = ms.match_id
               AND other.team_number = ms.team_number
               AND other.steam_id != ms.steam_id
               AND other.steam_id IN (${placeholders})
           )
       ),
       team_means AS (
         SELECT match_id, team_number, AVG(leetify_rating) AS mean
         FROM match_stats
         WHERE leetify_rating IS NOT NULL
         GROUP BY match_id, team_number
       )
       SELECT
         e.steam_id AS steamId,
         MAX(e.name) AS name,
         COALESCE(SUM(
           (e.leetify_rating - tm.mean) *
           CASE
             WHEN e.rounds_won IS NULL OR e.rounds_lost IS NULL THEN 0
             WHEN e.rounds_won = e.rounds_lost THEN 0.5
             ELSE 1
           END
         ), 0) AS proxyScore,
         COALESCE(SUM(
           CASE WHEN e.premier_after IS NOT NULL AND e.prev_premier IS NOT NULL
                THEN (e.leetify_rating - tm.mean) *
                     ABS(e.premier_after - e.prev_premier)
                ELSE 0 END
         ), 0) AS premierScore,
         SUM(CASE WHEN e.premier_after IS NOT NULL AND e.prev_premier IS NOT NULL
                  THEN 1 ELSE 0 END) AS premierSamples,
         COUNT(DISTINCT e.match_id) AS sharedMatches
       FROM eligible e
       JOIN team_means tm
         ON tm.match_id = e.match_id AND tm.team_number = e.team_number
       GROUP BY e.steam_id`,
    )
    .all(
      ...(days != null
        ? [...guildSteamIds, days, ...guildSteamIds]
        : [...guildSteamIds, ...guildSteamIds]),
    ) as {
    steamId: string;
    name: string;
    proxyScore: number;
    premierScore: number;
    premierSamples: number;
    sharedMatches: number;
  }[];

  // Partner count (distinct other tracked players seen across their
  // eligible matches) — simpler as a second query than nesting above.
  const partnerRows = sqlite
    .query(
      `SELECT ms.steam_id AS steamId,
              COUNT(DISTINCT other.steam_id) AS partnerCount
       FROM match_stats ms
       JOIN matches m ON m.match_id = ms.match_id
       JOIN match_stats other
         ON other.match_id = ms.match_id
        AND other.team_number = ms.team_number
        AND other.steam_id != ms.steam_id
        AND other.steam_id IN (${placeholders})
       WHERE ms.steam_id IN (${placeholders})
         ${windowClause}
       GROUP BY ms.steam_id`,
    )
    .all(
      ...(days != null
        ? [...guildSteamIds, ...guildSteamIds, days]
        : [...guildSteamIds, ...guildSteamIds]),
    ) as {
    steamId: string;
    partnerCount: number;
  }[];
  const partnersByPlayer = new Map(partnerRows.map((r) => [r.steamId, r.partnerCount]));

  return rows
    .map((r) => ({
      steamId: r.steamId,
      name: r.name ?? r.steamId,
      proxyScore: r.proxyScore,
      premierScore: r.premierScore,
      premierSamples: r.premierSamples,
      sharedMatches: r.sharedMatches,
      partnerCount: partnersByPlayer.get(r.steamId) ?? 0,
    }))
    .sort((a, b) => b.proxyScore - a.proxyScore);
}
