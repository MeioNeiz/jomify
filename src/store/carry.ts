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
export function getCarryStats(viewerSteamId: string): CarryRow[] {
  // Self-join match_stats on match_id for shared matches, then per-match
  // Premier deltas via LAG over viewer's match timeline.
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
           ) AS prev_premier
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
        AND tm.team_number = vm.viewer_team`,
    )
    .all(viewerSteamId, viewerSteamId) as Array<{
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

export function getTeamCarryStats(guildSteamIds: string[]): TeamCarryRow[] {
  if (guildSteamIds.length < 2) return [];

  // Unique-match counts per player: distinct matches each player
  // appeared in alongside ANY other tracked teammate on the same team.
  // Needed because summing per-viewer sharedMatches below would
  // double-count every match with >=3 tracked players on the team.
  const placeholders = guildSteamIds.map(() => "?").join(",");
  const uniqueRows = sqlite
    .query(
      `SELECT ms.steam_id AS steamId, COUNT(DISTINCT ms.match_id) AS unique_matches
       FROM match_stats ms
       JOIN match_stats other
         ON other.match_id = ms.match_id
        AND other.team_number = ms.team_number
        AND other.steam_id != ms.steam_id
        AND other.steam_id IN (${placeholders})
       WHERE ms.steam_id IN (${placeholders})
       GROUP BY ms.steam_id`,
    )
    .all(...guildSteamIds, ...guildSteamIds) as {
    steamId: string;
    unique_matches: number;
  }[];
  const uniqueByPlayer = new Map(uniqueRows.map((r) => [r.steamId, r.unique_matches]));

  const byPlayer = new Map<string, TeamCarryRow>();
  for (const viewerId of guildSteamIds) {
    const rows = getCarryStats(viewerId);
    for (const r of rows) {
      // Only count teammates who are also tracked in this guild (two-way).
      if (!guildSteamIds.includes(r.teammateSteamId)) continue;
      const entry = byPlayer.get(r.teammateSteamId) ?? {
        steamId: r.teammateSteamId,
        name: r.teammateName,
        proxyScore: 0,
        premierScore: 0,
        partnerCount: 0,
        sharedMatches: 0,
        premierSamples: 0,
      };
      entry.proxyScore += r.proxyScore;
      entry.premierScore += r.premierScore;
      entry.premierSamples += r.premierSamples;
      entry.partnerCount += 1;
      entry.name = r.teammateName;
      byPlayer.set(r.teammateSteamId, entry);
    }
  }

  // Replace the double-counted running total with the true unique count.
  for (const [steamId, entry] of byPlayer) {
    entry.sharedMatches = uniqueByPlayer.get(steamId) ?? 0;
  }

  return [...byPlayer.values()].sort((a, b) => b.proxyScore - a.proxyScore);
}
