import { beforeEach, describe, expect, test } from "bun:test";
import { sqlite as db } from "../src/db.js";
import type { LeetifyMatchDetails } from "../src/leetify/types.js";
import {
  getAllGuildIds,
  getApiUsageToday,
  getBestMatch,
  getHeadToHead,
  getPlayerHistory,
  getPlayerMapStats,
  getPlayerMatchStats,
  getPlayerStatAverages,
  getPlayerStreak,
  getProcessedMatchCount,
  getSteamId,
  getStoredMatchCount,
  getTeamMapStats,
  getWeekAgoLeaderboard,
  hasMatchStats,
  isMatchProcessed,
  isOpponentAnalysed,
  linkAccount,
  markMatchProcessed,
  markOpponentAnalysed,
  markStreakAlerted,
  saveMatchDetails,
  setNotifyChannel,
  trackApiCall,
  updatePlayerStreak,
} from "../src/store.js";

const GUILD = "test-guild";
const STEAM1 = "76561198000000001";
const STEAM2 = "76561198000000002";

beforeEach(() => {
  db.run("DELETE FROM tracked_players");
  db.run("DELETE FROM linked_accounts");
  db.run("DELETE FROM processed_matches");
  db.run("DELETE FROM guild_config");
  db.run("DELETE FROM leaderboard_snapshots");
  db.run("DELETE FROM snapshots");
  db.run("DELETE FROM player_streaks");
  db.run("DELETE FROM match_stats");
  db.run("DELETE FROM matches");
  db.run("DELETE FROM analysed_opponents");
  db.run("DELETE FROM api_usage");
});

// ── Streaks ──

describe("player streaks", () => {
  test("no streak returns null", () => {
    expect(getPlayerStreak(STEAM1)).toBeNull();
  });

  test("first win creates streak of 1", () => {
    const s = updatePlayerStreak(STEAM1, "win");
    expect(s.streakType).toBe("win");
    expect(s.streakCount).toBe(1);
  });

  test("consecutive wins increment", () => {
    updatePlayerStreak(STEAM1, "win");
    updatePlayerStreak(STEAM1, "win");
    const s = updatePlayerStreak(STEAM1, "win");
    expect(s.streakCount).toBe(3);
  });

  test("loss resets win streak", () => {
    updatePlayerStreak(STEAM1, "win");
    updatePlayerStreak(STEAM1, "win");
    const s = updatePlayerStreak(STEAM1, "loss");
    expect(s.streakType).toBe("loss");
    expect(s.streakCount).toBe(1);
  });

  test("tie resets streak to 0", () => {
    updatePlayerStreak(STEAM1, "win");
    updatePlayerStreak(STEAM1, "win");
    const s = updatePlayerStreak(STEAM1, "tie");
    expect(s.streakCount).toBe(0);
  });

  test("markStreakAlerted updates count", () => {
    updatePlayerStreak(STEAM1, "win");
    updatePlayerStreak(STEAM1, "win");
    updatePlayerStreak(STEAM1, "win");
    markStreakAlerted(STEAM1, 3);
    const s = getPlayerStreak(STEAM1);
    expect(s!.lastAlertedCount).toBe(3);
  });

  test("alerted count resets on streak break", () => {
    updatePlayerStreak(STEAM1, "win");
    updatePlayerStreak(STEAM1, "win");
    updatePlayerStreak(STEAM1, "win");
    markStreakAlerted(STEAM1, 3);
    updatePlayerStreak(STEAM1, "loss");
    const s = getPlayerStreak(STEAM1);
    expect(s!.lastAlertedCount).toBe(0);
  });
});

// ── Weekly leaderboard ──

describe("weekly leaderboard", () => {
  test("getAllGuildIds returns configured guilds", () => {
    setNotifyChannel("guild-a", "ch-1");
    setNotifyChannel("guild-b", "ch-2");
    const ids = getAllGuildIds();
    expect(ids).toContain("guild-a");
    expect(ids).toContain("guild-b");
  });

  test("getAllGuildIds excludes unconfigured", () => {
    expect(getAllGuildIds()).toEqual([]);
  });

  test("getWeekAgoLeaderboard with no data", () => {
    expect(getWeekAgoLeaderboard(GUILD)).toEqual([]);
  });

  test("getWeekAgoLeaderboard finds nearest", () => {
    // Insert a snapshot backdated ~7 days
    db.run(
      `INSERT INTO leaderboard_snapshots
           (guild_id, steam_id, premier,
            recorded_at)
         VALUES (?, ?, ?, datetime('now',
           '-7 days'))`,
      [GUILD, STEAM1, 15000],
    );
    const result = getWeekAgoLeaderboard(GUILD);
    expect(result).toHaveLength(1);
    expect(result[0].steamId).toBe(STEAM1);
    expect(result[0].premier).toBe(15000);
  });
});

