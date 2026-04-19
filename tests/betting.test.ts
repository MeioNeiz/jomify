import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  BAD_GAME_RATING,
  MATCH_GRANT_BASE,
  MATCH_GRANT_PER_TEAMMATE,
  MATCH_GRANT_WIN_BONUS,
  PENALTY_BAD_GAME,
  PENALTY_LOSS_STREAK,
  PENALTY_TEAM_FLASH,
  STARTING_BALANCE,
} from "../src/betting/config.js";
import db from "../src/betting/db.js";
import { computeMatchDelta } from "../src/betting/listeners/cs-match-completed.js";
import { accounts, bets, ledger, wagers, weeklyWins } from "../src/betting/schema.js";
import {
  adjustBalance,
  createBet,
  getAllTimeWins,
  getBalance,
  getBet,
  getCurrentStandings,
  getRecentLedger,
  getWagersForBet,
  listOpenBets,
  placeWager,
  resolveBet,
} from "../src/betting/store.js";
import type { EventMap } from "../src/events.js";

const GUILD = "bet-guild";
const STEAM_A = "76561198000000001";
const STEAM_B = "76561198000000002";
const STEAM_C = "76561198000000003";
const STEAM_D = "76561198000000004";
const CREATOR_DISCORD = "100000000000000001";

