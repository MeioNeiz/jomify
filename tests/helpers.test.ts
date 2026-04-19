import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { getProfile } from "../src/cs/leetify/client.js";
import { fmt, freshnessSuffix, requireGuild } from "../src/helpers.js";
import { COLOURS } from "../src/ui.js";

process.env.LEETIFY_API_KEY ??= "test-key";

describe("fmt", () => {
  test("formats number with default 1 decimal", () => {
    expect(fmt(72.2405)).toBe("72.2");
  });

  test("formats number with custom decimals", () => {
    expect(fmt(0.1618, 2)).toBe("0.16");
  });

  test("returns N/A for null", () => {
    expect(fmt(null)).toBe("N/A");
  });

  test("returns N/A for undefined", () => {
    expect(fmt(undefined)).toBe("N/A");
  });

  test("formats zero", () => {
    expect(fmt(0)).toBe("0.0");
  });
});

describe("requireGuild", () => {
  test("returns guildId when present", async () => {
    const interaction = {
      guildId: "123",
      editReply: async () => {},
    } as unknown as ChatInputCommandInteraction;
    expect(await requireGuild(interaction)).toBe("123");
  });

  test("returns null and replies when no guildId", async () => {
    let replied: unknown = null;
    const interaction = {
      guildId: null,
      editReply: async (m: unknown) => {
        replied = m;
      },
    } as unknown as ChatInputCommandInteraction;
    expect(await requireGuild(interaction)).toBeNull();
    expect(replied).toBe("Use this in a server.");
  });
});

describe("COLOURS.brand", () => {
  test("is the correct hex value", () => {
    expect(COLOURS.brand).toBe(0xf84982);
  });
});

describe("freshnessSuffix", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("shows just the timestamp while Leetify is healthy", () => {
    const iso = new Date(Date.now() - 60_000).toISOString();
    const suffix = freshnessSuffix(iso, "snapshot from");
    expect(suffix).toContain("snapshot from");
    expect(suffix).not.toContain("Leetify unavailable");
  });

  test("appends Leetify unavailable note when the circuit breaker trips", async () => {
    // Four consecutive 503s trip the breaker inside leetifyFetch.
    // Retry-After: 0 skips the retry backoff so we don't wait real seconds.
    globalThis.fetch = mock(
      async () =>
        new Response("", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "Retry-After": "0" },
        }),
    ) as unknown as typeof fetch;

    await getProfile("76561198000000001").catch(() => undefined);

    const suffix = freshnessSuffix(
      new Date(Date.now() - 3600_000).toISOString(),
      "snapshot from",
    );
    expect(suffix).toContain("Leetify unavailable");
  });
});
