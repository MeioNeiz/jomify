import { describe, test, expect } from "bun:test";
import { fmt, requireGuild, BRAND_COLOUR } from "../src/helpers.js";

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
  test("returns guildId when present", () => {
    const interaction = { guildId: "123" } as any;
    expect(requireGuild(interaction)).toBe("123");
  });

  test("returns null when no guildId", () => {
    const interaction = { guildId: null } as any;
    expect(requireGuild(interaction)).toBeNull();
  });
});

describe("BRAND_COLOUR", () => {
  test("is the correct hex value", () => {
    expect(BRAND_COLOUR).toBe(0xf84982);
  });
});
