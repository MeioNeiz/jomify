import { beforeEach, describe, expect, test } from "bun:test";
import db from "../src/db.js";
import type { LeetifyMatchDetails } from "../src/leetify/types.js";
import {
  getAllGuildIds,
  getApiUsageToday,
  getHeadToHead,
  getPlayerMapStats,
  getPlayerMatchStats,
  getPlayerStatAverages,
  getPlayerStreak,
  getProcessedMatchCount,
  getSteamId,
  getStoredMatchCount,
  getTeamMapStats,
  getWeekAgoLeaderboard,
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
    expect(avgs!.avg_flash_enemies).toBeDefined();
    expect(avgs!.avg_he_damage).toBeDefined();
    expect(avgs!.avg_util_on_death).toBeDefined();
  });

  test("no matches returns zeroes", () => {
    const avgs = getPlayerStatAverages("nobody");
    expect(avgs).not.toBeNull();
    expect(avgs!.match_count).toBe(0);
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
