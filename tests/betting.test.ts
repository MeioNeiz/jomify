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
  cancelBet,
  createBet,
  ensureAccount,
  getAllTimeWins,
  getBalance,
  getBet,
  getCurrentStandings,
  getExpiredOpenBets,
  getRecentLedger,
  getWagersForBet,
  listOpenBets,
  placeWager,
  resolveBet,
} from "../src/betting/store.js";
import type { EventMap } from "../src/events.js";

const GUILD = "bet-guild";
const DISCORD_A = "100000000000000001";
const DISCORD_B = "100000000000000002";
const DISCORD_C = "100000000000000003";
const DISCORD_D = "100000000000000004";
const CREATOR_DISCORD = "100000000000000099";
const STEAM_A = "76561198000000001";

// Sum of every ledger delta for a discordId. Invariant: should equal the
// accounts.balance row for that discordId.
function ledgerSum(discordId: string): number {
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${ledger.delta}), 0)` })
    .from(ledger)
    .where(sql`${ledger.discordId} = ${discordId}`)
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

describe("accounts — adjustBalance + getBalance + ensureAccount", () => {
  test("first call lazy-creates account with starting balance + starting-grant row", () => {
    // Positive delta triggers the lazy create path on a fresh wallet.
    const next = adjustBalance(DISCORD_A, 3, "match", "m-1");
    expect(next).toBe(STARTING_BALANCE + 3);
    expect(getBalance(DISCORD_A)).toBe(STARTING_BALANCE + 3);

    const rows = getRecentLedger(DISCORD_A, 10);
    // Oldest row is the starting grant, newest is the adjustment.
    expect(rows.map((r) => r.reason)).toEqual(["match", "starting-grant"]);
    expect(rows.map((r) => r.delta)).toEqual([3, STARTING_BALANCE]);
  });

  test("ensureAccount lazy-creates with starting grant on first call; no-op after", () => {
    expect(getBalance(DISCORD_A)).toBe(0); // no row yet
    ensureAccount(DISCORD_A);
    expect(getBalance(DISCORD_A)).toBe(STARTING_BALANCE);
    const firstRows = getRecentLedger(DISCORD_A, 10);
    expect(firstRows.map((r) => r.reason)).toEqual(["starting-grant"]);

    // Second call must not add a second grant row.
    ensureAccount(DISCORD_A);
    expect(getBalance(DISCORD_A)).toBe(STARTING_BALANCE);
    expect(getRecentLedger(DISCORD_A, 10).length).toBe(firstRows.length);
  });

  test("positive delta adds to balance with matching ledger row", () => {
    adjustBalance(DISCORD_A, 0, "seed"); // lazy-create only, delta=0 after seed
    // After seed: balance = STARTING_BALANCE, ledger has only starting-grant.
    expect(getBalance(DISCORD_A)).toBe(STARTING_BALANCE);

    adjustBalance(DISCORD_A, 7, "bonus");
    expect(getBalance(DISCORD_A)).toBe(STARTING_BALANCE + 7);
    const rows = getRecentLedger(DISCORD_A, 10);
    expect(rows[0]?.delta).toBe(7);
    expect(rows[0]?.reason).toBe("bonus");
  });

  test("negative delta within balance decreases balance, writes that delta", () => {
    adjustBalance(DISCORD_A, 10, "grant"); // balance = STARTING_BALANCE + 10
    const balBefore = getBalance(DISCORD_A);
    adjustBalance(DISCORD_A, -4, "debit");
    expect(getBalance(DISCORD_A)).toBe(balBefore - 4);
    const rows = getRecentLedger(DISCORD_A, 10);
    expect(rows[0]?.delta).toBe(-4);
    expect(rows[0]?.reason).toBe("debit");
  });

  test("negative delta below zero clamps to -current; ledger reflects clamped delta", () => {
    // Fresh wallet: STARTING_BALANCE on lazy create. Request -100 → clamp to -STARTING_BALANCE.
    adjustBalance(DISCORD_A, -100, "penalty");
    expect(getBalance(DISCORD_A)).toBe(0);
    const rows = getRecentLedger(DISCORD_A, 10);
    // Newest row is the penalty, and its delta is the *clamped* value.
    expect(rows[0]?.delta).toBe(-STARTING_BALANCE);
    expect(rows[0]?.reason).toBe("penalty");
  });

  test("clamped to 0 no-op: no ledger row when effectiveDelta is 0", () => {
    adjustBalance(DISCORD_A, -100, "penalty"); // balance -> 0
    const rowsBefore = getRecentLedger(DISCORD_A, 10).length;
    adjustBalance(DISCORD_A, -5, "penalty-again"); // already 0, clamp is 0, no-op
    const rowsAfter = getRecentLedger(DISCORD_A, 10).length;
    expect(rowsAfter).toBe(rowsBefore);
    expect(getBalance(DISCORD_A)).toBe(0);
  });

  test("invariant: sum of ledger deltas equals current balance", () => {
    adjustBalance(DISCORD_A, 5, "a");
    adjustBalance(DISCORD_A, -3, "b");
    adjustBalance(DISCORD_A, 100, "c");
    adjustBalance(DISCORD_A, -200, "d"); // clamped
    adjustBalance(DISCORD_A, 2, "e");
    expect(ledgerSum(DISCORD_A)).toBe(getBalance(DISCORD_A));
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
    placeWager(id, DISCORD_A, "yes", 1);
    resolveBet(id, "yes");
    expect(() => resolveBet(id, "yes")).toThrow(/not open/);
  });

  test("pari-mutuel payout: winners split losers' pool proportionally (floor)", () => {
    // Seed balances large enough to cover the stakes.
    adjustBalance(DISCORD_A, 95, "seed"); // balance 100
    adjustBalance(DISCORD_B, 95, "seed"); // balance 100
    adjustBalance(DISCORD_C, 95, "seed"); // balance 100

    const id = createBet(GUILD, CREATOR_DISCORD, "Split?");
    placeWager(id, DISCORD_A, "yes", 10); // winner
    placeWager(id, DISCORD_B, "yes", 20); // winner
    placeWager(id, DISCORD_C, "no", 15); // loser

    const balBeforeA = getBalance(DISCORD_A); // 90
    const balBeforeB = getBalance(DISCORD_B); // 80
    const balBeforeC = getBalance(DISCORD_C); // 85

    resolveBet(id, "yes");

    // winnerPool=30, loserPool=15. A: 10 + floor(10*15/30) = 10+5 = 15.
    // B: 20 + floor(20*15/30) = 20+10 = 30.
    expect(getBalance(DISCORD_A)).toBe(balBeforeA + 15);
    expect(getBalance(DISCORD_B)).toBe(balBeforeB + 30);
    expect(getBalance(DISCORD_C)).toBe(balBeforeC); // loser: no refund

    // Bet marked resolved with the winning outcome.
    const bet = getBet(id);
    expect(bet?.status).toBe("resolved");
    expect(bet?.winningOutcome).toBe("yes");
    expect(bet?.resolvedAt).not.toBeNull();
  });

  test("cancelBet refunds every wager, marks cancelled, idempotent on re-call", () => {
    adjustBalance(DISCORD_A, 95, "seed"); // 100
    adjustBalance(DISCORD_B, 95, "seed"); // 100
    const preA = getBalance(DISCORD_A);
    const preB = getBalance(DISCORD_B);

    const id = createBet(GUILD, CREATOR_DISCORD, "Expires?");
    placeWager(id, DISCORD_A, "yes", 12);
    placeWager(id, DISCORD_B, "no", 7);
    expect(getBalance(DISCORD_A)).toBe(preA - 12);
    expect(getBalance(DISCORD_B)).toBe(preB - 7);

    cancelBet(id);
    expect(getBalance(DISCORD_A)).toBe(preA);
    expect(getBalance(DISCORD_B)).toBe(preB);
    expect(getBet(id)?.status).toBe("cancelled");
    expect(getRecentLedger(DISCORD_A, 5)[0]?.reason).toBe("bet-cancel");

    // Second call is a no-op — no double refund.
    const afterOne = getBalance(DISCORD_A);
    cancelBet(id);
    expect(getBalance(DISCORD_A)).toBe(afterOne);
  });

  test("getExpiredOpenBets returns open bets past their expires_at only", () => {
    const past = "2020-01-01 00:00:00";
    const future = "2999-01-01 00:00:00";
    const a = createBet(GUILD, CREATOR_DISCORD, "Past", past);
    const b = createBet(GUILD, CREATOR_DISCORD, "Future", future);
    const c = createBet(GUILD, CREATOR_DISCORD, "No expiry", null);
    // Resolved markets, even past-expiry, must not come back.
    const d = createBet(GUILD, CREATOR_DISCORD, "Past but resolved", past);
    placeWager(d, DISCORD_A, "yes", 1);
    resolveBet(d, "yes");

    const ids = getExpiredOpenBets().map((r) => r.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
    expect(ids).not.toContain(c);
    expect(ids).not.toContain(d);
  });

  test("no winners: losers refunded to pre-wager balance, bet-refund row written", () => {
    adjustBalance(DISCORD_A, 95, "seed"); // 100
    adjustBalance(DISCORD_B, 95, "seed"); // 100
    const preA = getBalance(DISCORD_A);
    const preB = getBalance(DISCORD_B);

    const id = createBet(GUILD, CREATOR_DISCORD, "Lopsided");
    placeWager(id, DISCORD_A, "no", 30);
    placeWager(id, DISCORD_B, "no", 40);
    // Nobody picked yes — resolving yes means both losers refund.
    resolveBet(id, "yes");

    expect(getBalance(DISCORD_A)).toBe(preA);
    expect(getBalance(DISCORD_B)).toBe(preB);

    const aRows = getRecentLedger(DISCORD_A, 10);
    expect(aRows[0]?.reason).toBe("bet-refund");
    expect(aRows[0]?.delta).toBe(30);
    const bRows = getRecentLedger(DISCORD_B, 10);
    expect(bRows[0]?.reason).toBe("bet-refund");
    expect(bRows[0]?.delta).toBe(40);
  });
});

describe("wagers — placeWager + getWagersForBet", () => {
  test("placeWager deducts balance + inserts wager + ledger row atomically", () => {
    adjustBalance(DISCORD_A, 20, "seed"); // balance = STARTING_BALANCE + 20
    const before = getBalance(DISCORD_A);
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, DISCORD_A, "yes", 7);

    expect(getBalance(DISCORD_A)).toBe(before - 7);
    const ws = getWagersForBet(id);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({
      betId: id,
      discordId: DISCORD_A,
      outcome: "yes",
      amount: 7,
    });
    const rows = getRecentLedger(DISCORD_A, 10);
    expect(rows[0]?.reason).toBe("bet-placed");
    expect(rows[0]?.delta).toBe(-7);
    expect(rows[0]?.ref).toBe(String(id));
  });

  test("rejects amount <= 0", () => {
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    expect(() => placeWager(id, DISCORD_A, "yes", 0)).toThrow(/positive/);
    expect(() => placeWager(id, DISCORD_A, "yes", -5)).toThrow(/positive/);
  });

  test("rejects closed bet", () => {
    adjustBalance(DISCORD_A, 20, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, DISCORD_A, "yes", 1);
    resolveBet(id, "yes");
    expect(() => placeWager(id, DISCORD_B, "no", 1)).toThrow(/not open/);
  });

  test("rejects double-wager by same discordId on same bet", () => {
    adjustBalance(DISCORD_A, 20, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, DISCORD_A, "yes", 3);
    expect(() => placeWager(id, DISCORD_A, "no", 2)).toThrow(/already wagered/);
  });

  test("rejects insufficient balance (explicit throw, not clamp)", () => {
    // Fresh wallet: STARTING_BALANCE only. 100 > STARTING_BALANCE.
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    expect(() => placeWager(id, DISCORD_A, "yes", 100)).toThrow(/Insufficient balance/);
    // Ensure nothing was persisted — the rollback should leave no wager
    // and no bet-placed ledger row behind.
    expect(getWagersForBet(id)).toHaveLength(0);
    const rows = getRecentLedger(DISCORD_A, 10);
    expect(rows.some((r) => r.reason === "bet-placed")).toBe(false);
  });

  test("getWagersForBet returns all wagers on the bet", () => {
    adjustBalance(DISCORD_A, 20, "seed");
    adjustBalance(DISCORD_B, 20, "seed");
    adjustBalance(DISCORD_C, 20, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, DISCORD_A, "yes", 1);
    placeWager(id, DISCORD_B, "no", 2);
    placeWager(id, DISCORD_C, "yes", 3);
    const ws = getWagersForBet(id);
    expect(ws).toHaveLength(3);
    expect(ws.map((w) => w.discordId).sort()).toEqual(
      [DISCORD_A, DISCORD_B, DISCORD_C].sort(),
    );
  });
});

describe("leaderboard — getCurrentStandings + getAllTimeWins", () => {
  test("getCurrentStandings sorts by balance desc, limits to N", () => {
    adjustBalance(DISCORD_A, 10, "seed"); // STARTING + 10
    adjustBalance(DISCORD_B, 50, "seed"); // STARTING + 50
    adjustBalance(DISCORD_C, 30, "seed"); // STARTING + 30
    adjustBalance(DISCORD_D, 20, "seed"); // STARTING + 20

    const top2 = getCurrentStandings(2);
    expect(top2).toHaveLength(2);
    expect(top2[0]?.discordId).toBe(DISCORD_B);
    expect(top2[1]?.discordId).toBe(DISCORD_C);
    expect(top2[0]?.balance).toBeGreaterThan(top2[1]?.balance ?? 0);
  });

  test("getAllTimeWins counts rank=1 rows per discordId, desc by count", () => {
    db.insert(weeklyWins)
      .values([
        { weekEnding: "2026-01-05", discordId: DISCORD_A, rank: 1, balanceSnapshot: 100 },
        { weekEnding: "2026-01-05", discordId: DISCORD_B, rank: 2, balanceSnapshot: 90 },
        { weekEnding: "2026-01-12", discordId: DISCORD_A, rank: 1, balanceSnapshot: 80 },
        { weekEnding: "2026-01-12", discordId: DISCORD_C, rank: 2, balanceSnapshot: 70 },
        { weekEnding: "2026-01-19", discordId: DISCORD_B, rank: 1, balanceSnapshot: 60 },
        { weekEnding: "2026-01-19", discordId: DISCORD_A, rank: 1, balanceSnapshot: 55 },
      ])
      .run();
    // Note: the 2026-01-19 row for DISCORD_A is also rank=1 — two winners
    // same week is not realistic, but the tally is just COUNT(rank=1).
    const rows = getAllTimeWins(10);
    // DISCORD_A has 3 rank=1 rows, DISCORD_B has 1.
    expect(rows[0]).toEqual({ discordId: DISCORD_A, weeksWon: 3 });
    expect(rows[1]).toEqual({ discordId: DISCORD_B, weeksWon: 1 });
    // DISCORD_C never hit rank=1, so excluded entirely.
    expect(rows.find((r) => r.discordId === DISCORD_C)).toBeUndefined();
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
      discordId: DISCORD_A,
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
      trackedTeammates: ["s-b", "s-c", "s-d"],
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
      trackedTeammates: ["s-b"],
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
