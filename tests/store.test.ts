import { beforeEach, describe, expect, test } from "bun:test";
// Use in-memory DB for tests
import { sqlite as csDb } from "../src/cs/db.js";
import {
  addTrackedPlayer,
  clearLeetifyUnknown,
  getDiscordId,
  getLastLeaderboard,
  getLeaderboardBefore,
  getSteamId,
  getTrackedPlayers,
  isLeetifyUnknown,
  isMatchProcessed,
  linkAccount,
  markLeetifyUnknown,
  markMatchProcessed,
  removeTrackedPlayer,
  saveLeaderboardSnapshot,
} from "../src/cs/store.js";
import { sqlite as db } from "../src/db.js";
import { getNotifyChannel, setNotifyChannel } from "../src/store.js";

const GUILD = "test-guild";
const STEAM = "76561198000000001";
const DISCORD = "123456789";

beforeEach(() => {
  csDb.run("DELETE FROM tracked_players");
  db.run("DELETE FROM linked_accounts");
  csDb.run("DELETE FROM processed_matches");
  db.run("DELETE FROM guild_config");
  csDb.run("DELETE FROM leaderboard_snapshots");
  csDb.run("DELETE FROM snapshots");
  csDb.run("DELETE FROM leetify_unknown");
});

describe("tracked players", () => {
  test("add and get", () => {
    addTrackedPlayer(GUILD, STEAM);
    expect(getTrackedPlayers(GUILD)).toEqual([STEAM]);
  });

  test("add duplicate is ignored", () => {
    addTrackedPlayer(GUILD, STEAM);
    addTrackedPlayer(GUILD, STEAM);
    expect(getTrackedPlayers(GUILD)).toEqual([STEAM]);
  });

  test("remove", () => {
    addTrackedPlayer(GUILD, STEAM);
    removeTrackedPlayer(GUILD, STEAM);
    expect(getTrackedPlayers(GUILD)).toEqual([]);
  });

  test("empty guild returns empty array", () => {
    expect(getTrackedPlayers(GUILD)).toEqual([]);
  });

  test("players are scoped to guild", () => {
    addTrackedPlayer("guild-a", STEAM);
    expect(getTrackedPlayers("guild-b")).toEqual([]);
  });

  test("rejects non-steam64 values — guards against vanity-URL regression", () => {
    // The assertSteam64 check here stops a future caller that forgot
    // to go through resolveSteamId from silently persisting junk,
    // which is exactly how /carry and /suspects started returning
    // empty for four users.
    expect(() => addTrackedPlayer(GUILD, "laryisland")).toThrow(/Steam64/);
    expect(() => addTrackedPlayer(GUILD, "http://steamcommunity.com/id/x")).toThrow(
      /Steam64/,
    );
    // Clan/group IDs start with 103582791, not 7656119 — also rejected.
    expect(() => addTrackedPlayer(GUILD, "10358279142952140")).toThrow(/Steam64/);
    // Exactly 17 digits but wrong prefix.
    expect(() => addTrackedPlayer(GUILD, "12345678901234567")).toThrow(/Steam64/);
  });
});

describe("linked accounts", () => {
  test("link and get steam id", () => {
    linkAccount(DISCORD, STEAM);
    expect(getSteamId(DISCORD)).toBe(STEAM);
  });

  test("link and get discord id", () => {
    linkAccount(DISCORD, STEAM);
    expect(getDiscordId(STEAM)).toBe(DISCORD);
  });

  test("unlinked returns null", () => {
    expect(getSteamId("unknown")).toBeNull();
    expect(getDiscordId("unknown")).toBeNull();
  });

  test("re-linking updates steam id", () => {
    linkAccount(DISCORD, STEAM);
    const newSteam = "76561198000000002";
    linkAccount(DISCORD, newSteam);
    expect(getSteamId(DISCORD)).toBe(newSteam);
  });

  test("rejects non-steam64 values — guards against vanity-URL regression", () => {
    // linkAccount is the other user-input write path for steam_ids.
    // This test guarantees that bypassing resolveSteamId (from /link
    // or any future command) fails loudly rather than silently storing
    // a vanity string that would later read back as junk.
    expect(() => linkAccount(DISCORD, "laryisland")).toThrow(/Steam64/);
    expect(() => linkAccount(DISCORD, "Axeman2202")).toThrow(/Steam64/);
    expect(() => linkAccount(DISCORD, "")).toThrow(/Steam64/);
  });
});

