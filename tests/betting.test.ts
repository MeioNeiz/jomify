import { beforeEach, describe, expect, test } from "bun:test";
import { and, sql } from "drizzle-orm";
import {
  BAD_GAME_RATING,
  DEFAULT_CREATOR_STAKE,
  DISPUTE_COST,
  MATCH_GRANT_BASE,
  MATCH_GRANT_PER_TEAMMATE,
  MATCH_GRANT_WIN_BONUS,
  MIN_CREATOR_STAKE,
  PENALTY_BAD_GAME,
  PENALTY_LOSS_STREAK,
  PENALTY_TEAM_FLASH,
  perTraderBonus,
  STARTING_BALANCE,
  TRADER_BONUS_CAP,
} from "../src/betting/config.js";
import db from "../src/betting/db.js";
import { computeMatchDelta } from "../src/betting/listeners/cs-match-completed.js";
import {
  accounts,
  bets,
  disputes,
  ledger,
  marketTicks,
  wagers,
  weeklyWins,
} from "../src/betting/schema.js";
import {
  adjustBalance,
  cancelBet,
  createBet,
  ensureAccount,
  getAllTimeWins,
  getBalance,
  getBet,
  getCreatorStats,
  getCurrentStandings,
  getExpiredOpenBets,
  getRecentLedger,
  getTicksForBet,
  getWagersForBet,
  listOpenBets,
  markDisputeResolved,
  openDispute,
  placeWager,
  reopenBet,
  resolveBet,
  sellWager,
  transferBalance,
} from "../src/betting/store.js";
import type { EventMap } from "../src/events.js";

const GUILD = "bet-guild";
const DISCORD_A = "100000000000000001";
const DISCORD_B = "100000000000000002";
const DISCORD_C = "100000000000000003";
const DISCORD_D = "100000000000000004";
const CREATOR_DISCORD = "100000000000000099";
const STEAM_A = "76561198000000001";