// Sum of every ledger delta for a steamId. Invariant: should equal the
// accounts.balance row for that steamId.
function ledgerSum(steamId: string): number {
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${ledger.delta}), 0)` })
    .from(ledger)
    .where(sql`${ledger.steamId} = ${steamId}`)
    .get();
  return row?.total ?? 0;
}

beforeEach(() => {
  // Drizzle's delete is fine against the in-memory DB — keeps the tests
  // schema-aware rather than hard-coding raw SQL.
  db.delete(wagers).run();
  db.delete(ledger).run();
  db.delete(bets).run();
  db.delete(accounts).run();
  db.delete(weeklyWins).run();
});

describe("accounts — adjustBalance + getBalance", () => {
  test("first call lazy-creates account with starting balance + starting-grant row", () => {
    // Positive delta triggers the lazy create path on a fresh wallet.
    const next = adjustBalance(STEAM_A, 3, "match", "m-1");
    expect(next).toBe(STARTING_BALANCE + 3);
    expect(getBalance(STEAM_A)).toBe(STARTING_BALANCE + 3);

    const rows = getRecentLedger(STEAM_A, 10);
    // Oldest row is the starting grant, newest is the adjustment.
    expect(rows.map((r) => r.reason)).toEqual(["match", "starting-grant"]);
    expect(rows.map((r) => r.delta)).toEqual([3, STARTING_BALANCE]);
  });

  test("positive delta adds to balance with matching ledger row", () => {
    adjustBalance(STEAM_A, 0, "seed"); // lazy-create only, delta=0 after seed
    // After seed: balance = STARTING_BALANCE, ledger has only starting-grant.
    expect(getBalance(STEAM_A)).toBe(STARTING_BALANCE);

    adjustBalance(STEAM_A, 7, "bonus");
    expect(getBalance(STEAM_A)).toBe(STARTING_BALANCE + 7);
    const rows = getRecentLedger(STEAM_A, 10);
    expect(rows[0]?.delta).toBe(7);
    expect(rows[0]?.reason).toBe("bonus");
  });

  test("negative delta within balance decreases balance, writes that delta", () => {
    adjustBalance(STEAM_A, 10, "grant"); // balance = STARTING_BALANCE + 10
    const balBefore = getBalance(STEAM_A);
    adjustBalance(STEAM_A, -4, "debit");
    expect(getBalance(STEAM_A)).toBe(balBefore - 4);
    const rows = getRecentLedger(STEAM_A, 10);
    expect(rows[0]?.delta).toBe(-4);
    expect(rows[0]?.reason).toBe("debit");
  });

  test("negative delta below zero clamps to -current; ledger reflects clamped delta", () => {
    // Fresh wallet: STARTING_BALANCE on lazy create. Request -100 → clamp to -STARTING_BALANCE.
    adjustBalance(STEAM_A, -100, "penalty");
    expect(getBalance(STEAM_A)).toBe(0);
    const rows = getRecentLedger(STEAM_A, 10);
    // Newest row is the penalty, and its delta is the *clamped* value.
    expect(rows[0]?.delta).toBe(-STARTING_BALANCE);
    expect(rows[0]?.reason).toBe("penalty");
  });

  test("clamped to 0 no-op: no ledger row when effectiveDelta is 0", () => {
    adjustBalance(STEAM_A, -100, "penalty"); // balance -> 0
    const rowsBefore = getRecentLedger(STEAM_A, 10).length;
    adjustBalance(STEAM_A, -5, "penalty-again"); // already 0, clamp is 0, no-op
    const rowsAfter = getRecentLedger(STEAM_A, 10).length;
    expect(rowsAfter).toBe(rowsBefore);
    expect(getBalance(STEAM_A)).toBe(0);
  });

  test("invariant: sum of ledger deltas equals current balance", () => {
    adjustBalance(STEAM_A, 5, "a");
    adjustBalance(STEAM_A, -3, "b");
    adjustBalance(STEAM_A, 100, "c");
    adjustBalance(STEAM_A, -200, "d"); // clamped
    adjustBalance(STEAM_A, 2, "e");
    expect(ledgerSum(STEAM_A)).toBe(getBalance(STEAM_A));
  });
});

describe("bets — createBet + getBet + listOpenBets + resolveBet", () => {
  test("createBet returns integer id; getBet returns persisted shape", () => {
    const id = createBet(GUILD, CREATOR_DISCORD, "Will it rain?");
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThan(0);

    const bet = getBet(id);
    expect(bet).not.toBeNull();
    expect(bet?.id).toBe(id);
    expect(bet?.guildId).toBe(GUILD);
    expect(bet?.creatorDiscordId).toBe(CREATOR_DISCORD);
    expect(bet?.question).toBe("Will it rain?");
    expect(bet?.status).toBe("open");
    expect(bet?.winningOutcome).toBeNull();
    expect(bet?.resolvedAt).toBeNull();
  });

  test("listOpenBets filters by guildId + status=open, newest first", () => {
    // Two open in GUILD, one open in other-guild, one resolved in GUILD.
    // Explicit created_at so the newest-first assertion is deterministic.
    db.run(sql`
      INSERT INTO bets (guild_id, question, creator_discord_id, status, created_at)
      VALUES (${GUILD}, 'old', ${CREATOR_DISCORD}, 'open', '2026-01-01 10:00:00')
    `);
    db.run(sql`
      INSERT INTO bets (guild_id, question, creator_discord_id, status, created_at)
      VALUES (${GUILD}, 'new', ${CREATOR_DISCORD}, 'open', '2026-02-01 10:00:00')
    `);
    db.run(sql`
      INSERT INTO bets (guild_id, question, creator_discord_id, status, created_at)
      VALUES (${GUILD}, 'done', ${CREATOR_DISCORD}, 'resolved', '2026-02-05 10:00:00')
    `);
    db.run(sql`
      INSERT INTO bets (guild_id, question, creator_discord_id, status, created_at)
      VALUES ('other', 'elsewhere', ${CREATOR_DISCORD}, 'open', '2026-02-10 10:00:00')
    `);

    const open = listOpenBets(GUILD);
    expect(open.map((b) => b.question)).toEqual(["new", "old"]);
  });

  test("resolveBet rejects unknown bet id", () => {
    expect(() => resolveBet(9999, "yes")).toThrow(/does not exist/);
  });

  test("resolveBet rejects already-resolved bet", () => {
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, STEAM_A, "yes", 1);
    resolveBet(id, "yes");
    expect(() => resolveBet(id, "yes")).toThrow(/not open/);
  });

  test("pari-mutuel payout: winners split losers' pool proportionally (floor)", () => {
    // Seed balances large enough to cover the stakes.
    adjustBalance(STEAM_A, 95, "seed"); // balance 100
    adjustBalance(STEAM_B, 95, "seed"); // balance 100
    adjustBalance(STEAM_C, 95, "seed"); // balance 100

    const id = createBet(GUILD, CREATOR_DISCORD, "Split?");
    placeWager(id, STEAM_A, "yes", 10); // winner
    placeWager(id, STEAM_B, "yes", 20); // winner
    placeWager(id, STEAM_C, "no", 15); // loser

    const balBeforeA = getBalance(STEAM_A); // 90
    const balBeforeB = getBalance(STEAM_B); // 80
    const balBeforeC = getBalance(STEAM_C); // 85

    resolveBet(id, "yes");

    // winnerPool=30, loserPool=15. A: 10 + floor(10*15/30) = 10+5 = 15.
    // B: 20 + floor(20*15/30) = 20+10 = 30.
    expect(getBalance(STEAM_A)).toBe(balBeforeA + 15);
    expect(getBalance(STEAM_B)).toBe(balBeforeB + 30);
    expect(getBalance(STEAM_C)).toBe(balBeforeC); // loser: no refund

    // Bet marked resolved with the winning outcome.
    const bet = getBet(id);
    expect(bet?.status).toBe("resolved");
    expect(bet?.winningOutcome).toBe("yes");
    expect(bet?.resolvedAt).not.toBeNull();
  });

  test("no winners: losers refunded to pre-wager balance, bet-refund row written", () => {
    adjustBalance(STEAM_A, 95, "seed"); // 100
    adjustBalance(STEAM_B, 95, "seed"); // 100
    const preA = getBalance(STEAM_A);
    const preB = getBalance(STEAM_B);

    const id = createBet(GUILD, CREATOR_DISCORD, "Lopsided");
    placeWager(id, STEAM_A, "no", 30);
    placeWager(id, STEAM_B, "no", 40);
    // Nobody picked yes — resolving yes means both losers refund.
    resolveBet(id, "yes");

    expect(getBalance(STEAM_A)).toBe(preA);
    expect(getBalance(STEAM_B)).toBe(preB);

    const aRows = getRecentLedger(STEAM_A, 10);
    expect(aRows[0]?.reason).toBe("bet-refund");
    expect(aRows[0]?.delta).toBe(30);
    const bRows = getRecentLedger(STEAM_B, 10);
    expect(bRows[0]?.reason).toBe("bet-refund");
    expect(bRows[0]?.delta).toBe(40);
  });
});

describe("wagers — placeWager + getWagersForBet", () => {
  test("placeWager deducts balance + inserts wager + ledger row atomically", () => {
    adjustBalance(STEAM_A, 20, "seed"); // balance = STARTING_BALANCE + 20
    const before = getBalance(STEAM_A);
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, STEAM_A, "yes", 7);

    expect(getBalance(STEAM_A)).toBe(before - 7);
    const ws = getWagersForBet(id);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({
      betId: id,
      steamId: STEAM_A,
      outcome: "yes",
      amount: 7,
    });
    const rows = getRecentLedger(STEAM_A, 10);
    expect(rows[0]?.reason).toBe("bet-placed");
    expect(rows[0]?.delta).toBe(-7);
    expect(rows[0]?.ref).toBe(String(id));
  });

  test("rejects amount <= 0", () => {
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    expect(() => placeWager(id, STEAM_A, "yes", 0)).toThrow(/positive/);
    expect(() => placeWager(id, STEAM_A, "yes", -5)).toThrow(/positive/);
  });

  test("rejects closed bet", () => {
    adjustBalance(STEAM_A, 20, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, STEAM_A, "yes", 1);
    resolveBet(id, "yes");
    expect(() => placeWager(id, STEAM_B, "no", 1)).toThrow(/not open/);
  });

  test("rejects double-wager by same steamId on same bet", () => {
    adjustBalance(STEAM_A, 20, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, STEAM_A, "yes", 3);
    expect(() => placeWager(id, STEAM_A, "no", 2)).toThrow(/already wagered/);
  });

  test("rejects insufficient balance (explicit throw, not clamp)", () => {
    // Fresh wallet: STARTING_BALANCE only. 100 > STARTING_BALANCE.
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    expect(() => placeWager(id, STEAM_A, "yes", 100)).toThrow(/Insufficient balance/);
    // Ensure nothing was persisted — the rollback should leave no wager
    // and no bet-placed ledger row behind.
    expect(getWagersForBet(id)).toHaveLength(0);
    const rows = getRecentLedger(STEAM_A, 10);
    expect(rows.some((r) => r.reason === "bet-placed")).toBe(false);
  });

  test("getWagersForBet returns all wagers on the bet", () => {
    adjustBalance(STEAM_A, 20, "seed");
    adjustBalance(STEAM_B, 20, "seed");
    adjustBalance(STEAM_C, 20, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, STEAM_A, "yes", 1);
    placeWager(id, STEAM_B, "no", 2);
    placeWager(id, STEAM_C, "yes", 3);
    const ws = getWagersForBet(id);
    expect(ws).toHaveLength(3);
    expect(ws.map((w) => w.steamId).sort()).toEqual([STEAM_A, STEAM_B, STEAM_C].sort());
  });
});

describe("leaderboard — getCurrentStandings + getAllTimeWins", () => {
  test("getCurrentStandings sorts by balance desc, limits to N", () => {
    adjustBalance(STEAM_A, 10, "seed"); // STARTING + 10
    adjustBalance(STEAM_B, 50, "seed"); // STARTING + 50
    adjustBalance(STEAM_C, 30, "seed"); // STARTING + 30
    adjustBalance(STEAM_D, 20, "seed"); // STARTING + 20

    const top2 = getCurrentStandings(2);
    expect(top2).toHaveLength(2);
    expect(top2[0]?.steamId).toBe(STEAM_B);
    expect(top2[1]?.steamId).toBe(STEAM_C);
    expect(top2[0]?.balance).toBeGreaterThan(top2[1]?.balance ?? 0);
  });

  test("getAllTimeWins counts rank=1 rows per steamId, desc by count", () => {
    db.insert(weeklyWins)
      .values([
        { weekEnding: "2026-01-05", steamId: STEAM_A, rank: 1, balanceSnapshot: 100 },
        { weekEnding: "2026-01-05", steamId: STEAM_B, rank: 2, balanceSnapshot: 90 },
        { weekEnding: "2026-01-12", steamId: STEAM_A, rank: 1, balanceSnapshot: 80 },
        { weekEnding: "2026-01-12", steamId: STEAM_C, rank: 2, balanceSnapshot: 70 },
        { weekEnding: "2026-01-19", steamId: STEAM_B, rank: 1, balanceSnapshot: 60 },
        { weekEnding: "2026-01-19", steamId: STEAM_A, rank: 1, balanceSnapshot: 55 },
      ])
      .run();
    // Note: the 2026-01-19 row for STEAM_A is also rank=1 — two winners
    // same week is not realistic, but the tally is just COUNT(rank=1).
    const rows = getAllTimeWins(10);
    // STEAM_A has 3 rank=1 rows, STEAM_B has 1.
    expect(rows[0]).toEqual({ steamId: STEAM_A, weeksWon: 3 });
    expect(rows[1]).toEqual({ steamId: STEAM_B, weeksWon: 1 });
    // STEAM_C never hit rank=1, so excluded entirely.
    expect(rows.find((r) => r.steamId === STEAM_C)).toBeUndefined();
  });
});

describe("computeMatchDelta", () => {
  // Minimal payload factory. Defaults to a clean solo loss; each test
  // overrides the axis it cares about.
  type Event = EventMap["cs:match-completed"];
  function makeEvent(override: Partial<Event> = {}): Event {
    return {
      matchId: "m-1",
      steamId: STEAM_A,
      discordId: null,
      rating: 0,
      outcome: "loss",
      premierDelta: null,
      trackedTeammates: [],
      mapName: "de_dust2",
      finishedAt: "2026-04-19T00:00:00Z",
      stats: {
        flashbangHitFriend: 0,
        heFriendsDamageAvg: 0,
        shotsHitFriend: 0,
        shotsHitFriendHead: 0,
        streakType: "win",
        streakCount: 0,
      },
      ...override,
    };
  }

  test("solo loss yields BASE only", () => {
    expect(computeMatchDelta(makeEvent({ outcome: "loss", rating: 0.05 }))).toBe(
      MATCH_GRANT_BASE,
    );
  });

  test("solo win yields BASE + WIN_BONUS", () => {
    expect(computeMatchDelta(makeEvent({ outcome: "win", rating: 0.05 }))).toBe(
      MATCH_GRANT_BASE + MATCH_GRANT_WIN_BONUS,
    );
  });

  test("3 tracked teammates + win yields BASE + 3*PER_TEAMMATE + WIN_BONUS", () => {
    const e = makeEvent({
      outcome: "win",
      rating: 0.05,
      trackedTeammates: [STEAM_B, STEAM_C, STEAM_D],
    });
    expect(computeMatchDelta(e)).toBe(
      MATCH_GRANT_BASE + 3 * MATCH_GRANT_PER_TEAMMATE + MATCH_GRANT_WIN_BONUS,
    );
  });

  test("bad rating (<= BAD_GAME_RATING) subtracts PENALTY_BAD_GAME", () => {
    const good = makeEvent({ outcome: "loss", rating: 0.05 });
    const bad = makeEvent({ outcome: "loss", rating: BAD_GAME_RATING });
    expect(computeMatchDelta(bad)).toBe(computeMatchDelta(good) - PENALTY_BAD_GAME);
  });

  test("team flash >= threshold subtracts PENALTY_TEAM_FLASH", () => {
    const clean = makeEvent({ rating: 0.05 });
    const flashy = makeEvent({
      rating: 0.05,
      stats: {
        flashbangHitFriend: 10,
        heFriendsDamageAvg: 0,
        shotsHitFriend: 0,
        shotsHitFriendHead: 0,
        streakType: "win",
        streakCount: 0,
      },
    });
    expect(computeMatchDelta(flashy)).toBe(computeMatchDelta(clean) - PENALTY_TEAM_FLASH);
  });

  test("loss streak >= threshold subtracts PENALTY_LOSS_STREAK", () => {
    const clean = makeEvent({ rating: 0.05 });
    const losing = makeEvent({
      rating: 0.05,
      stats: {
        flashbangHitFriend: 0,
        heFriendsDamageAvg: 0,
        shotsHitFriend: 0,
        shotsHitFriendHead: 0,
        streakType: "loss",
        streakCount: 5,
      },
    });
    expect(computeMatchDelta(losing)).toBe(
      computeMatchDelta(clean) - PENALTY_LOSS_STREAK,
    );
  });

  test("null stats: stat-based penalties skipped; BASE + teammates + win + rating apply", () => {
    // Rating branch doesn't depend on stats, so a bad-rated null-stats
    // match still takes the rating penalty.
    const e = makeEvent({
      outcome: "win",
      rating: BAD_GAME_RATING,
      trackedTeammates: [STEAM_B],
      stats: null,
    });
    // BASE + 1*PER_TEAMMATE + WIN_BONUS - PENALTY_BAD_GAME
    expect(computeMatchDelta(e)).toBe(
      MATCH_GRANT_BASE +
        MATCH_GRANT_PER_TEAMMATE +
        MATCH_GRANT_WIN_BONUS -
        PENALTY_BAD_GAME,
    );
  });

  test("grief match (all penalties firing, solo loss) nets negative", () => {
    const e = makeEvent({
      outcome: "loss",
      rating: BAD_GAME_RATING - 0.1,
      trackedTeammates: [],
      stats: {
        flashbangHitFriend: 99,
        heFriendsDamageAvg: 999,
        shotsHitFriend: 99,
        shotsHitFriendHead: 99,
        streakType: "loss",
        streakCount: 99,
      },
    });
    // BASE alone is +1; all five stat/rating penalties fire and comfortably
    // exceed it, so the delta is negative.
    expect(computeMatchDelta(e)).toBeLessThan(0);
  });
});
