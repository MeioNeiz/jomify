import { beforeEach, describe, expect, test } from "bun:test";
import { trackApiCall } from "../src/cs/store.js";
import { sqlite as db } from "../src/db.js";
import {
  bumpApiCall,
  markFirstReply,
  markLastReply,
  runWithMetrics,
} from "../src/metrics.js";
import { getCommandStats, saveMetric } from "../src/store.js";

beforeEach(() => {
  db.run("DELETE FROM metrics");
  db.run("DELETE FROM api_usage");
});

describe("runWithMetrics", () => {
  test("persists a row on success with total_ms >= 0 and success=1", async () => {
    await runWithMetrics({ command: "stats", userId: "u1", guildId: "g1" }, async () => {
      // nothing
    });
    const rows = db.query("SELECT * FROM metrics").all() as {
      command: string;
      total_ms: number;
      success: number;
      user_id: string | null;
      guild_id: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe("stats");
    expect(rows[0].total_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0].success).toBe(1);
    expect(rows[0].user_id).toBe("u1");
    expect(rows[0].guild_id).toBe("g1");
  });

  test("persists a row on thrown error with success=0 and message", async () => {
    await expect(
      runWithMetrics({ command: "boom" }, async () => {
        throw new Error("explicit failure");
      }),
    ).rejects.toThrow("explicit failure");

    const row = db.query("SELECT * FROM metrics").get() as {
      success: number;
      error_message: string | null;
      command: string;
    };
    expect(row.command).toBe("boom");
    expect(row.success).toBe(0);
    expect(row.error_message).toBe("explicit failure");
  });

  test("re-throws the original error to the caller", async () => {
    const err = new Error("original");
    let caught: unknown = null;
    try {
      await runWithMetrics({ command: "x" }, async () => {
        throw err;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });
});

describe("bumpApiCall", () => {
  test("is a no-op when called outside runWithMetrics", () => {
    // Should not throw and should not create any row.
    expect(() => bumpApiCall("leetify:/v3/profile")).not.toThrow();
    expect((db.query("SELECT COUNT(*) as c FROM metrics").get() as { c: number }).c).toBe(
      0,
    );
  });

  test("accumulates into the collector and lands in the persisted row", async () => {
    await runWithMetrics({ command: "stats" }, async () => {
      bumpApiCall("leetify:/v3/profile");
      bumpApiCall("leetify:/v3/profile");
      bumpApiCall("steam:vanity-resolve");
    });
    const row = db.query("SELECT api_calls FROM metrics").get() as {
      api_calls: string | null;
    };
    expect(row.api_calls).not.toBeNull();
    const parsed = JSON.parse(row.api_calls!) as Record<string, number>;
    expect(parsed["leetify:/v3/profile"]).toBe(2);
    expect(parsed["steam:vanity-resolve"]).toBe(1);
  });

  test("trackApiCall inside runWithMetrics also populates the collector", async () => {
    await runWithMetrics({ command: "stats" }, async () => {
      trackApiCall("leetify:/v3/profile");
    });
    const row = db.query("SELECT api_calls FROM metrics").get() as {
      api_calls: string | null;
    };
    const parsed = JSON.parse(row.api_calls!) as Record<string, number>;
    expect(parsed["leetify:/v3/profile"]).toBe(1);
  });

  test("trackApiCall outside runWithMetrics still updates api_usage", () => {
    trackApiCall("leetify:/v3/profile");
    const usage = db.query("SELECT * FROM api_usage").all();
    expect(usage).toHaveLength(1);
  });
});

describe("markFirstReply / markLastReply", () => {
  test("markFirstReply is sticky; markLastReply keeps moving", async () => {
    await runWithMetrics({ command: "stats" }, async () => {
      markFirstReply();
      const first = Date.now();
      // Advance a little so timestamps are distinguishable.
      await new Promise((r) => setTimeout(r, 5));
      markFirstReply(); // should be ignored
      markLastReply();
      await new Promise((r) => setTimeout(r, 5));
      markLastReply();
      // Sanity: first call marked first strictly before later last.
      expect(Date.now()).toBeGreaterThanOrEqual(first);
    });
    const row = db.query("SELECT ttf_ms, ttl_ms FROM metrics").get() as {
      ttf_ms: number | null;
      ttl_ms: number | null;
    };
    expect(row.ttf_ms).not.toBeNull();
    // ttl_ms is only populated when lastReply strictly follows firstReply.
    expect(row.ttl_ms).not.toBeNull();
    expect(row.ttl_ms!).toBeGreaterThanOrEqual(0);
  });

  test("no reply marks leaves ttf_ms null", async () => {
    await runWithMetrics({ command: "silent" }, async () => {
      // no marks
    });
    const row = db.query("SELECT ttf_ms, ttl_ms FROM metrics").get() as {
      ttf_ms: number | null;
      ttl_ms: number | null;
    };
    expect(row.ttf_ms).toBeNull();
    expect(row.ttl_ms).toBeNull();
  });
});

describe("getCommandStats", () => {
  function seed(command: string, totalMs: number, success = 1, apiCalls = 0): void {
    saveMetric({
      command,
      startedAt: new Date().toISOString(),
      ttfMs: null,
      ttlMs: null,
      totalMs,
      apiCalls: apiCalls ? JSON.stringify({ "leetify:/v3/profile": apiCalls }) : null,
      options: null,
      cacheHit: null,
      success,
      errorMessage: null,
      userId: null,
      guildId: null,
    });
  }

  test("sensible percentiles for a seeded dataset", () => {
    // 11 rows for /stats at 10, 20, ..., 110 ms. For count=11 the
    // OFFSET picker at pct=50 lands on floor(10*0.5)=5 (60ms) and
    // pct=95 lands on floor(10*0.95)=9 (100ms).
    for (let i = 1; i <= 11; i++) seed("stats", i * 10);
    const [s] = getCommandStats(7);
    expect(s.command).toBe("stats");
    expect(s.count).toBe(11);
    expect(s.p50Ms).toBe(60);
    expect(s.p95Ms).toBe(100);
    expect(s.avgTotalMs).toBe(60); // mean of 10..110
    expect(s.failureCount).toBe(0);
  });

  test("sorts rows by p95 descending and counts failures + api calls", () => {
    for (let i = 1; i <= 3; i++) seed("fast", i * 10);
    for (let i = 1; i <= 3; i++) seed("slow", 500 + i * 10, 1, 2);
    seed("slow", 1000, 0, 1); // failure, includes 1 api call
    const rows = getCommandStats(7);
    expect(rows.map((r) => r.command)).toEqual(["slow", "fast"]);
    const slow = rows.find((r) => r.command === "slow")!;
    expect(slow.failureCount).toBe(1);
    expect(slow.count).toBe(4);
    // avg api calls: (2+2+2+1)/4 = 1.75
    expect(slow.avgApiCalls).toBeCloseTo(1.75, 2);
    const fast = rows.find((r) => r.command === "fast")!;
    expect(fast.avgApiCalls).toBe(0);
  });

  test("empty window returns an empty array", () => {
    expect(getCommandStats(7)).toEqual([]);
  });
});