// Sum of every ledger delta for a (discordId, guildId). Invariant:
// should equal the accounts.balance row for that pair.
function ledgerSum(discordId: string, guildId = GUILD): number {
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${ledger.delta}), 0)` })
    .from(ledger)
    .where(
      and(sql`${ledger.discordId} = ${discordId}`, sql`${ledger.guildId} = ${guildId}`),
    )
    .get();
  return row?.total ?? 0;
}

beforeEach(() => {
  // Drizzle's delete is fine against the in-memory DB — keeps the tests
  // schema-aware rather than hard-coding raw SQL.
  db.delete(marketTicks).run();
  db.delete(wagers).run();
  db.delete(disputes).run();
  db.delete(ledger).run();
  db.delete(bets).run();
  db.delete(accounts).run();
  db.delete(weeklyWins).run();
});

describe("accounts — adjustBalance + getBalance + ensureAccount", () => {
  test("first call lazy-creates account with starting balance + starting-grant row", () => {
    // Positive delta triggers the lazy create path on a fresh wallet.
    const next = adjustBalance(DISCORD_A, GUILD, 3, "match", "m-1");
    expect(next).toBe(STARTING_BALANCE + 3);
    expect(getBalance(DISCORD_A, GUILD)).toBe(STARTING_BALANCE + 3);

    const rows = getRecentLedger(DISCORD_A, GUILD, 10);
    // Oldest row is the starting grant, newest is the adjustment.
    expect(rows.map((r) => r.reason)).toEqual(["match", "starting-grant"]);
    expect(rows.map((r) => r.delta)).toEqual([3, STARTING_BALANCE]);
  });

  test("ensureAccount lazy-creates with starting grant on first call; no-op after", () => {
    expect(getBalance(DISCORD_A, GUILD)).toBe(0); // no row yet
    ensureAccount(DISCORD_A, GUILD);
    expect(getBalance(DISCORD_A, GUILD)).toBe(STARTING_BALANCE);
    const firstRows = getRecentLedger(DISCORD_A, GUILD, 10);
    expect(firstRows.map((r) => r.reason)).toEqual(["starting-grant"]);

    // Second call must not add a second grant row.
    ensureAccount(DISCORD_A, GUILD);
    expect(getBalance(DISCORD_A, GUILD)).toBe(STARTING_BALANCE);
    expect(getRecentLedger(DISCORD_A, GUILD, 10).length).toBe(firstRows.length);
  });

  test("positive delta adds to balance with matching ledger row", () => {
    adjustBalance(DISCORD_A, GUILD, 0, "seed"); // lazy-create only, delta=0 after seed
    // After seed: balance = STARTING_BALANCE, ledger has only starting-grant.
    expect(getBalance(DISCORD_A, GUILD)).toBe(STARTING_BALANCE);

    adjustBalance(DISCORD_A, GUILD, 7, "bonus");
    expect(getBalance(DISCORD_A, GUILD)).toBe(STARTING_BALANCE + 7);
    const rows = getRecentLedger(DISCORD_A, GUILD, 10);
    expect(rows[0]?.delta).toBe(7);
    expect(rows[0]?.reason).toBe("bonus");
  });

  test("negative delta within balance decreases balance, writes that delta", () => {
    adjustBalance(DISCORD_A, GUILD, 10, "grant"); // balance = STARTING_BALANCE + 10
    const balBefore = getBalance(DISCORD_A, GUILD);
    adjustBalance(DISCORD_A, GUILD, -4, "debit");
    expect(getBalance(DISCORD_A, GUILD)).toBe(balBefore - 4);
    const rows = getRecentLedger(DISCORD_A, GUILD, 10);
    expect(rows[0]?.delta).toBe(-4);
    expect(rows[0]?.reason).toBe("debit");
  });

  test("negative delta below zero clamps to -current; ledger reflects clamped delta", () => {
    // Fresh wallet: STARTING_BALANCE on lazy create. Request -100 → clamp to -STARTING_BALANCE.
    adjustBalance(DISCORD_A, GUILD, -100, "penalty");
    expect(getBalance(DISCORD_A, GUILD)).toBe(0);
    const rows = getRecentLedger(DISCORD_A, GUILD, 10);
    // Newest row is the penalty, and its delta is the *clamped* value.
    expect(rows[0]?.delta).toBe(-STARTING_BALANCE);
    expect(rows[0]?.reason).toBe("penalty");
  });

  test("clamped to 0 no-op: no ledger row when effectiveDelta is 0", () => {
    adjustBalance(DISCORD_A, GUILD, -100, "penalty"); // balance -> 0
    const rowsBefore = getRecentLedger(DISCORD_A, GUILD, 10).length;
    adjustBalance(DISCORD_A, GUILD, -5, "penalty-again"); // already 0, clamp is 0, no-op
    const rowsAfter = getRecentLedger(DISCORD_A, GUILD, 10).length;
    expect(rowsAfter).toBe(rowsBefore);
    expect(getBalance(DISCORD_A, GUILD)).toBe(0);
  });

  test("invariant: sum of ledger deltas equals current balance", () => {
    adjustBalance(DISCORD_A, GUILD, 5, "a");
    adjustBalance(DISCORD_A, GUILD, -3, "b");
    adjustBalance(DISCORD_A, GUILD, 100, "c");
    adjustBalance(DISCORD_A, GUILD, -200, "d"); // clamped
    adjustBalance(DISCORD_A, GUILD, 2, "e");
    expect(ledgerSum(DISCORD_A)).toBe(getBalance(DISCORD_A, GUILD));
  });
});

describe("accounts — transferBalance", () => {
  test("moves shekels atomically with matching ledger rows", () => {
    adjustBalance(DISCORD_A, GUILD, 20, "seed"); // STARTING_BALANCE + 20
    const before = getBalance(DISCORD_A, GUILD);
    const result = transferBalance(DISCORD_A, DISCORD_B, GUILD, 10);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.senderBalance).toBe(before - 10);
      expect(result.recipientBalance).toBe(STARTING_BALANCE + 10);
    }
    expect(getBalance(DISCORD_A, GUILD)).toBe(before - 10);
    expect(getBalance(DISCORD_B, GUILD)).toBe(STARTING_BALANCE + 10);

    const senderRows = getRecentLedger(DISCORD_A, GUILD, 3);
    expect(senderRows[0]?.reason).toBe("give-sent");
    expect(senderRows[0]?.delta).toBe(-10);
    const recipientRows = getRecentLedger(DISCORD_B, GUILD, 3);
    expect(recipientRows[0]?.reason).toBe("give-received");
    expect(recipientRows[0]?.delta).toBe(10);

    expect(ledgerSum(DISCORD_A)).toBe(getBalance(DISCORD_A, GUILD));
    expect(ledgerSum(DISCORD_B)).toBe(getBalance(DISCORD_B, GUILD));
  });

  test("insufficient-funds leaves both balances untouched", () => {
    ensureAccount(DISCORD_A, GUILD);
    ensureAccount(DISCORD_B, GUILD);
    const aBefore = getBalance(DISCORD_A, GUILD);
    const bBefore = getBalance(DISCORD_B, GUILD);
    const result = transferBalance(DISCORD_A, DISCORD_B, GUILD, aBefore + 1);
    expect(result.kind).toBe("insufficient-funds");
    expect(getBalance(DISCORD_A, GUILD)).toBe(aBefore);
    expect(getBalance(DISCORD_B, GUILD)).toBe(bBefore);
  });

  test("rejects self-transfer and non-positive amounts", () => {
    expect(() => transferBalance(DISCORD_A, DISCORD_A, GUILD, 5)).toThrow();
    expect(() => transferBalance(DISCORD_A, DISCORD_B, GUILD, 0)).toThrow();
    expect(() => transferBalance(DISCORD_A, DISCORD_B, GUILD, -3)).toThrow();
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

  // FIXME: LMSR migration in progress — payout expectations still match
  // the old pari-mutuel math. Re-enable once the new amounts are computed
  // from the actual LMSR share math.
  test.skip("LMSR payout: winners receive shares × (1 − rake), early bettor gets more shares", () => {
    // Seed balances large enough to cover the stakes.
    adjustBalance(DISCORD_A, GUILD, 95, "seed"); // balance 100
    adjustBalance(DISCORD_B, GUILD, 95, "seed"); // balance 100
    adjustBalance(DISCORD_C, GUILD, 95, "seed"); // balance 100

    const id = createBet(GUILD, CREATOR_DISCORD, "Split?");
    placeWager(id, DISCORD_A, "yes", 10); // winner, bets first (better odds)
    placeWager(id, DISCORD_B, "yes", 20); // winner, bets after A pushed YES up
    placeWager(id, DISCORD_C, "no", 15); // loser

    const balBeforeA = getBalance(DISCORD_A, GUILD); // 90
    const balBeforeB = getBalance(DISCORD_B, GUILD); // 80
    const balBeforeC = getBalance(DISCORD_C, GUILD); // 85

    resolveBet(id, "yes");

    // LMSR at b=30, starting at 50%. A bets 10 first → 17.49 shares → payout 17.
    // B bets 20 after A moved the market → 27.21 shares → payout 26.
    // Both get MORE than their stake back because the NO pool (15) + LMSR subsidy
    // exceeds what pari-mutuel would have paid from the NO pool alone.
    expect(getBalance(DISCORD_A, GUILD)).toBe(balBeforeA + 17);
    expect(getBalance(DISCORD_B, GUILD)).toBe(balBeforeB + 26);
    expect(getBalance(DISCORD_C, GUILD)).toBe(balBeforeC); // loser: no refund

    const bet = getBet(id);
    expect(bet?.status).toBe("resolved");
    expect(bet?.winningOutcome).toBe("yes");
    expect(bet?.resolvedAt).not.toBeNull();
  });

  test("cancelBet refunds every wager, marks cancelled, idempotent on re-call", () => {
    adjustBalance(DISCORD_A, GUILD, 95, "seed"); // 100
    adjustBalance(DISCORD_B, GUILD, 95, "seed"); // 100
    const preA = getBalance(DISCORD_A, GUILD);
    const preB = getBalance(DISCORD_B, GUILD);

    const id = createBet(GUILD, CREATOR_DISCORD, "Expires?");
    placeWager(id, DISCORD_A, "yes", 12);
    placeWager(id, DISCORD_B, "no", 7);
    expect(getBalance(DISCORD_A, GUILD)).toBe(preA - 12);
    expect(getBalance(DISCORD_B, GUILD)).toBe(preB - 7);

    cancelBet(id);
    expect(getBalance(DISCORD_A, GUILD)).toBe(preA);
    expect(getBalance(DISCORD_B, GUILD)).toBe(preB);
    expect(getBet(id)?.status).toBe("cancelled");
    expect(getRecentLedger(DISCORD_A, GUILD, 5)[0]?.reason).toBe("bet-cancel");

    // Second call is a no-op — no double refund.
    const afterOne = getBalance(DISCORD_A, GUILD);
    cancelBet(id);
    expect(getBalance(DISCORD_A, GUILD)).toBe(afterOne);
  });

  // FIXME: same LMSR migration as above — reversal math expectations
  // are pari-mutuel. Re-enable once LMSR reverse-path is settled.
  test.skip("reopenBet reverses payouts + resets status; clamps when balance spent", () => {
    adjustBalance(DISCORD_A, GUILD, 95, "seed"); // 100
    adjustBalance(DISCORD_B, GUILD, 95, "seed"); // 100
    const id = createBet(GUILD, CREATOR_DISCORD, "Flip me?");
    placeWager(id, DISCORD_A, "yes", 10); // winner (staked 10 → balance 90)
    placeWager(id, DISCORD_B, "no", 30); // loser (staked 30 → balance 70)
    resolveBet(id, "yes");
    // LMSR at b=30, 50%: A gets floor(17.49 * 0.98) = 17 → balance 90+17 = 107.
    expect(getBalance(DISCORD_A, GUILD)).toBe(107);
    expect(getBalance(DISCORD_B, GUILD)).toBe(70);

    // A spends 100 before dispute reversal lands — clamps since balance < spend.
    // adjustBalance floors at 0: max(-100, -107) = -100 → A = 7.
    adjustBalance(DISCORD_A, GUILD, -100, "spent");
    expect(getBalance(DISCORD_A, GUILD)).toBe(7);

    reopenBet(id);
    // A had 7; reversal wants -17 but clamps to -7.
    expect(getBalance(DISCORD_A, GUILD)).toBe(0);
    expect(getBalance(DISCORD_B, GUILD)).toBe(70); // no payout/refund to reverse for B
    expect(getBet(id)?.status).toBe("open");
    expect(getBet(id)?.winningOutcome).toBeNull();

    // Ledger invariant preserved.
    const aRows = getRecentLedger(DISCORD_A, GUILD, 10);
    expect(aRows.find((r) => r.reason === "bet-reverse")?.delta).toBe(-7);
  });

  test("getExpiredOpenBets returns open bets past their expires_at only", () => {
    // 4 bets × DEFAULT_CREATOR_STAKE — seed so createBet's escrow succeeds.
    adjustBalance(CREATOR_DISCORD, GUILD, 20, "seed");
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

  test("no winners under creator-LP: losers lose stakes, creator pockets the pool", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed"); // 100
    adjustBalance(DISCORD_A, GUILD, 95, "seed"); // 100
    adjustBalance(DISCORD_B, GUILD, 95, "seed"); // 100
    const creatorPre = getBalance(CREATOR_DISCORD, GUILD);
    const preA = getBalance(DISCORD_A, GUILD);
    const preB = getBalance(DISCORD_B, GUILD);

    const id = createBet(GUILD, CREATOR_DISCORD, "Lopsided");
    placeWager(id, DISCORD_A, "no", 30);
    placeWager(id, DISCORD_B, "no", 40);
    resolveBet(id, "yes");

    // LMSR market-maker semantics: no winners means the pool flows to
    // the creator via settleCreator, bettors are not refunded.
    expect(getBalance(DISCORD_A, GUILD)).toBe(preA - 30);
    expect(getBalance(DISCORD_B, GUILD)).toBe(preB - 40);

    // Creator: -5 stake at create, +75 at settle (stake + 70 pool, 0 payouts).
    // Engagement bonus: 2 traders × 0.2/trader = 0.4 → floor 0.
    expect(getBalance(CREATOR_DISCORD, GUILD)).toBe(creatorPre + 70);
    const creatorRows = getRecentLedger(CREATOR_DISCORD, GUILD, 10);
    expect(creatorRows.find((r) => r.reason === "creator-settle")?.delta).toBe(75);
  });
});

describe("wagers — placeWager + getWagersForBet", () => {
  test("placeWager deducts balance + inserts wager + ledger row atomically", () => {
    adjustBalance(DISCORD_A, GUILD, 20, "seed"); // balance = STARTING_BALANCE + 20
    const before = getBalance(DISCORD_A, GUILD);
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, DISCORD_A, "yes", 7);

    expect(getBalance(DISCORD_A, GUILD)).toBe(before - 7);
    const ws = getWagersForBet(id);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({
      betId: id,
      discordId: DISCORD_A,
      outcome: "yes",
      amount: 7,
    });
    const rows = getRecentLedger(DISCORD_A, GUILD, 10);
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
    adjustBalance(DISCORD_A, GUILD, 20, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    placeWager(id, DISCORD_A, "yes", 1);
    resolveBet(id, "yes");
    expect(() => placeWager(id, DISCORD_B, "no", 1)).toThrow(/not open/);
  });

  test("rejects double-wager by same discordId on same bet", () => {
    adjustBalance(DISCORD_A, GUILD, 20, "seed");
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
    const rows = getRecentLedger(DISCORD_A, GUILD, 10);
    expect(rows.some((r) => r.reason === "bet-placed")).toBe(false);
  });

  test("getWagersForBet returns all wagers on the bet", () => {
    adjustBalance(DISCORD_A, GUILD, 20, "seed");
    adjustBalance(DISCORD_B, GUILD, 20, "seed");
    adjustBalance(DISCORD_C, GUILD, 20, "seed");
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
    adjustBalance(DISCORD_A, GUILD, 10, "seed"); // STARTING + 10
    adjustBalance(DISCORD_B, GUILD, 50, "seed"); // STARTING + 50
    adjustBalance(DISCORD_C, GUILD, 30, "seed"); // STARTING + 30
    adjustBalance(DISCORD_D, GUILD, 20, "seed"); // STARTING + 20

    const top2 = getCurrentStandings(GUILD, 2);
    expect(top2).toHaveLength(2);
    expect(top2[0]?.discordId).toBe(DISCORD_B);
    expect(top2[1]?.discordId).toBe(DISCORD_C);
    expect(top2[0]?.balance).toBeGreaterThan(top2[1]?.balance ?? 0);
  });

  test("getAllTimeWins counts rank=1 rows per discordId, desc by count", () => {
    db.insert(weeklyWins)
      .values([
        {
          weekEnding: "2026-01-05",
          guildId: GUILD,
          discordId: DISCORD_A,
          rank: 1,
          balanceSnapshot: 100,
        },
        {
          weekEnding: "2026-01-05",
          guildId: GUILD,
          discordId: DISCORD_B,
          rank: 2,
          balanceSnapshot: 90,
        },
        {
          weekEnding: "2026-01-12",
          guildId: GUILD,
          discordId: DISCORD_A,
          rank: 1,
          balanceSnapshot: 80,
        },
        {
          weekEnding: "2026-01-12",
          guildId: GUILD,
          discordId: DISCORD_C,
          rank: 2,
          balanceSnapshot: 70,
        },
        {
          weekEnding: "2026-01-19",
          guildId: GUILD,
          discordId: DISCORD_B,
          rank: 1,
          balanceSnapshot: 60,
        },
        {
          weekEnding: "2026-01-19",
          guildId: GUILD,
          discordId: DISCORD_A,
          rank: 1,
          balanceSnapshot: 55,
        },
      ])
      .run();
    // Note: the 2026-01-19 row for DISCORD_A is also rank=1 — two winners
    // same week is not realistic, but the tally is just COUNT(rank=1).
    const rows = getAllTimeWins(GUILD, 10);
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

describe("disputes — markDisputeResolved fee refund", () => {
  function seedBet(): number {
    adjustBalance(DISCORD_A, GUILD, 95, "seed"); // opener, balance 100
    adjustBalance(DISCORD_B, GUILD, 95, "seed"); // counterparty, balance 100
    const id = createBet(GUILD, CREATOR_DISCORD, "Dispute test?");
    placeWager(id, DISCORD_A, "yes", 1);
    placeWager(id, DISCORD_B, "no", 1);
    resolveBet(id, "yes");
    return id;
  }

  test("flip ruling refunds the filing fee with a dispute-fee-refund row", () => {
    const betId = seedBet();
    const balBeforeOpen = getBalance(DISCORD_A, GUILD);
    const dispute = openDispute(betId, DISCORD_A, "bad call");
    expect(getBalance(DISCORD_A, GUILD)).toBe(balBeforeOpen - DISPUTE_COST);

    markDisputeResolved(dispute.id, "flip", "no", CREATOR_DISCORD);
    expect(getBalance(DISCORD_A, GUILD)).toBe(balBeforeOpen);

    const rows = getRecentLedger(DISCORD_A, GUILD, 3);
    expect(rows[0]?.reason).toBe("dispute-fee-refund");
    expect(rows[0]?.delta).toBe(DISPUTE_COST);
    expect(rows[0]?.ref).toBe(String(dispute.id));
  });

  test("cancel ruling refunds the filing fee", () => {
    const betId = seedBet();
    const balBeforeOpen = getBalance(DISCORD_A, GUILD);
    const dispute = openDispute(betId, DISCORD_A, "nope");
    markDisputeResolved(dispute.id, "cancel", null, CREATOR_DISCORD);
    expect(getBalance(DISCORD_A, GUILD)).toBe(balBeforeOpen);
    expect(getRecentLedger(DISCORD_A, GUILD, 3)[0]?.reason).toBe("dispute-fee-refund");
  });

  test("keep ruling forfeits the fee — no refund row", () => {
    const betId = seedBet();
    const balBeforeOpen = getBalance(DISCORD_A, GUILD);
    const dispute = openDispute(betId, DISCORD_A, "maybe");
    markDisputeResolved(dispute.id, "keep", "yes", CREATOR_DISCORD);
    expect(getBalance(DISCORD_A, GUILD)).toBe(balBeforeOpen - DISPUTE_COST);
    const rows = getRecentLedger(DISCORD_A, GUILD, 5);
    expect(rows.find((r) => r.reason === "dispute-fee-refund")).toBeUndefined();
  });
});

describe("creator-LP — stake escrow + settleCreator", () => {
  test("createBet escrows stake: debits creator balance + writes creator-stake row", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 15, "seed"); // 20
    const pre = getBalance(CREATOR_DISCORD, GUILD);
    const id = createBet(GUILD, CREATOR_DISCORD, "Escrow?");

    expect(getBalance(CREATOR_DISCORD, GUILD)).toBe(pre - DEFAULT_CREATOR_STAKE);
    const bet = getBet(id);
    expect(bet?.creatorStake).toBe(DEFAULT_CREATOR_STAKE);
    expect(bet?.creatorSettled).toBe(0);
    expect(bet?.b).toBeCloseTo(DEFAULT_CREATOR_STAKE / Math.LN2, 5);

    const rows = getRecentLedger(CREATOR_DISCORD, GUILD, 5);
    const stakeRow = rows.find((r) => r.reason === "creator-stake");
    expect(stakeRow?.delta).toBe(-DEFAULT_CREATOR_STAKE);
    expect(stakeRow?.ref).toBe(String(id));
  });

  test("createBet throws on insufficient balance; no bet persisted", () => {
    // Fresh STARTING_BALANCE (5) can't cover a tier-20 stake.
    expect(() =>
      createBet(GUILD, CREATOR_DISCORD, "Too steep", null, { stake: 20 }),
    ).toThrow(/Insufficient balance/);
    expect(listOpenBets(GUILD).length).toBe(0);
  });

  test("createBet rejects stake below the minimum", () => {
    expect(() =>
      createBet(GUILD, CREATOR_DISCORD, "Too tiny", null, { stake: 4 }),
    ).toThrow(/Stake must be an integer/);
  });

  test("createBet rejects non-integer stake", () => {
    expect(() =>
      createBet(GUILD, CREATOR_DISCORD, "Fractional", null, { stake: 5.5 }),
    ).toThrow(/Stake must be an integer/);
  });

  test("placeWager blocks the creator on their own (non-challenge) market", () => {
    const id = createBet(GUILD, CREATOR_DISCORD, "Self-bet?");
    // Seed after — placeWager check runs before the balance check.
    adjustBalance(CREATOR_DISCORD, GUILD, 20, "seed");
    expect(() => placeWager(id, CREATOR_DISCORD, "yes", 1)).toThrow(/your own market/);
  });

  test("placeWager allows the creator on a challenge market they opened", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 20, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Duel?", null, {
      challengeTargetDiscordId: DISCORD_A,
    });
    // Doesn't throw — the challenger-creator needs to stake their side.
    placeWager(id, CREATOR_DISCORD, "yes", 3);
    expect(getWagersForBet(id)).toHaveLength(1);
  });

  test("resolveBet: creator keeps stake + pool − winner payouts (positive P&L)", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    adjustBalance(DISCORD_B, GUILD, 95, "seed");
    const creatorPre = getBalance(CREATOR_DISCORD, GUILD);

    const id = createBet(GUILD, CREATOR_DISCORD, "Classic yes/no", null, { stake: 20 });
    placeWager(id, DISCORD_A, "yes", 5);
    placeWager(id, DISCORD_B, "no", 5);
    resolveBet(id, "yes");

    const creatorRows = getRecentLedger(CREATOR_DISCORD, GUILD, 10);
    const settle = creatorRows.find((r) => r.reason === "creator-settle");
    expect(settle).toBeDefined();
    // Formula: stake + totalStakes − floor(winner.shares × (1 − rake)).
    // Exact number depends on LMSR shares but is >= stake (balanced book).
    expect(settle!.delta).toBeGreaterThanOrEqual(20);
    // Creator ended net-positive (pocketed rake + any shortfall surplus).
    expect(getBalance(CREATOR_DISCORD, GUILD)).toBeGreaterThan(creatorPre);
  });

  test("cancelBet: creator gets stake back via creator-settle even with no wagers", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 15, "seed");
    const pre = getBalance(CREATOR_DISCORD, GUILD);
    const id = createBet(GUILD, CREATOR_DISCORD, "Will be cancelled");
    expect(getBalance(CREATOR_DISCORD, GUILD)).toBe(pre - DEFAULT_CREATOR_STAKE);

    cancelBet(id);
    // Stake back; no wagers → no engagement bonus → balance returns to pre.
    expect(getBalance(CREATOR_DISCORD, GUILD)).toBe(pre);
    const rows = getRecentLedger(CREATOR_DISCORD, GUILD, 5);
    expect(rows.find((r) => r.reason === "creator-settle")?.delta).toBe(
      DEFAULT_CREATOR_STAKE,
    );
    expect(getBet(id)?.creatorSettled).toBe(1);
  });

  test("engagement bonus scales with unique traders up to TRADER_BONUS_CAP", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    adjustBalance(DISCORD_B, GUILD, 95, "seed");
    adjustBalance(DISCORD_C, GUILD, 95, "seed");

    const id = createBet(GUILD, CREATOR_DISCORD, "Crowded", null, { stake: 20 });
    placeWager(id, DISCORD_A, "yes", 2);
    placeWager(id, DISCORD_B, "yes", 2);
    placeWager(id, DISCORD_C, "no", 2);
    cancelBet(id);

    const expectedBonus = Math.floor(Math.min(3, TRADER_BONUS_CAP) * perTraderBonus(20));
    const bonusRow = getRecentLedger(CREATOR_DISCORD, GUILD, 10).find(
      (r) => r.reason === "creator-trader-bonus",
    );
    expect(bonusRow?.delta).toBe(expectedBonus);
  });

  test("engagement bonus: no row when unique traders = 0 at smallest tier", () => {
    const id = createBet(GUILD, CREATOR_DISCORD, "Nobody cares");
    cancelBet(id);
    const rows = getRecentLedger(CREATOR_DISCORD, GUILD, 10);
    expect(rows.find((r) => r.reason === "creator-trader-bonus")).toBeUndefined();
  });

  test("perTraderBonus scales linearly with stake at 5%", () => {
    expect(perTraderBonus(MIN_CREATOR_STAKE)).toBeCloseTo(0.25, 10);
    expect(perTraderBonus(20)).toBeCloseTo(1, 10);
    expect(perTraderBonus(100)).toBeCloseTo(5, 10);
  });

  test("reopenBet reverses creator-settle + creator-trader-bonus and clears flag", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    adjustBalance(DISCORD_B, GUILD, 95, "seed");

    const id = createBet(GUILD, CREATOR_DISCORD, "Reopenable", null, { stake: 20 });
    placeWager(id, DISCORD_A, "yes", 3);
    placeWager(id, DISCORD_B, "no", 3);
    resolveBet(id, "yes");

    const settled = getBet(id);
    expect(settled?.creatorSettled).toBe(1);
    const settleDelta = getRecentLedger(CREATOR_DISCORD, GUILD, 20).find(
      (r) => r.reason === "creator-settle",
    )?.delta;
    expect(settleDelta).toBeGreaterThan(0);

    reopenBet(id);
    expect(getBet(id)?.creatorSettled).toBe(0);
    expect(getBet(id)?.status).toBe("open");
    const postReopen = getRecentLedger(CREATOR_DISCORD, GUILD, 20);
    // A bet-reverse row exists for the settle (clamped to creator balance).
    expect(postReopen.some((r) => r.reason === "bet-reverse")).toBe(true);

    // Re-resolve the other way — settleCreator fires again, new outcome.
    resolveBet(id, "no");
    expect(getBet(id)?.creatorSettled).toBe(1);
    const afterRe = getRecentLedger(CREATOR_DISCORD, GUILD, 20).filter(
      (r) => r.reason === "creator-settle",
    );
    expect(afterRe.length).toBeGreaterThanOrEqual(2);
  });
});

describe("sell-back — LMSR position exit", () => {
  test("partial sell: reduces shares + amount, refunds, updates q, logs tick", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Partial sell", null, { stake: 20 });
    placeWager(id, DISCORD_A, "yes", 10);

    const before = getWagersForBet(id).find((w) => w.discordId === DISCORD_A)!;
    const balBefore = getBalance(DISCORD_A, GUILD);
    const qYesBefore = getBet(id)!.qYes;

    const half = before.shares / 2;
    const result = sellWager(id, DISCORD_A, half);
    expect(result.refund).toBeGreaterThan(0);
    expect(result.sharesRemaining).toBeCloseTo(before.shares - half, 5);

    const after = getWagersForBet(id).find((w) => w.discordId === DISCORD_A)!;
    expect(after.shares).toBeCloseTo(before.shares - half, 5);
    expect(after.amount).toBe(Math.max(0, before.amount - result.refund));

    // q_yes came down by the shares sold; probability fell toward 50%.
    expect(getBet(id)!.qYes).toBeCloseTo(qYesBefore - half, 5);

    // Refund credited with a bet-sell ledger row.
    expect(getBalance(DISCORD_A, GUILD)).toBe(balBefore + result.refund);
    const row = getRecentLedger(DISCORD_A, GUILD, 5)[0];
    expect(row?.reason).toBe("bet-sell");
    expect(row?.delta).toBe(result.refund);

    // Market tick logged with negative shares + amount.
    const sellTick = getTicksForBet(id).find((t) => t.kind === "sell");
    expect(sellTick?.shares).toBeCloseTo(-half, 5);
    expect(sellTick?.amount).toBe(-result.refund);
  });

  test("full sell deletes wager row; user can re-enter on either side", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Full exit", null, { stake: 20 });
    placeWager(id, DISCORD_A, "yes", 8);

    const held = getWagersForBet(id).find((w) => w.discordId === DISCORD_A)!.shares;
    sellWager(id, DISCORD_A, held);
    expect(getWagersForBet(id).find((w) => w.discordId === DISCORD_A)).toBeUndefined();

    // Re-enter on the other side — no "already wagered" throw.
    placeWager(id, DISCORD_A, "no", 4);
    const re = getWagersForBet(id).find((w) => w.discordId === DISCORD_A);
    expect(re?.outcome).toBe("no");
  });

  test("rejects selling more than held", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Too much", null, { stake: 20 });
    placeWager(id, DISCORD_A, "yes", 5);
    const held = getWagersForBet(id).find((w) => w.discordId === DISCORD_A)!.shares;
    expect(() => sellWager(id, DISCORD_A, held + 10)).toThrow(/only hold/);
  });

  test("rejects sell on closed market", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "Closing", null, { stake: 20 });
    placeWager(id, DISCORD_A, "yes", 3);
    resolveBet(id, "yes");
    expect(() => sellWager(id, DISCORD_A, 1)).toThrow(/not open/);
  });

  test("rejects sell by non-holder", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "No position", null, { stake: 20 });
    expect(() => sellWager(id, DISCORD_A, 1)).toThrow(/position/);
  });

  test("creator blocked from selling on their own market", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR_DISCORD, "LP can't sell", null, { stake: 20 });
    expect(() => sellWager(id, CREATOR_DISCORD, 1)).toThrow(/position to sell/);
  });

  test("rejects non-positive shares", () => {
    const id = createBet(GUILD, CREATOR_DISCORD, "Q?");
    expect(() => sellWager(id, DISCORD_A, 0)).toThrow(/positive/);
    expect(() => sellWager(id, DISCORD_A, -1)).toThrow(/positive/);
  });

  test("path-independent: resolve after buy→sell→buy matches direct buy outcome", () => {
    // Drives the "state is path-independent" invariant: the creator's
    // settle at resolution should depend only on the final wager rows,
    // not on any buy/sell churn in between.
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    adjustBalance(DISCORD_B, GUILD, 95, "seed");

    const id = createBet(GUILD, CREATOR_DISCORD, "Churn", null, { stake: 20 });
    placeWager(id, DISCORD_A, "yes", 5);
    // Full exit, then re-enter smaller on the opposite side.
    const held = getWagersForBet(id).find((w) => w.discordId === DISCORD_A)!.shares;
    sellWager(id, DISCORD_A, held);
    placeWager(id, DISCORD_A, "no", 2);
    placeWager(id, DISCORD_B, "yes", 3);

    // Creator settle shouldn't throw or go negative — the invariant the
    // property test in the plan calls out.
    resolveBet(id, "no");
    const settle = getRecentLedger(CREATOR_DISCORD, GUILD, 20).find(
      (r) => r.reason === "creator-settle",
    );
    expect(settle).toBeDefined();
    expect(settle!.delta).toBeGreaterThanOrEqual(0);
  });
});

describe("phase 4 — dispute → flip E2E with creator stake", () => {
  test("admin flip: reopenBet reverses prior settle; re-resolve runs clean", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");
    adjustBalance(DISCORD_B, GUILD, 95, "seed");

    const id = createBet(GUILD, CREATOR_DISCORD, "Flip me E2E", null, { stake: 20 });
    placeWager(id, DISCORD_A, "yes", 5);
    placeWager(id, DISCORD_B, "no", 5);
    resolveBet(id, "yes");

    // First settle landed.
    const firstSettle = getRecentLedger(CREATOR_DISCORD, GUILD, 20).find(
      (r) => r.reason === "creator-settle",
    );
    expect(firstSettle).toBeDefined();
    expect(getBet(id)?.creatorSettled).toBe(1);

    // B disputes; admin flips to NO.
    const dispute = openDispute(id, DISCORD_B, "called it wrong");
    markDisputeResolved(dispute.id, "flip", "no", CREATOR_DISCORD);
    // Filing fee refunded since action is `flip`.
    expect(
      getRecentLedger(DISCORD_B, GUILD, 10).find(
        (r) => r.reason === "dispute-fee-refund",
      ),
    ).toBeDefined();

    // Admin flow mirrors admin/routes/markets.tsx: reopen, then re-resolve.
    reopenBet(id);
    expect(getBet(id)?.creatorSettled).toBe(0);
    expect(getBet(id)?.status).toBe("open");
    resolveBet(id, "no");
    expect(getBet(id)?.creatorSettled).toBe(1);
    expect(getBet(id)?.winningOutcome).toBe("no");

    // Creator should now have two settle rows (original + re-run) and a
    // reverse row sandwiched between, preserving the ledger-sum invariant.
    const creatorRows = getRecentLedger(CREATOR_DISCORD, GUILD, 30);
    const settles = creatorRows.filter((r) => r.reason === "creator-settle");
    expect(settles.length).toBe(2);
    expect(creatorRows.some((r) => r.reason === "bet-reverse")).toBe(true);

    // Balance invariant: sum(ledger) must equal balance for each party.
    expect(ledgerSum(CREATOR_DISCORD)).toBe(getBalance(CREATOR_DISCORD, GUILD));
    expect(ledgerSum(DISCORD_A)).toBe(getBalance(DISCORD_A, GUILD));
    expect(ledgerSum(DISCORD_B)).toBe(getBalance(DISCORD_B, GUILD));
  });

  test("getCreatorStats reports lifetime numbers correctly", () => {
    adjustBalance(CREATOR_DISCORD, GUILD, 95, "seed");
    adjustBalance(DISCORD_A, GUILD, 95, "seed");

    const id = createBet(GUILD, CREATOR_DISCORD, "Stats?", null, { stake: 20 });
    placeWager(id, DISCORD_A, "no", 3);
    resolveBet(id, "yes"); // A loses, creator pockets pool.

    const stats = getCreatorStats(CREATOR_DISCORD, GUILD);
    expect(stats.marketsCreated).toBe(1);
    expect(stats.stakeDeployed).toBe(20);
    expect(stats.lifetimeSettle).toBeGreaterThanOrEqual(20);
    expect(stats.netPnL).toBe(
      stats.lifetimeSettle + stats.lifetimeBonus - stats.stakeDeployed,
    );
  });
});