// ── Helpers to create test match data ──

function makeMatch(
  id: string,
  map: string,
  t1Score: number,
  t2Score: number,
  players: {
    steamId: string;
    team: number;
    kills: number;
    deaths: number;
  }[],
): LeetifyMatchDetails {
  return {
    id,
    finished_at: "2026-01-01T00:00:00Z",
    data_source: "matchmaking",
    data_source_match_id: id,
    map_name: map,
    has_banned_player: false,
    team_scores: [
      { team_number: 2, score: t1Score },
      { team_number: 3, score: t2Score },
    ],
    stats: players.map((p) => ({
      steam64_id: p.steamId,
      name: `Player_${p.steamId.slice(-4)}`,
      mvps: 0,
      preaim: 50,
      reaction_time: 200,
      accuracy: 0.3,
      accuracy_enemy_spotted: 0.3,
      accuracy_head: 0.4,
      shots_fired_enemy_spotted: 100,
      shots_fired: 200,
      shots_hit_enemy_spotted: 30,
      shots_hit_friend: 0,
      shots_hit_friend_head: 0,
      shots_hit_foe: 60,
      shots_hit_foe_head: 24,
      utility_on_death_avg: 200,
      he_foes_damage_avg: 5,
      he_friends_damage_avg: 0,
      he_thrown: 5,
      molotov_thrown: 3,
      smoke_thrown: 4,
      counter_strafing_shots_all: 50,
      counter_strafing_shots_bad: 10,
      counter_strafing_shots_good: 40,
      counter_strafing_shots_good_ratio: 0.8,
      flashbang_hit_foe: 2,
      flashbang_leading_to_kill: 1,
      flashbang_hit_foe_avg_duration: 1.5,
      flashbang_hit_friend: 1,
      flashbang_thrown: 5,
      flash_assist: 1,
      score: 20,
      initial_team_number: p.team,
      spray_accuracy: 0.35,
      total_kills: p.kills,
      total_deaths: p.deaths,
      kd_ratio: p.kills / Math.max(p.deaths, 1),
      rounds_survived: 10,
      rounds_survived_percentage: 0.4,
      dpr: 80,
      total_assists: 3,
      total_damage: 2000,
      leetify_rating: 0.05,
      ct_leetify_rating: 0.04,
      t_leetify_rating: 0.06,
      multi1k: 10,
      multi2k: 3,
      multi3k: 1,
      multi4k: 0,
      multi5k: 0,
      rounds_count: 25,
      rounds_won: 13,
      rounds_lost: 12,
      total_hs_kills: 8,
      trade_kill_opportunities: 5,
      trade_kill_attempts: 3,
      trade_kills_succeed: 2,
      trade_kill_attempts_percentage: 0.6,
      trade_kills_success_percentage: 0.67,
      trade_kill_opportunities_per_round: 0.2,
      traded_death_opportunities: 4,
      traded_death_attempts: 2,
      traded_deaths_succeed: 1,
      traded_death_attempts_percentage: 0.5,
      traded_deaths_success_percentage: 0.5,
      traded_deaths_opportunities_per_round: 0.16,
    })),
  } as LeetifyMatchDetails;
}

function seedMatches() {
  const matches = [
    makeMatch("m1", "de_dust2", 13, 7, [
      {
        steamId: STEAM1,
        team: 2,
        kills: 20,
        deaths: 15,
      },
      {
        steamId: STEAM2,
        team: 2,
        kills: 18,
        deaths: 12,
      },
    ]),
    makeMatch("m2", "de_dust2", 8, 13, [
      {
        steamId: STEAM1,
        team: 2,
        kills: 15,
        deaths: 18,
      },
      {
        steamId: STEAM2,
        team: 2,
        kills: 12,
        deaths: 16,
      },
    ]),
    makeMatch("m3", "de_mirage", 13, 10, [
      {
        steamId: STEAM1,
        team: 2,
        kills: 22,
        deaths: 14,
      },
      {
        steamId: STEAM2,
        team: 2,
        kills: 19,
        deaths: 13,
      },
    ]),
    makeMatch("m4", "de_mirage", 7, 13, [
      {
        steamId: STEAM1,
        team: 3,
        kills: 10,
        deaths: 20,
      },
      {
        steamId: STEAM2,
        team: 3,
        kills: 14,
        deaths: 17,
      },
    ]),
  ];

  for (const m of matches) {
    saveMatchDetails(m);
  }
}

// ── Head-to-head ──

