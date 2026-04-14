import {
  describe,
  test,
  expect,
  beforeEach,
} from "bun:test";
import { Database } from "bun:sqlite";

// Use in-memory DB for tests
import db from "../src/db.js";

import {
  addTrackedPlayer,
  removeTrackedPlayer,
  getTrackedPlayers,
  linkAccount,
  getSteamId,
  getDiscordId,
  isMatchProcessed,
  markMatchProcessed,
  setNotifyChannel,
  getNotifyChannel,
  saveLeaderboardSnapshot,
  getLastLeaderboard,
} from "../src/store.js";

const GUILD = "test-guild";
const STEAM = "76561198000000001";
const DISCORD = "123456789";

beforeEach(() => {
  db.run("DELETE FROM tracked_players");
  db.run("DELETE FROM linked_accounts");
  db.run("DELETE FROM processed_matches");
  db.run("DELETE FROM guild_config");
  db.run("DELETE FROM leaderboard_snapshots");
  db.run("DELETE FROM snapshots");
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
    expect(
      isMatchProcessed("match-1", "other-steam")
    ).toBe(false);
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
  test("no previous returns empty", () => {
    expect(getLastLeaderboard(GUILD)).toEqual([]);
  });

  test("saves and retrieves snapshot", () => {
    const entries = [
      { steamId: STEAM, premier: 15000 },
      { steamId: "other", premier: 12000 },
    ];
    saveLeaderboardSnapshot(GUILD, entries);
    const result = getLastLeaderboard(GUILD);
    expect(result).toHaveLength(2);
    expect(
      result.find((r) => r.steamId === STEAM)?.premier
    ).toBe(15000);
  });
});