describe("processed matches", () => {
  test("unprocessed match returns false", () => {
    expect(isMatchProcessed("match-1", STEAM)).toBe(false);
  });

  test("processed match returns true", () => {
    markMatchProcessed("match-1", STEAM, "2026-01-01");
    expect(isMatchProcessed("match-1", STEAM)).toBe(true);
  });

  test("same match different player is separate", () => {
    markMatchProcessed("match-1", STEAM, "2026-01-01");
    expect(isMatchProcessed("match-1", "other-steam")).toBe(false);
  });
});

describe("guild config", () => {
  test("set and get notify channel", () => {
    setNotifyChannel(GUILD, "channel-1");
    expect(getNotifyChannel(GUILD)).toBe("channel-1");
  });

  test("unconfigured guild returns null", () => {
    expect(getNotifyChannel(GUILD)).toBeNull();
  });

  test("updating channel overwrites", () => {
    setNotifyChannel(GUILD, "channel-1");
    setNotifyChannel(GUILD, "channel-2");
    expect(getNotifyChannel(GUILD)).toBe("channel-2");
  });
});

describe("leaderboard snapshots", () => {
  test("no previous returns empty with null recordedAt", () => {
    expect(getLastLeaderboard(GUILD)).toEqual({ recordedAt: null, entries: [] });
  });

  test("saves and retrieves snapshot", () => {
    const entries = [
      { steamId: STEAM, premier: 15000 },
      { steamId: "other", premier: 12000 },
    ];
    saveLeaderboardSnapshot(GUILD, entries);
    const result = getLastLeaderboard(GUILD);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((r) => r.steamId === STEAM)?.premier).toBe(15000);
    expect(result.recordedAt).not.toBeNull();
  });

  test("getLeaderboardBefore returns the snapshot prior to cutoff + its timestamp", () => {
    // Three historical snapshots via raw SQL so we control recorded_at.
    csDb.run(
      "INSERT INTO leaderboard_snapshots (guild_id, steam_id, premier, recorded_at) VALUES (?, ?, ?, ?)",
      [GUILD, STEAM, 14000, "2026-04-15 10:00:00"],
    );
    csDb.run(
      "INSERT INTO leaderboard_snapshots (guild_id, steam_id, premier, recorded_at) VALUES (?, ?, ?, ?)",
      [GUILD, STEAM, 14500, "2026-04-16 10:00:00"],
    );
    csDb.run(
      "INSERT INTO leaderboard_snapshots (guild_id, steam_id, premier, recorded_at) VALUES (?, ?, ?, ?)",
      [GUILD, STEAM, 15000, "2026-04-17 10:00:00"],
    );
    const prev = getLeaderboardBefore(GUILD, "2026-04-17 10:00:00");
    expect(prev.entries).toHaveLength(1);
    expect(prev.entries[0].premier).toBe(14500);
    expect(prev.recordedAt).toBe("2026-04-16 10:00:00");
  });

  test("getLeaderboardBefore returns null recordedAt when no earlier snapshot exists", () => {
    csDb.run(
      "INSERT INTO leaderboard_snapshots (guild_id, steam_id, premier, recorded_at) VALUES (?, ?, ?, ?)",
      [GUILD, STEAM, 14000, "2026-04-17 10:00:00"],
    );
    expect(getLeaderboardBefore(GUILD, "2026-04-17 10:00:00")).toEqual({
      recordedAt: null,
      entries: [],
    });
  });
});

describe("leetify-unknown marker", () => {
  test("unmarked player returns false", () => {
    expect(isLeetifyUnknown(STEAM)).toBe(false);
  });

  test("mark then check", () => {
    markLeetifyUnknown(STEAM);
    expect(isLeetifyUnknown(STEAM)).toBe(true);
  });

  test("clear removes the mark", () => {
    markLeetifyUnknown(STEAM);
    clearLeetifyUnknown(STEAM);
    expect(isLeetifyUnknown(STEAM)).toBe(false);
  });

  test("mark is idempotent (updates last_checked)", () => {
    markLeetifyUnknown(STEAM);
    markLeetifyUnknown(STEAM);
    expect(isLeetifyUnknown(STEAM)).toBe(true);
    const rows = csDb.query("SELECT * FROM leetify_unknown").all();
    expect(rows).toHaveLength(1);
  });

  test("stale marks (>24h) are treated as unknown=false", () => {
    csDb.run(
      "INSERT INTO leetify_unknown (steam_id, first_seen, last_checked) VALUES (?, datetime('now', '-30 days'), datetime('now', '-30 hours'))",
      [STEAM],
    );
    expect(isLeetifyUnknown(STEAM)).toBe(false);
  });

  test("marks are isolated per steam id", () => {
    markLeetifyUnknown(STEAM);
    expect(isLeetifyUnknown("76561198000000002")).toBe(false);
  });
});