describe("head-to-head", () => {
  test("no shared matches", () => {
    const h2h = getHeadToHead(STEAM1, STEAM2);
    expect(h2h.sharedMatches).toBe(0);
  });

  test("counts shared and same-team matches", () => {
    seedMatches();
    const h2h = getHeadToHead(STEAM1, STEAM2);
    expect(h2h.sharedMatches).toBe(4);
    expect(h2h.sameTeamMatches).toBe(4);
  });

  test("tracks same-team win/loss", () => {
    seedMatches();
    const h2h = getHeadToHead(STEAM1, STEAM2);
    // m1: team2 wins (13>7), m2: team2 loses
    // (8<13), m3: team2 wins (13>10),
    // m4: team3 loses (7<13)
    expect(h2h.sameTeamWins).toBe(2);
    expect(h2h.sameTeamLosses).toBe(2);
  });
});

// ── Map win rates ──

describe("map win rates", () => {
  test("player map stats", () => {
    seedMatches();
    const stats = getPlayerMapStats(STEAM1);
    expect(stats.length).toBeGreaterThan(0);

    const dust2 = stats.find((s) => s.mapName === "de_dust2");
    expect(dust2).toBeDefined();
    expect(dust2!.total).toBe(2);
    expect(dust2!.wins).toBe(1);
    expect(dust2!.losses).toBe(1);
  });

  test("team map stats same team", () => {
    seedMatches();
    const stats = getTeamMapStats([STEAM1, STEAM2]);
    expect(stats.length).toBeGreaterThan(0);

    const total = stats.reduce((s, m) => s + m.total, 0);
    expect(total).toBe(4);
  });

  test("team map stats empty for no players", () => {
    expect(getTeamMapStats([])).toEqual([]);
  });
});

// ── Player stat averages ──

describe("player stat averages", () => {
  test("returns averages with extended fields", () => {
    seedMatches();
    const avgs = getPlayerStatAverages(STEAM1);
    expect(avgs).not.toBeNull();
    expect(avgs!.avg_kills).toBeGreaterThan(0);
    expect(avgs!.avg_kd).toBeGreaterThan(0);
    expect(avgs!.match_count).toBe(4);
    // Extended fields from compare
    expect(avgs!.flash_enemy_rate).toBeDefined();
    expect(avgs!.flash_friend_rate).toBeDefined();
    expect(avgs!.avg_he_damage).toBeDefined();
    expect(avgs!.avg_util_on_death).toBeDefined();
  });

  test("no matches returns null", () => {
    expect(getPlayerStatAverages("nobody")).toBeNull();
  });
});

// ── Player match stats ──

describe("player match stats", () => {
  test("returns recent matches in order", () => {
    seedMatches();
    const matches = getPlayerMatchStats(STEAM1, 10);
    expect(matches).toHaveLength(4);
    expect(matches[0].raw.steam64_id).toBe(STEAM1);
  });

  test("respects limit", () => {
    seedMatches();
    const matches = getPlayerMatchStats(STEAM1, 2);
    expect(matches).toHaveLength(2);
  });

  test("no data returns empty array", () => {
    expect(getPlayerMatchStats("nobody")).toEqual([]);
  });
});

// ── Bug regressions ──

describe("saveMatchDetails merges players", () => {
  test("second save adds new player stats", () => {
    // Save match with only player 1
    const m1 = makeMatch("merge-1", "de_dust2", 13, 7, [
      { steamId: STEAM1, team: 2, kills: 20, deaths: 15 },
    ]);
    saveMatchDetails(m1);
    expect(getPlayerMatchStats(STEAM1, 10)).toHaveLength(1);
    expect(getPlayerMatchStats(STEAM2, 10)).toHaveLength(0);

    // Save same match with player 2 — should merge
    const m2 = makeMatch("merge-1", "de_dust2", 13, 7, [
      { steamId: STEAM2, team: 2, kills: 18, deaths: 12 },
    ]);
    saveMatchDetails(m2);
    expect(getPlayerMatchStats(STEAM1, 10)).toHaveLength(1);
    expect(getPlayerMatchStats(STEAM2, 10)).toHaveLength(1);
  });

  test("duplicate save doesn't create duplicates", () => {
    const m = makeMatch("dup-1", "de_dust2", 13, 7, [
      { steamId: STEAM1, team: 2, kills: 20, deaths: 15 },
    ]);
    saveMatchDetails(m);
    saveMatchDetails(m);
    expect(getPlayerMatchStats(STEAM1, 10)).toHaveLength(1);
  });
});

describe("team map stats no double counting", () => {
  test("win rates never exceed 100%", () => {
    seedMatches();
    const stats = getTeamMapStats([STEAM1, STEAM2]);
    for (const s of stats) {
      expect(s.winRate).toBeLessThanOrEqual(100);
      expect(s.wins + s.losses).toBeLessThanOrEqual(s.total);
    }
  });
});

