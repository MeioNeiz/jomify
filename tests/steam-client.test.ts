import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolveSteamId } from "../src/steam/client.js";

process.env.STEAM_API_KEY = "test-key";

const realFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string) => { status?: number; body: unknown } | Promise<never>,
) {
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const result = await handler(String(url));
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("resolveSteamId", () => {
  test("accepts raw steam64 without calling Steam", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response();
    }) as unknown as typeof fetch;
    const result = await resolveSteamId("76561198091612253");
    expect(result).toEqual({ ok: true, steamId: "76561198091612253" });
    expect(called).toBe(false);
  });

  test("extracts steam64 from profiles/ URL without calling Steam", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response();
    }) as unknown as typeof fetch;
    const result = await resolveSteamId(
      "https://steamcommunity.com/profiles/76561198091612253/",
    );
    expect(result).toEqual({ ok: true, steamId: "76561198091612253" });
    expect(called).toBe(false);
  });

  test("resolves vanity URL via Steam API", async () => {
    mockFetch(() => ({
      body: { response: { steamid: "76561198143965239", success: 1 } },
    }));
    const result = await resolveSteamId("https://steamcommunity.com/id/Axeman2202");
    expect(result).toEqual({ ok: true, steamId: "76561198143965239" });
  });

  test("resolves bare vanity handle", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return {
        body: { response: { steamid: "76561198091764051", success: 1 } },
      };
    });
    const result = await resolveSteamId("laryisland");
    expect(result).toEqual({ ok: true, steamId: "76561198091764051" });
    expect(capturedUrl).toContain("vanityurl=laryisland");
    expect(capturedUrl).toContain("key=test-key");
  });

  test("url-encodes vanity handles with special characters", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return { body: { response: { success: 42 } } };
    });
    await resolveSteamId("foo+bar&baz");
    expect(capturedUrl).toContain("vanityurl=foo%2Bbar%26baz");
  });

  test("returns not-found when Steam reports no match (success=42)", async () => {
    mockFetch(() => ({
      body: { response: { success: 42, message: "No match" } },
    }));
    const result = await resolveSteamId("doesnotexist_xyz");
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  test("returns api-error on non-2xx", async () => {
    mockFetch(() => ({ status: 500, body: {} }));
    const result = await resolveSteamId("Axeman2202");
    expect(result).toEqual({ ok: false, reason: "api-error" });
  });

  test("returns api-error on network failure", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    const result = await resolveSteamId("Axeman2202");
    expect(result).toEqual({ ok: false, reason: "api-error" });
  });

  test("returns api-error when response shape is invalid", async () => {
    mockFetch(() => ({ body: { unexpected: "shape" } }));
    const result = await resolveSteamId("Axeman2202");
    expect(result).toEqual({ ok: false, reason: "api-error" });
  });

  test("rejects empty input without calling Steam", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response();
    }) as unknown as typeof fetch;
    const result = await resolveSteamId("   ");
    expect(result).toEqual({ ok: false, reason: "invalid-input" });
    expect(called).toBe(false);
  });

  test("rejects garbage with slashes (malformed URLs)", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response();
    }) as unknown as typeof fetch;
    const result = await resolveSteamId("http://evil.example.com/whatever");
    expect(result).toEqual({ ok: false, reason: "invalid-input" });
    expect(called).toBe(false);
  });

  test("trims surrounding whitespace", async () => {
    const result = await resolveSteamId("  76561198091612253  ");
    expect(result).toEqual({ ok: true, steamId: "76561198091612253" });
  });

  test("group/clan IDs (not starting with 7656119) are treated as vanity", async () => {
    // Group ids start with 103582791, so they shouldn't pass the steam64 check
    // and should fall through to vanity lookup.
    mockFetch(() => ({ body: { response: { success: 42 } } }));
    const result = await resolveSteamId("10358279142952140812345678");
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });
});
