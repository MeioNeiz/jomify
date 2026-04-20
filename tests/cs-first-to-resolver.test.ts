import { beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import db from "../src/betting/db.js";
import {
  checkAceFromStats,
  checkThirtyBombFromStats,
  isInScope,
  parseFirstToArgs,
} from "../src/betting/resolvers/cs-first-to.js";
import { tick } from "../src/betting/resolvers/watcher.js";
import { accounts, bets, ledger, marketTicks, wagers } from "../src/betting/schema.js";
import { adjustBalance, createBet, getBet, placeWager } from "../src/betting/store.js";
import { sqlite as csDb } from "../src/cs/db.js";

// Side-effect import registers the cs:first-to resolver kind.
import "../src/betting/resolvers/cs-first-to.js";

const GUILD = "first-to-guild";
const OTHER_GUILD = "other-guild";
const CREATOR = "400000000000000001";
const BETTOR = "400000000000000002";
const ALICE = "76561198100000001";
const BOB = "76561198100000002";
const CAROL = "76561198100000003";

const fakeClient = {} as unknown as Client;

function seedMatch(opts: {
  matchId: string;
  steamId: string;
  finishedAt: string;
  multi5k?: number;
  totalKills?: number;
  roundsWon?: number;
  roundsLost?: number;
}): void {
  csDb.run(
    `INSERT OR REPLACE INTO matches (match_id, finished_at, map_name)
     VALUES (?, ?, 'de_mirage')`,
    [opts.matchId, opts.finishedAt],
  );
  const raw = JSON.stringify({
    multi5k: opts.multi5k ?? 0,
    total_kills: opts.totalKills ?? 0,
    rounds_won: opts.roundsWon ?? 13,
    rounds_lost: opts.roundsLost ?? 5,
  });
  csDb.run(
    `INSERT OR REPLACE INTO match_stats
       (match_id, steam_id, total_kills, rounds_won, rounds_lost, multi5k, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.matchId,
      opts.steamId,
      opts.totalKills ?? 0,
      opts.roundsWon ?? 13,
      opts.roundsLost ?? 5,
      opts.multi5k ?? 0,
      raw,
    ],
  );
}

function seedTracked(guildId: string, steamId: string): void {
  csDb.run(`INSERT OR IGNORE INTO tracked_players (guild_id, steam_id) VALUES (?, ?)`, [
    guildId,
    steamId,
  ]);
}

function afterCreated(betId: number, offsetSec = 1): string {
  const created = getBet(betId)?.createdAt;
  const after = new Date(`${created} UTC`);
  after.setSeconds(after.getSeconds() + offsetSec);
  return after.toISOString();
}

beforeEach(() => {
  db.delete(marketTicks).run();
  db.delete(wagers).run();
  db.delete(ledger).run();
  db.delete(bets).run();
  db.delete(accounts).run();
  csDb.run("DELETE FROM match_stats");
  csDb.run("DELETE FROM matches");
  csDb.run("DELETE FROM tracked_players");
});

describe("cs:first-to arg parsing", () => {
  test("rejects unknown stat / scope / missing guild", () => {
    expect(parseFirstToArgs(null)).toBeNull();
    expect(parseFirstToArgs({ stat: "nope", scope: "guild", guildId: "g" })).toBeNull();
    expect(parseFirstToArgs({ stat: "ace", scope: "VC", guildId: "g" })).toBeNull();
    expect(parseFirstToArgs({ stat: "ace", scope: "guild" })).toBeNull();
  });

  test("win-streak requires threshold ≥ 2", () => {
    expect(
      parseFirstToArgs({ stat: "win-streak", scope: "guild", guildId: "g" }),
    ).toBeNull();
    expect(
      parseFirstToArgs({
        stat: "win-streak",
        scope: "guild",
        guildId: "g",
        threshold: 1,
      }),
    ).toBeNull();
    expect(
      parseFirstToArgs({
        stat: "win-streak",
        scope: "guild",
        guildId: "g",
        threshold: 3,
      }),
    ).toEqual({
      stat: "win-streak",
      scope: "guild",
      guildId: "g",
      threshold: 3,
      steamIds: undefined,
    });
  });

  test("list scope requires a non-empty steamIds array", () => {
    expect(parseFirstToArgs({ stat: "ace", scope: "list", guildId: "g" })).toBeNull();
    expect(
      parseFirstToArgs({ stat: "ace", scope: "list", guildId: "g", steamIds: [] }),
    ).toBeNull();
    expect(
      parseFirstToArgs({
        stat: "ace",
        scope: "list",
        guildId: "g",
        steamIds: [ALICE],
      }),
    ).toMatchObject({ stat: "ace", scope: "list", steamIds: [ALICE] });
  });
});

describe("cs:first-to condition helpers", () => {
  test("ace trigger on multi5k ≥ 1", () => {
    expect(checkAceFromStats({ multi5k: 0 })).toBe(false);
    expect(checkAceFromStats({ multi5k: 1 })).toBe(true);
    expect(checkAceFromStats({ multi5k: 2 })).toBe(true);
    expect(checkAceFromStats({})).toBe(false);
  });

  test("thirty-bomb trigger on totalKills ≥ 30", () => {
    expect(checkThirtyBombFromStats({ total_kills: 29 })).toBe(false);
    expect(checkThirtyBombFromStats({ total_kills: 30 })).toBe(true);
    expect(checkThirtyBombFromStats({ totalKills: 42 })).toBe(true);
    expect(checkThirtyBombFromStats({})).toBe(false);
  });
});

describe("cs:first-to scope membership", () => {
  test("guild scope matches any steamId in same guild, rejects other guilds", () => {
    const args = parseFirstToArgs({
      stat: "ace",
      scope: "guild",
      guildId: GUILD,
    })!;
    expect(isInScope(args, ALICE, GUILD)).toBe(true);
    expect(isInScope(args, ALICE, OTHER_GUILD)).toBe(false);
  });

  test("list scope only matches named steamIds", () => {
    const args = parseFirstToArgs({
      stat: "ace",
      scope: "list",
      guildId: GUILD,
      steamIds: [ALICE, BOB],
    })!;
    expect(isInScope(args, ALICE, GUILD)).toBe(true);
    expect(isInScope(args, BOB, GUILD)).toBe(true);
    expect(isInScope(args, CAROL, GUILD)).toBe(false);
  });
});

describe("cs:first-to resolver poll", () => {
  test("ace → yes when any guild player aces after open", async () => {
    seedTracked(GUILD, ALICE);
    seedTracked(GUILD, BOB);
    adjustBalance(BETTOR, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Will anyone ace?", null, {
      resolverKind: "cs:first-to",
      resolverArgs: { stat: "ace", scope: "guild", guildId: GUILD },
    });
    placeWager(id, BETTOR, "yes", 5);

    seedMatch({
      matchId: "m-ace-bob",
      steamId: BOB,
      finishedAt: afterCreated(id),
      multi5k: 1,
      totalKills: 22,
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("resolved");
    expect(getBet(id)?.winningOutcome).toBe("yes");
  });

  test("thirty-bomb → yes when a list player crosses 30 kills", async () => {
    seedTracked(GUILD, ALICE);
    seedTracked(GUILD, BOB);
    adjustBalance(BETTOR, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR, "30+?", null, {
      resolverKind: "cs:first-to",
      resolverArgs: {
        stat: "thirty-bomb",
        scope: "list",
        guildId: GUILD,
        steamIds: [ALICE],
      },
    });
    placeWager(id, BETTOR, "yes", 5);

    // Bob aces — not on the list → should NOT resolve.
    seedMatch({
      matchId: "m-bob-ace",
      steamId: BOB,
      finishedAt: afterCreated(id),
      multi5k: 1,
      totalKills: 12,
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("open");

    // Alice drops a thirty-bomb → should resolve yes.
    seedMatch({
      matchId: "m-alice-30",
      steamId: ALICE,
      finishedAt: afterCreated(id, 2),
      multi5k: 0,
      totalKills: 32,
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("resolved");
    expect(getBet(id)?.winningOutcome).toBe("yes");
  });

  test("win-streak → yes once a tracked player reaches N in a row", async () => {
    seedTracked(GUILD, ALICE);
    adjustBalance(BETTOR, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR, "3-win streak?", null, {
      resolverKind: "cs:first-to",
      resolverArgs: {
        stat: "win-streak",
        scope: "guild",
        guildId: GUILD,
        threshold: 3,
      },
    });
    placeWager(id, BETTOR, "yes", 5);

    // Two wins so far → still pending.
    seedMatch({
      matchId: "m1",
      steamId: ALICE,
      finishedAt: afterCreated(id, 1),
      roundsWon: 13,
      roundsLost: 7,
    });
    seedMatch({
      matchId: "m2",
      steamId: ALICE,
      finishedAt: afterCreated(id, 2),
      roundsWon: 13,
      roundsLost: 9,
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("open");

    // Third win → resolves yes.
    seedMatch({
      matchId: "m3",
      steamId: ALICE,
      finishedAt: afterCreated(id, 3),
      roundsWon: 13,
      roundsLost: 10,
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("resolved");
    expect(getBet(id)?.winningOutcome).toBe("yes");
  });

  test("pre-market matches don't trigger resolution", async () => {
    seedTracked(GUILD, ALICE);
    // Plant a pre-existing ace BEFORE the market opens.
    const before = new Date();
    before.setHours(before.getHours() - 2);
    seedMatch({
      matchId: "m-stale-ace",
      steamId: ALICE,
      finishedAt: before.toISOString(),
      multi5k: 1,
      totalKills: 18,
    });

    const id = createBet(GUILD, CREATOR, "Will anyone ace?", null, {
      resolverKind: "cs:first-to",
      resolverArgs: { stat: "ace", scope: "guild", guildId: GUILD },
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("open");
  });

  test("empty scope stays pending (no tracked players yet)", async () => {
    const id = createBet(GUILD, CREATOR, "Will anyone ace?", null, {
      resolverKind: "cs:first-to",
      resolverArgs: { stat: "ace", scope: "guild", guildId: GUILD },
    });
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("open");
  });

  test("missing args → cancel (refund)", async () => {
    adjustBalance(BETTOR, GUILD, 95, "seed");
    const id = createBet(GUILD, CREATOR, "Bad args", null, {
      resolverKind: "cs:first-to",
      resolverArgs: { stat: "ace" }, // missing scope + guildId
    });
    placeWager(id, BETTOR, "yes", 5);
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("cancelled");
  });
});