describe("backfill checks match_stats not processed", () => {
  test("processed without data means no stored matches", () => {
    // Mark matches as processed but don't save details
    markMatchProcessed("orphan-1", STEAM1, "2026-01-01");
    markMatchProcessed("orphan-2", STEAM1, "2026-01-01");
    expect(getProcessedMatchCount(STEAM1)).toBe(2);
    expect(getStoredMatchCount(STEAM1)).toBe(0);
  });
});

describe("hasMatchStats — detail-save marker (independent of isMatchProcessed)", () => {
  test("false before saveMatchDetails", () => {
    expect(hasMatchStats("m1", STEAM1)).toBe(false);
  });

  test("true after saveMatchDetails for each player in the match", () => {
    saveMatchDetails(
      makeMatch("m1", "de_dust2", 13, 7, [
        { steamId: STEAM1, team: 2, kills: 10, deaths: 10 },
        { steamId: STEAM2, team: 2, kills: 10, deaths: 10 },
      ]),
    );
    expect(hasMatchStats("m1", STEAM1)).toBe(true);
    expect(hasMatchStats("m1", STEAM2)).toBe(true);
  });

  test("is scoped per (match, player) — other matches stay false", () => {
    saveMatchDetails(
      makeMatch("m1", "de_dust2", 13, 7, [
        { steamId: STEAM1, team: 2, kills: 10, deaths: 10 },
      ]),
    );
    expect(hasMatchStats("m1", STEAM1)).toBe(true);
    expect(hasMatchStats("m1", STEAM2)).toBe(false);
    expect(hasMatchStats("m2", STEAM1)).toBe(false);
  });

  test("isMatchProcessed and hasMatchStats are independent", () => {
    // Simulate the old bug: a match got marked processed but details
    // never saved (transient Leetify failure swallowed in the
    // try/catch). The fixed watcher retries when hasMatchStats is
    // false, regardless of isMatchProcessed.
    markMatchProcessed("stuck", STEAM1, "2026-01-01");
    expect(isMatchProcessed("stuck", STEAM1)).toBe(true);
    expect(hasMatchStats("stuck", STEAM1)).toBe(false);
  });
});

describe("link re-linking", () => {
  test("linking same steam to different discord replaces the original", () => {
    linkAccount("discord-1", STEAM1);
    const result = linkAccount("discord-2", STEAM1);
    expect(result.previousDiscordId).toBe("discord-1");
    expect(getSteamId("discord-1")).toBeNull();
    expect(getSteamId("discord-2")).toBe(STEAM1);
  });

  test("re-linking same discord updates steam and reports previous", () => {
    linkAccount("discord-1", STEAM1);
    const result = linkAccount("discord-1", STEAM2);
    expect(result.previousSteamId).toBe(STEAM1);
    expect(getSteamId("discord-1")).toBe(STEAM2);
  });
});

describe("opponent analysis tracking", () => {
  test("tracks analysed opponents", () => {
    expect(isOpponentAnalysed("m1", STEAM1)).toBe(false);
    markOpponentAnalysed("m1", STEAM1);
    expect(isOpponentAnalysed("m1", STEAM1)).toBe(true);
  });

  test("different match is not analysed", () => {
    markOpponentAnalysed("m1", STEAM1);
    expect(isOpponentAnalysed("m2", STEAM1)).toBe(false);
  });
});

describe("api usage tracking", () => {
  test("tracks and retrieves calls", () => {
    trackApiCall("leetify:/v3/profile");
    trackApiCall("leetify:/v3/profile");
    trackApiCall("leetify:/v2/matches");
    const usage = getApiUsageToday();
    const profile = usage.find((u) => u.endpoint === "leetify:/v3/profile");
    expect(profile).toBeDefined();
    expect(profile!.count).toBe(2);
  });
});

// ── /history ──

describe("getPlayerHistory", () => {
  test("returns empty for a steamId with no matches", () => {
    expect(getPlayerHistory(STEAM1, 10)).toEqual([]);
  });

  test("returns rows newest first and respects the limit", () => {
    seedMatches();
    // 4 matches were seeded with identical finished_at — SQLite's ORDER BY
    // is stable on match_id tiebreaker. We care here that LIMIT caps rows.
    const rows = getPlayerHistory(STEAM1, 2);
    expect(rows).toHaveLength(2);
  });

  test("premierDelta is the LAG difference over finished_at", () => {
    seedMatches();
    // Assign distinct timestamps so LAG can order them predictably.
    db.run("UPDATE matches SET finished_at = '2026-04-01' WHERE match_id = 'm1'");
    db.run("UPDATE matches SET finished_at = '2026-04-02' WHERE match_id = 'm2'");
    db.run("UPDATE matches SET finished_at = '2026-04-03' WHERE match_id = 'm3'");
    db.run("UPDATE matches SET finished_at = '2026-04-04' WHERE match_id = 'm4'");
    db.run(
      "UPDATE match_stats SET premier_after = 14000 WHERE match_id='m1' AND steam_id=?",
      [STEAM1],
    );
    db.run(
      "UPDATE match_stats SET premier_after = 14080 WHERE match_id='m2' AND steam_id=?",
      [STEAM1],
    );
    db.run(
      "UPDATE match_stats SET premier_after = 14040 WHERE match_id='m3' AND steam_id=?",
      [STEAM1],
    );
    db.run(
      "UPDATE match_stats SET premier_after = 14150 WHERE match_id='m4' AND steam_id=?",
      [STEAM1],
    );

    const rows = getPlayerHistory(STEAM1, 10);
    // Returned newest first.
    expect(rows.map((r) => r.matchId)).toEqual(["m4", "m3", "m2", "m1"]);
    expect(rows[0].premierDelta).toBe(110); // 14150 - 14040
    expect(rows[1].premierDelta).toBe(-40); // 14040 - 14080
    expect(rows[2].premierDelta).toBe(80); // 14080 - 14000
    expect(rows[3].premierDelta).toBeNull(); // no prior
  });
});

