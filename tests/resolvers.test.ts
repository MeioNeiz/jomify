import { beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { sql } from "drizzle-orm";
import db from "../src/betting/db.js";
import {
  lookup,
  type Resolver,
  type ResolverContext,
  type ResolverVerdict,
  register,
} from "../src/betting/resolvers/index.js";
import { tick } from "../src/betting/resolvers/watcher.js";
import { accounts, bets, ledger, wagers } from "../src/betting/schema.js";
import {
  adjustBalance,
  cancelBet,
  createBet,
  getBet,
  placeWager,
  resolveBet,
} from "../src/betting/store.js";

const GUILD = "resolver-guild";
const CREATOR = "200000000000000001";
const BETTOR_A = "200000000000000002";
const BETTOR_B = "200000000000000003";

// A fake Discord client is enough for the watcher — it only touches
// client.channels.fetch when the bet has a message pointer, and we
// never set one in these tests.
const fakeClient = {} as unknown as Client;

// Test kinds all use a `test-<unique>` prefix so they don't collide
// with real resolver kinds registered at module load. Registry state
// accumulates across tests in a single run (Bun's module cache is
// shared), so each test claims its own kind name.
beforeEach(() => {
  db.delete(wagers).run();
  db.delete(ledger).run();
  db.delete(bets).run();
  db.delete(accounts).run();
});

describe("resolver registry", () => {
  test("register + lookup round-trip", () => {
    const r: Resolver = {
      kind: "test:noop",
      check: async () => ({ kind: "pending" }),
    };
    register(r);
    expect(lookup("test:noop")).toBe(r);
  });

  test("double-register throws", () => {
    register({ kind: "test:dup", check: async () => ({ kind: "pending" }) });
    expect(() =>
      register({ kind: "test:dup", check: async () => ({ kind: "pending" }) }),
    ).toThrow(/already registered/);
  });

  test("lookup returns null for unknown kind", () => {
    expect(lookup("test:missing")).toBeNull();
  });
});

describe("resolver poller", () => {
  // Create a bet directly via createBet with the resolver fields set,
  // then run the watcher's tick() and inspect the bet's final state.
  // Lets us verify the full pending → resolve → cancel contract without
  // needing a real Discord client or CS match data.
  function makeResolverBet(kind: string, args: unknown): number {
    return createBet(GUILD, CREATOR, "Will it auto?", null, {
      resolverKind: kind,
      resolverArgs: args,
    });
  }

  test("pending verdict leaves bet open and updates state when nextState set", async () => {
    register({
      kind: "test:pending",
      check: async () => ({ kind: "pending", nextState: { lastSeen: "x" } }),
    });
    const id = makeResolverBet("test:pending", {});
    await tick(fakeClient);
    const bet = getBet(id);
    expect(bet?.status).toBe("open");
    expect(bet?.resolverState).toBe(JSON.stringify({ lastSeen: "x" }));
  });

  test("pending without nextState leaves state untouched", async () => {
    register({
      kind: "test:pending-nostate",
      check: async () => ({ kind: "pending" }),
    });
    const id = makeResolverBet("test:pending-nostate", {});
    await tick(fakeClient);
    expect(getBet(id)?.resolverState).toBeNull();
  });

  test("resolve verdict pays winners and marks resolved", async () => {
    register({
      kind: "test:resolve",
      check: async () => ({ kind: "resolve", outcome: "yes" }),
    });
    // Seed balances so the wagers don't blow through STARTING_BALANCE.
    adjustBalance(BETTOR_A, 95, "seed"); // 100
    adjustBalance(BETTOR_B, 95, "seed"); // 100
    const id = makeResolverBet("test:resolve", {});
    placeWager(id, BETTOR_A, "yes", 10); // winner
    placeWager(id, BETTOR_B, "no", 20); // loser

    await tick(fakeClient);
    const bet = getBet(id);
    expect(bet?.status).toBe("resolved");
    expect(bet?.winningOutcome).toBe("yes");
  });

  test("cancel verdict refunds and marks cancelled", async () => {
    register({
      kind: "test:cancel",
      check: async () => ({ kind: "cancel", note: "upstream voided" }),
    });
    adjustBalance(BETTOR_A, 95, "seed");
    const id = makeResolverBet("test:cancel", {});
    placeWager(id, BETTOR_A, "yes", 5);
    const before = db
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(sql`${accounts.discordId} = ${BETTOR_A}`)
      .get();

    await tick(fakeClient);
    const bet = getBet(id);
    expect(bet?.status).toBe("cancelled");
    const after = db
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(sql`${accounts.discordId} = ${BETTOR_A}`)
      .get();
    // Refund restored the 5 shekels that the wager had deducted.
    expect((after?.balance ?? 0) - (before?.balance ?? 0)).toBe(5);
  });

  test("unknown kind is skipped — no mutation", async () => {
    const id = makeResolverBet("test:unregistered", {});
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("open");
  });

  test("check() throwing doesn't halt the queue — other bets still tick", async () => {
    register({
      kind: "test:boom",
      check: async () => {
        throw new Error("upstream 500");
      },
    });
    let otherChecked = false;
    register({
      kind: "test:ok",
      check: async () => {
        otherChecked = true;
        return { kind: "pending" };
      },
    });
    makeResolverBet("test:boom", {});
    makeResolverBet("test:ok", {});
    await tick(fakeClient);
    expect(otherChecked).toBe(true);
  });

  test("already-resolved bet with stale resolver_kind is ignored", async () => {
    // Edge case: a manual admin ruling via the dispute flow might
    // resolve an auto-market. The poller should notice the status
    // flip and do nothing, not double-pay.
    let called = false;
    register({
      kind: "test:should-skip",
      check: async (_ctx: ResolverContext): Promise<ResolverVerdict> => {
        called = true;
        return { kind: "resolve", outcome: "yes" };
      },
    });
    adjustBalance(BETTOR_A, 95, "seed");
    const id = makeResolverBet("test:should-skip", {});
    placeWager(id, BETTOR_A, "yes", 3);
    resolveBet(id, "no"); // manual resolve first

    await tick(fakeClient);
    // getOpenResolverBets filters on status=open, so check() shouldn't
    // have been invoked.
    expect(called).toBe(false);
    expect(getBet(id)?.status).toBe("resolved");
    expect(getBet(id)?.winningOutcome).toBe("no");
  });

  test("cancelled bet is left alone", async () => {
    register({
      kind: "test:cancelled-stays",
      check: async () => ({ kind: "resolve", outcome: "yes" }),
    });
    const id = makeResolverBet("test:cancelled-stays", {});
    cancelBet(id);
    await tick(fakeClient);
    expect(getBet(id)?.status).toBe("cancelled");
  });
});
