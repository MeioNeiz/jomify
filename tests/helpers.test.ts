import { describe, expect, test } from "bun:test";
import { BRAND_COLOUR, fmt, requireGuild } from "../src/helpers.js";

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
    const interaction = { guildId: "123", editReply: async () => {} } as any;
    expect(await requireGuild(interaction)).toBe("123");
  });

  test("returns null and replies when no guildId", async () => {
    let replied: unknown = null;
    const interaction = {
      guildId: null,
      editReply: async (m: unknown) => {
        replied = m;
      },
    } as any;
    expect(await requireGuild(interaction)).toBeNull();
    expect(replied).toBe("Use this in a server.");
  });
});

describe("BRAND_COLOUR", () => {
  test("is the correct hex value", () => {
    expect(BRAND_COLOUR).toBe(0xf84982);
  });
});