// ── Analyse logic ──

import { analyseStats } from "../src/analyse.js";

describe("analyse z-scores", () => {
  test("normal stats produce clean verdict", () => {
    const normal = makeMatch("normal", "de_dust2", 13, 10, [
      { steamId: STEAM1, team: 2, kills: 18, deaths: 16 },
    ]);
    const { score } = analyseStats(normal.stats);
    expect(score).toBeLessThan(4);
  });

  test("reaction time is in sane range", () => {
    const m = makeMatch("rt-test", "de_dust2", 13, 10, [
      { steamId: STEAM1, team: 2, kills: 18, deaths: 16 },
    ]);
    // Our test fixture has reaction_time: 0.5703 (seconds)
    // = 570ms, which is normal — should not flag
    const { checks } = analyseStats(m.stats);
    const rt = checks.find((c) => c.name === "Reaction time");
    expect(rt).toBeDefined();
    expect(rt!.value).toContain("ms");
    expect(rt!.flagged).toBe(false);
  });

  test("extreme stats produce high score", () => {
    // Fabricate a cheater's stats
    const cheater = makeMatch("cheat", "de_dust2", 16, 0, [
      { steamId: STEAM1, team: 2, kills: 40, deaths: 3 },
    ]);
    // Override the raw stats to be extreme
    const s = cheater.stats[0];
    s.accuracy_head = 0.75;
    s.accuracy_enemy_spotted = 0.6;
    s.kd_ratio = 13.3;
    s.dpr = 150;
    s.reaction_time = 0.1;
    const { score } = analyseStats([s]);
    expect(score).toBeGreaterThan(4);
  });
});

// ── Carry ──

import { getCarryStats, getTeamCarryStats } from "../src/store.js";

function makeCarryMatch(
  id: string,
  finishedAt: string,
  t1Score: number,
  t2Score: number,
  players: { steamId: string; team: number; lr: number }[],
): LeetifyMatchDetails {
  const base = makeMatch(
    id,
    "de_dust2",
    t1Score,
    t2Score,
    players.map((p) => ({ steamId: p.steamId, team: p.team, kills: 10, deaths: 10 })),
  );
  base.finished_at = finishedAt;
  for (let i = 0; i < base.stats.length; i++) {
    const s = base.stats[i]!;
    const lr = players[i]!.lr;
    s.leetify_rating = lr;
    s.ct_leetify_rating = lr;
    s.t_leetify_rating = lr;
    s.rounds_won = players[i]!.team === 2 ? t1Score : t2Score;
    s.rounds_lost = players[i]!.team === 2 ? t2Score : t1Score;
  }
  return base;
}

