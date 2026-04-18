import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import db from "../db.js";
import { bumpApiCall } from "../metrics.js";
import { analysedOpponents, apiUsage, matches, matchStats } from "../schema.js";

export interface HeadToHeadResult {
  sharedMatches: number;
  sameTeamMatches: number;
  sameTeamWins: number;
  sameTeamLosses: number;
  sameTeamDraws: number;
}

export function getHeadToHead(steamId1: string, steamId2: string): HeadToHeadResult {
  const ms1 = alias(matchStats, "ms1");
  const ms2 = alias(matchStats, "ms2");

  const rows = db
    .select({
      team1: ms1.teamNumber,
      team2: ms2.teamNumber,
      team1Score: matches.team1Score,
      team2Score: matches.team2Score,
    })
    .from(ms1)
    .innerJoin(ms2, eq(ms1.matchId, ms2.matchId))
    .innerJoin(matches, eq(matches.matchId, ms1.matchId))
    .where(and(eq(ms1.steamId, steamId1), eq(ms2.steamId, steamId2)))
    .all();

  let sameTeamMatches = 0;
  let sameTeamWins = 0;
  let sameTeamLosses = 0;
  let sameTeamDraws = 0;

  for (const r of rows) {
    if (r.team1 !== r.team2) continue;
    sameTeamMatches++;
    const teamScore = r.team1 === 1 ? r.team1Score : r.team2Score;
    const oppScore = r.team1 === 1 ? r.team2Score : r.team1Score;
    if (teamScore == null || oppScore == null) continue;
    if (teamScore > oppScore) sameTeamWins++;
    else if (teamScore < oppScore) sameTeamLosses++;
    else sameTeamDraws++;
  }

  return {
    sharedMatches: rows.length,
    sameTeamMatches,
    sameTeamWins,
    sameTeamLosses,
    sameTeamDraws,
  };
}

export function isOpponentAnalysed(matchId: string, steamId: string): boolean {
  const row = db
    .select({ one: sql<number>`1` })
    .from(analysedOpponents)
    .where(
      and(eq(analysedOpponents.matchId, matchId), eq(analysedOpponents.steamId, steamId)),
    )
    .get();
  return !!row;
}

export function markOpponentAnalysed(matchId: string, steamId: string): void {
  db.insert(analysedOpponents).values({ matchId, steamId }).onConflictDoNothing().run();
}

export function trackApiCall(endpoint: string): void {
  db.insert(apiUsage)
    .values({ endpoint, count: 1 })
    .onConflictDoUpdate({
      target: [apiUsage.endpoint, apiUsage.day],
      set: { count: sql`${apiUsage.count} + 1` },
    })
    .run();
  // Also attribute to the in-flight command (no-op for background work).
  bumpApiCall(endpoint);
}

export function getApiUsage(
  days = 7,
): { endpoint: string; day: string; count: number }[] {
  return db
    .select({
      endpoint: apiUsage.endpoint,
      day: apiUsage.day,
      count: apiUsage.count,
    })
    .from(apiUsage)
    .where(sql`${apiUsage.day} >= date('now', '-' || ${days} || ' days')`)
    .orderBy(desc(apiUsage.day), desc(apiUsage.count))
    .all();
}

export function getApiUsageToday(): { endpoint: string; count: number }[] {
  return db
    .select({ endpoint: apiUsage.endpoint, count: apiUsage.count })
    .from(apiUsage)
    .where(sql`${apiUsage.day} = date('now')`)
    .orderBy(desc(apiUsage.count))
    .all();
}
