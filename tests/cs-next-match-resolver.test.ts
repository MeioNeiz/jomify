import { beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import db from "../src/betting/db.js";
import { tick } from "../src/betting/resolvers/watcher.js";
import { accounts, bets, ledger, wagers } from "../src/betting/schema.js";
import { adjustBalance, createBet, getBet, placeWager } from "../src/betting/store.js";
import { sqlite as csDb } from "../src/cs/db.js";

// Side-effect import registers the three cs:next-match-* resolver kinds.
import "../src/betting/resolvers/cs-next-match.js";

const GUILD = "cs-resolver-guild";
const CREATOR = "300000000000000001";
const BETTOR = "300000000000000002";
const STEAM = "76561198000000042";

const fakeClient = {} as unknown as Client;

// Put a match + match_stats pair into the CS DB so getFirstMatchAfter
// can see it. `raw` has to include the fields the resolver reads:
// leetify_rating, total_kills, rounds_won, rounds_lost.
function seedMatch(opts: {
  matchId: string;
  finishedAt: string;
  leetifyRating: number | null;
  totalKills: number;
  roundsWon: number;
  roundsLost: number;
}): void {
  csDb.run(
    `INSERT OR REPLACE INTO matches (match_id, finished_at, map_name)
     VALUES (?, ?, 'de_dust2')`,
    [opts.matchId, opts.finishedAt],
  );
  const raw = JSON.stringify({
    leetify_rating: opts.leetifyRating,
    total_kills: opts.totalKills,
    rounds_won: opts.roundsWon,
    rounds_lost: opts.roundsLost,
  });
  csDb.run(
    `INSERT OR REPLACE INTO match_stats
       (match_id, steam_id, total_kills, rounds_won, rounds_lost, leetify_rating, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.matchId,
      STEAM,
      opts.totalKills,
      opts.roundsWon,
      opts.roundsLost,
      opts.leetifyRating,
      raw,
    ],
  );
}

beforeEach(() => {
  db.delete(wagers).run();
  db.delete(ledger).run();
  db.delete(bets).run();
  db.delete(accounts).run();
  csDb.run("DELETE FROM match_stats");
  csDb.run("DELETE FROM matches");
});

describe("cs:next-match-win", () => {
  test("match after market opens + win → yes resolution", async () => {
    adjustBalance(BETTOR, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Will they win?", null, {
      resolverKind: "cs:next-match-win",
      resolverArgs: { steamId: STEAM },
    });
    placeWager(id, BETTOR, "yes", 5);

    // createdAt is 'YYYY-MM-DD HH:MM:SS' from datetime('now'). Match
    // one second later in ISO-T to simulate Leetify's timestamp shape.
    const created = getBet(id)?.createdAt;
    expect(created).toBeTruthy();
    const after = new Date(`${created} UTC`);
    after.setSeconds(after.getSeconds() + 1);
    const finishedAt = after.toISOString();

    seedMatch({
      matchId: "m-win-1",
      finishedAt,
      leetifyRating: 0.05,
      totalKills: 20,
      roundsWon: 13,
      roundsLost: 7,
    });

    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("resolved");
    expect(getBet(id)?.winningOutcome).toBe("yes");
  });

  test("loss → no resolution", async () => {
    adjustBalance(BETTOR, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Will they win?", null, {
      resolverKind: "cs:next-match-win",
      resolverArgs: { steamId: STEAM },
    });
    placeWager(id, BETTOR, "yes", 5);
    const created = getBet(id)?.createdAt;
    const after = new Date(`${created} UTC`);
    after.setSeconds(after.getSeconds() + 1);
    seedMatch({
      matchId: "m-loss-1",
      finishedAt: after.toISOString(),
      leetifyRating: -0.05,
      totalKills: 12,
      roundsWon: 7,
      roundsLost: 13,
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("resolved");
    expect(getBet(id)?.winningOutcome).toBe("no");
  });

  test("tie → cancel (refund)", async () => {
    adjustBalance(BETTOR, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Will they win?", null, {
      resolverKind: "cs:next-match-win",
      resolverArgs: { steamId: STEAM },
    });
    placeWager(id, BETTOR, "yes", 5);
    const created = getBet(id)?.createdAt;
    const after = new Date(`${created} UTC`);
    after.setSeconds(after.getSeconds() + 1);
    seedMatch({
      matchId: "m-tie-1",
      finishedAt: after.toISOString(),
      leetifyRating: 0,
      totalKills: 15,
      roundsWon: 12,
      roundsLost: 12,
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("cancelled");
  });

  test("no match yet → pending (stays open)", async () => {
    const id = createBet(GUILD, CREATOR, "Will they win?", null, {
      resolverKind: "cs:next-match-win",
      resolverArgs: { steamId: STEAM },
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("open");
  });

  test("match finished BEFORE market opened is ignored", async () => {
    // The whole point of bet.createdAt as the cut-off — a pre-existing
    // match shouldn't prematurely resolve a newly-opened market.
    const before = new Date();
    before.setHours(before.getHours() - 2);
    seedMatch({
      matchId: "m-stale",
      finishedAt: before.toISOString(),
      leetifyRating: 0.1,
      totalKills: 25,
      roundsWon: 13,
      roundsLost: 5,
    });
    const id = createBet(GUILD, CREATOR, "Will they win?", null, {
      resolverKind: "cs:next-match-win",
      resolverArgs: { steamId: STEAM },
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("open");
  });
});

describe("cs:next-match-rating-above", () => {
  test("rating ≥ threshold → yes", async () => {
    adjustBalance(BETTOR, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Rating ≥ 0.05?", null, {
      resolverKind: "cs:next-match-rating-above",
      resolverArgs: { steamId: STEAM, threshold: 0.05 },
    });
    placeWager(id, BETTOR, "yes", 5);
    const created = getBet(id)?.createdAt;
    const after = new Date(`${created} UTC`);
    after.setSeconds(after.getSeconds() + 1);
    seedMatch({
      matchId: "m-rating-hi",
      finishedAt: after.toISOString(),
      leetifyRating: 0.07,
      totalKills: 18,
      roundsWon: 13,
      roundsLost: 10,
    });
    await tick(fakeClient);
    expect(getBet(id)?.winningOutcome).toBe("yes");
  });

  test("rating below threshold → no", async () => {
    adjustBalance(BETTOR, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Rating ≥ 0.05?", null, {
      resolverKind: "cs:next-match-rating-above",
      resolverArgs: { steamId: STEAM, threshold: 0.05 },
    });
    placeWager(id, BETTOR, "yes", 5);
    const created = getBet(id)?.createdAt;
    const after = new Date(`${created} UTC`);
    after.setSeconds(after.getSeconds() + 1);
    seedMatch({
      matchId: "m-rating-lo",
      finishedAt: after.toISOString(),
      leetifyRating: 0.01,
      totalKills: 14,
      roundsWon: 10,
      roundsLost: 13,
    });
    await tick(fakeClient);
    expect(getBet(id)?.winningOutcome).toBe("no");
  });

  test("null rating → cancel (refund)", async () => {
    adjustBalance(BETTOR, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Rating ≥ 0.05?", null, {
      resolverKind: "cs:next-match-rating-above",
      resolverArgs: { steamId: STEAM, threshold: 0.05 },
    });
    placeWager(id, BETTOR, "yes", 5);
    const created = getBet(id)?.createdAt;
    const after = new Date(`${created} UTC`);
    after.setSeconds(after.getSeconds() + 1);
    seedMatch({
      matchId: "m-rating-null",
      finishedAt: after.toISOString(),
      leetifyRating: null,
      totalKills: 10,
      roundsWon: 8,
      roundsLost: 13,
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("cancelled");
  });
});

describe("cs:next-match-kills-above", () => {
  test("kills > threshold → yes", async () => {
    adjustBalance(BETTOR, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Over 20 kills?", null, {
      resolverKind: "cs:next-match-kills-above",
      resolverArgs: { steamId: STEAM, threshold: 20 },
    });
    placeWager(id, BETTOR, "yes", 5);
    const created = getBet(id)?.createdAt;
    const after = new Date(`${created} UTC`);
    after.setSeconds(after.getSeconds() + 1);
    seedMatch({
      matchId: "m-kills-hi",
      finishedAt: after.toISOString(),
      leetifyRating: 0.08,
      totalKills: 25,
      roundsWon: 13,
      roundsLost: 8,
    });
    await tick(fakeClient);
    expect(getBet(id)?.winningOutcome).toBe("yes");
  });

  test("kills == threshold (strict >) → no", async () => {
    adjustBalance(BETTOR, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Over 20 kills?", null, {
      resolverKind: "cs:next-match-kills-above",
      resolverArgs: { steamId: STEAM, threshold: 20 },
    });
    placeWager(id, BETTOR, "yes", 5);
    const created = getBet(id)?.createdAt;
    const after = new Date(`${created} UTC`);
    after.setSeconds(after.getSeconds() + 1);
    seedMatch({
      matchId: "m-kills-eq",
      finishedAt: after.toISOString(),
      leetifyRating: 0.0,
      totalKills: 20,
      roundsWon: 11,
      roundsLost: 13,
    });
    await tick(fakeClient);
    expect(getBet(id)?.winningOutcome).toBe("no");
  });

  test("missing threshold → cancel", async () => {
    adjustBalance(BETTOR, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Kills above ??", null, {
      resolverKind: "cs:next-match-kills-above",
      resolverArgs: { steamId: STEAM }, // no threshold
    });
    placeWager(id, BETTOR, "yes", 5);
    // Make a match available so we don't stay pending on empty data.
    const created = getBet(id)?.createdAt;
    const after = new Date(`${created} UTC`);
    after.setSeconds(after.getSeconds() + 1);
    seedMatch({
      matchId: "m-kills-missing-thresh",
      finishedAt: after.toISOString(),
      leetifyRating: 0.05,
      totalKills: 30,
      roundsWon: 13,
      roundsLost: 9,
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("cancelled");
  });
});