describe("carry attribution", () => {
  const JOM = "76561198000000010";
  const DONG = "76561198000000011";
  const CHAR = "76561198000000012";
  const E1 = "76561198000000013";
  const E2 = "76561198000000014";

  test("overperformer on a winning team carries", () => {
    // JOM+DONG team wins, DONG played great, CHAR was average.
    saveMatchDetails(
      makeCarryMatch("m1", "2026-01-01T00:00:00Z", 13, 7, [
        { steamId: JOM, team: 2, lr: 0.0 },
        { steamId: DONG, team: 2, lr: 0.1 }, // overperformer
        { steamId: CHAR, team: 2, lr: 0.0 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    const rows = getCarryStats(JOM);
    const dong = rows.find((r) => r.teammateSteamId === DONG);
    const char = rows.find((r) => r.teammateSteamId === CHAR);
    expect(dong!.proxyScore).toBeGreaterThan(0);
    expect(char!.proxyScore).toBeLessThan(0); // slightly below team mean
  });

  test("underperformer on a losing team gets negative carry", () => {
    // Team loses; DONG played badly, JOM carried the losing side.
    saveMatchDetails(
      makeCarryMatch("m1", "2026-01-02T00:00:00Z", 7, 13, [
        { steamId: JOM, team: 2, lr: 0.1 }, // tried hard
        { steamId: DONG, team: 2, lr: -0.1 }, // dragged
        { steamId: CHAR, team: 2, lr: 0.0 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    const rows = getCarryStats(JOM);
    const dong = rows.find((r) => r.teammateSteamId === DONG);
    // Underperformer in a loss → negative, not positive (the trap we avoid).
    expect(dong!.proxyScore).toBeLessThan(0);
  });

  test("ties count at half weight", () => {
    saveMatchDetails(
      makeCarryMatch("m1", "2026-01-03T00:00:00Z", 12, 12, [
        { steamId: JOM, team: 2, lr: 0.0 },
        { steamId: DONG, team: 2, lr: 0.2 },
        { steamId: CHAR, team: 2, lr: 0.0 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    const rows = getCarryStats(JOM);
    const dong = rows.find((r) => r.teammateSteamId === DONG)!;
    // Dong overperf ≈ 0.133, weight = 0.5 → score ≈ 0.067 (half of
    // what a decisive result would have produced).
    expect(dong.proxyScore).toBeGreaterThan(0);
    expect(dong.proxyScore).toBeCloseTo(0.067, 2);
  });

  test("premier delta uses magnitude, not signed value", () => {
    // JOM's team loses m1, wins m2. DONG underperforms both times.
    saveMatchDetails(
      makeCarryMatch("m1", "2026-01-01T00:00:00Z", 7, 13, [
        { steamId: JOM, team: 2, lr: 0.05 },
        { steamId: DONG, team: 2, lr: -0.05 },
        { steamId: CHAR, team: 2, lr: 0.0 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    saveMatchDetails(
      makeCarryMatch("m2", "2026-01-02T00:00:00Z", 13, 7, [
        { steamId: JOM, team: 2, lr: 0.05 },
        { steamId: DONG, team: 2, lr: -0.05 },
        { steamId: CHAR, team: 2, lr: 0.0 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    // Simulate JOM's premier swinging -60 then +60.
    db.run(
      "UPDATE match_stats SET premier_after = 14940 WHERE steam_id=? AND match_id=?",
      [JOM, "m1"],
    );
    db.run(
      "UPDATE match_stats SET premier_after = 15000 WHERE steam_id=? AND match_id=?",
      [JOM, "m2"],
    );
    // LAG needs a prior row to produce a delta for m1; we only test m2 here
    // (prev = m1's 14940, curr = m2's 15000 → +60).
    const rows = getCarryStats(JOM);
    const dong = rows.find((r) => r.teammateSteamId === DONG);
    // DONG underperformed (negative overperf) × |+60| = negative.
    expect(dong!.premierScore).toBeLessThan(0);
  });

  test("premierNetDelta is the signed sum of viewer's ΔPremier per teammate", () => {
    // Two matches; DONG on JOM's team both times. JOM nets +60 then
    // loses 40. DONG's premierNetDelta should be +60 - 40 = +20.
    saveMatchDetails(
      makeCarryMatch("m1", "2026-01-01T00:00:00Z", 13, 7, [
        { steamId: JOM, team: 2, lr: 0.0 },
        { steamId: DONG, team: 2, lr: 0.05 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    saveMatchDetails(
      makeCarryMatch("m2", "2026-01-02T00:00:00Z", 7, 13, [
        { steamId: JOM, team: 2, lr: 0.0 },
        { steamId: DONG, team: 2, lr: -0.02 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    db.run(
      "UPDATE match_stats SET premier_after = 14940 WHERE steam_id=? AND match_id=?",
      [JOM, "m1"],
    );
    db.run(
      "UPDATE match_stats SET premier_after = 15000 WHERE steam_id=? AND match_id=?",
      [JOM, "m2"],
    );
    // LAG gives m2 a delta of +60. m1 has no prior so null. Net = +60.
    const rows = getCarryStats(JOM);
    const dong = rows.find((r) => r.teammateSteamId === DONG);
    expect(dong!.premierNetDelta).toBe(60);
    expect(dong!.premierSamples).toBe(1);
  });

  test("team carry aggregates per player", () => {
    saveMatchDetails(
      makeCarryMatch("m1", "2026-01-01T00:00:00Z", 13, 7, [
        { steamId: JOM, team: 2, lr: -0.05 },
        { steamId: DONG, team: 2, lr: 0.1 },
        { steamId: CHAR, team: 2, lr: 0.0 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    saveMatchDetails(
      makeCarryMatch("m2", "2026-01-02T00:00:00Z", 13, 10, [
        { steamId: JOM, team: 2, lr: 0.0 },
        { steamId: DONG, team: 2, lr: 0.08 },
        { steamId: CHAR, team: 2, lr: -0.05 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    saveMatchDetails(
      makeCarryMatch("m3", "2026-01-03T00:00:00Z", 7, 13, [
        { steamId: JOM, team: 2, lr: 0.0 },
        { steamId: DONG, team: 2, lr: 0.1 },
        { steamId: CHAR, team: 2, lr: -0.1 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    const ranks = getTeamCarryStats([JOM, DONG, CHAR]);
    const dong = ranks.find((r) => r.steamId === DONG);
    expect(dong!.proxyScore).toBeGreaterThan(0);
    expect(ranks[0]!.steamId).toBe(DONG);
  });

  test("sharedMatches reports unique matches, not pair-occurrences", () => {
    // Three tracked players on the same team in all three matches.
    // The old (buggy) code summed per-viewer counts, so each player
    // showed sharedMatches = 2 per match × 3 matches = 6. The correct
    // value is 3 — distinct match ids each player was in.
    saveMatchDetails(
      makeCarryMatch("m1", "2026-01-01T00:00:00Z", 13, 7, [
        { steamId: JOM, team: 2, lr: 0 },
        { steamId: DONG, team: 2, lr: 0 },
        { steamId: CHAR, team: 2, lr: 0 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    saveMatchDetails(
      makeCarryMatch("m2", "2026-01-02T00:00:00Z", 13, 7, [
        { steamId: JOM, team: 2, lr: 0 },
        { steamId: DONG, team: 2, lr: 0 },
        { steamId: CHAR, team: 2, lr: 0 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    saveMatchDetails(
      makeCarryMatch("m3", "2026-01-03T00:00:00Z", 13, 7, [
        { steamId: JOM, team: 2, lr: 0 },
        { steamId: DONG, team: 2, lr: 0 },
        { steamId: CHAR, team: 2, lr: 0 },
        { steamId: E1, team: 3, lr: 0 },
        { steamId: E2, team: 3, lr: 0 },
      ]),
    );
    const ranks = getTeamCarryStats([JOM, DONG, CHAR]);
    for (const r of ranks) expect(r.sharedMatches).toBe(3);
  });
});

// ── /best ──

describe("getBestMatch", () => {
  function seedRecent() {
    // seedMatches() hardcodes finished_at to 2026-01-01. Our /best
    // window queries "now − N days", so rewrite finished_at to today
    // after seeding so the rows fall inside any test window.
    seedMatches();
    db.run("UPDATE matches SET finished_at = datetime('now')");
  }

  test("returns null when no matches in window", () => {
    seedMatches(); // leaves 2026-01-01 timestamps
    expect(getBestMatch([STEAM1, STEAM2], "rating", 7)).toBeNull();
  });

  test("returns null when no tracked players", () => {
    expect(getBestMatch([], "kills", 30)).toBeNull();
  });

  test("picks match with highest kills among tracked players", () => {
    seedRecent();
    // STEAM1 kills: m1=20, m2=15, m3=22, m4=10 → m3 wins
    const best = getBestMatch([STEAM1], "kills", 30);
    expect(best?.matchId).toBe("m3");
    expect(best?.statValue).toBe(22);
    expect(best?.name).toBe("Player_0001");
  });

  test("picks best across multiple tracked players", () => {
    seedRecent();
    // STEAM2 kills: m1=18, m2=12, m3=19, m4=14
    // STEAM1 best=22, STEAM2 best=19 → STEAM1's m3
    const best = getBestMatch([STEAM1, STEAM2], "kills", 30);
    expect(best?.steamId).toBe(STEAM1);
    expect(best?.statValue).toBe(22);
  });

  test("respects the days window", () => {
    seedMatches(); // all at 2026-01-01
    db.run("UPDATE matches SET finished_at = datetime('now', '-200 days')");
    expect(getBestMatch([STEAM1], "kills", 30)).toBeNull();
    expect(getBestMatch([STEAM1], "kills", 365)?.matchId).toBe("m3");
  });

  test("rating stat picks highest leetify_rating", () => {
    seedRecent();
    // All seeded matches share leetify_rating=0.05 → tiebreak by
    // finished_at DESC. All tie on time too, so just check it returns
    // a match with the expected rating.
    const best = getBestMatch([STEAM1], "rating", 30);
    expect(best?.rating).toBeCloseTo(0.05, 2);
  });

  test("multikill stat orders lexicographically by tier", () => {
    seedRecent();
    // Boost m2's multikills so it's the single best despite kills=15
    db.run("UPDATE match_stats SET multi5k = 1 WHERE match_id = 'm2' AND steam_id = ?", [
      STEAM1,
    ]);
    const best = getBestMatch([STEAM1], "multikill", 30);
    expect(best?.matchId).toBe("m2");
    expect(best?.multi5k).toBe(1);
  });

  test("positioning is derived from rounds_count - deaths", () => {
    seedRecent();
    // STEAM1 deaths: m1=15, m2=18, m3=14, m4=20; all rounds_count=25
    // Survival%: m1=40, m2=28, m3=44, m4=20 → m3 wins
    const best = getBestMatch([STEAM1], "positioning", 30);
    expect(best?.matchId).toBe("m3");
  });
});

// ── /suspects ──

import { getEncounters } from "../src/store.js";

describe("getEncounters", () => {
  const TARGET = "76561198000000100";
  const MATE = "76561198000000101";
  const FOE = "76561198000000102";

  test("empty for a player with no matches", () => {
    expect(getEncounters(TARGET, 7)).toEqual([]);
  });

  test("returns teammates with 'with' and opponents with 'against'", () => {
    saveMatchDetails(
      makeMatch("enc-1", "de_dust2", 13, 7, [
        { steamId: TARGET, team: 2, kills: 20, deaths: 15 },
        { steamId: MATE, team: 2, kills: 18, deaths: 12 },
        { steamId: FOE, team: 3, kills: 10, deaths: 20 },
      ]),
    );
    // seeded finished_at is 2026-01-01; push into the window.
    db.run("UPDATE matches SET finished_at = datetime('now')");

    const rows = getEncounters(TARGET, 7);
    expect(rows).toHaveLength(2);

    const mate = rows.find((r) => r.otherSteamId === MATE);
    const foe = rows.find((r) => r.otherSteamId === FOE);
    expect(mate?.relationship).toBe("with");
    expect(foe?.relationship).toBe("against");
    expect(mate?.matchId).toBe("enc-1");
    expect(mate?.otherName).toBe("Player_0101");
  });

  test("respects the days window", () => {
    saveMatchDetails(
      makeMatch("old", "de_dust2", 13, 7, [
        { steamId: TARGET, team: 2, kills: 20, deaths: 15 },
        { steamId: MATE, team: 2, kills: 18, deaths: 12 },
      ]),
    );
    db.run("UPDATE matches SET finished_at = datetime('now', '-30 days')");
    expect(getEncounters(TARGET, 7)).toHaveLength(0);
    expect(getEncounters(TARGET, 60)).toHaveLength(1);
  });

  test("one row per (match, other player)", () => {
    saveMatchDetails(
      makeMatch("enc-1", "de_dust2", 13, 7, [
        { steamId: TARGET, team: 2, kills: 20, deaths: 15 },
        { steamId: MATE, team: 2, kills: 18, deaths: 12 },
      ]),
    );
    saveMatchDetails(
      makeMatch("enc-2", "de_mirage", 13, 7, [
        { steamId: TARGET, team: 2, kills: 20, deaths: 15 },
        { steamId: MATE, team: 3, kills: 18, deaths: 12 },
      ]),
    );
    db.run("UPDATE matches SET finished_at = datetime('now')");

    const rows = getEncounters(TARGET, 7).filter((r) => r.otherSteamId === MATE);
    expect(rows).toHaveLength(2);
    const relations = rows.map((r) => r.relationship).sort();
    expect(relations).toEqual(["against", "with"]);
  });

  test("surfaces a sus-looking player across their recent history", () => {
    // Seed one encounter match between TARGET and a cheater-like FOE.
    saveMatchDetails(
      makeMatch("enc-cheat", "de_dust2", 13, 7, [
        { steamId: TARGET, team: 2, kills: 18, deaths: 16 },
        { steamId: FOE, team: 3, kills: 40, deaths: 3 },
      ]),
    );
    // Seed 12 extra FOE-only matches with inhuman stats so analyseStats
    // has >= MIN_MATCHES_FOR_ANALYSIS samples and flags them convincingly.
    for (let i = 0; i < 12; i++) {
      const m = makeMatch(`cheat-${i}`, "de_dust2", 16, 3, [
        { steamId: FOE, team: 2, kills: 38, deaths: 4 },
      ]);
      const s = m.stats[0]!;
      s.accuracy_head = 0.72;
      s.accuracy_enemy_spotted = 0.55;
      s.kd_ratio = 9.5;
      s.dpr = 145;
      s.reaction_time = 0.15;
      saveMatchDetails(m);
    }
    db.run("UPDATE matches SET finished_at = datetime('now')");

    // Target's only encounter is with FOE — confirm the store helper
    // surfaces that encounter, which /suspects then runs analyseStats on.
    const encounters = getEncounters(TARGET, 7);
    expect(encounters.map((e) => e.otherSteamId)).toContain(FOE);

    const foeHistory = getPlayerMatchStats(FOE, 30);
    expect(foeHistory.length).toBeGreaterThanOrEqual(10);
    const { score } = analyseStats(foeHistory.map((m) => m.raw));
    expect(score).toBeGreaterThanOrEqual(4);
  });
});
