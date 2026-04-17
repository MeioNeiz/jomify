import { beforeEach, describe, expect, test } from "bun:test";

// Use in-memory DB for tests
import { sqlite as db } from "../src/db.js";

import {
  addTrackedPlayer,
  clearLeetifyUnknown,
  getDiscordId,
  getLastLeaderboard,
  getLeaderboardBefore,
  getNotifyChannel,
  getSteamId,
  getTrackedPlayers,
  isLeetifyUnknown,
  isMatchProcessed,
  linkAccount,
  markLeetifyUnknown,
  markMatchProcessed,
  removeTrackedPlayer,
  saveLeaderboardSnapshot,
  setNotifyChannel,
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
  db.run("DELETE FROM leetify_unknown");
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
    expect(result.find((r) => r.steamId === STEAM)?.premier).toBe(15000);
  });

  test("getLeaderboardBefore returns the snapshot prior to cutoff", () => {
    // Three historical snapshots via raw SQL so we control recorded_at.
    db.run(
      "INSERT INTO leaderboard_snapshots (guild_id, steam_id, premier, recorded_at) VALUES (?, ?, ?, ?)",
      [GUILD, STEAM, 14000, "2026-04-15 10:00:00"],
    );
    db.run(
      "INSERT INTO leaderboard_snapshots (guild_id, steam_id, premier, recorded_at) VALUES (?, ?, ?, ?)",
      [GUILD, STEAM, 14500, "2026-04-16 10:00:00"],
    );
    db.run(
      "INSERT INTO leaderboard_snapshots (guild_id, steam_id, premier, recorded_at) VALUES (?, ?, ?, ?)",
      [GUILD, STEAM, 15000, "2026-04-17 10:00:00"],
    );
    const prev = getLeaderboardBefore(GUILD, "2026-04-17 10:00:00");
    expect(prev).toHaveLength(1);
    expect(prev[0].premier).toBe(14500);
  });

  test("getLeaderboardBefore returns empty when no earlier snapshot exists", () => {
    db.run(
      "INSERT INTO leaderboard_snapshots (guild_id, steam_id, premier, recorded_at) VALUES (?, ?, ?, ?)",
      [GUILD, STEAM, 14000, "2026-04-17 10:00:00"],
    );
    expect(getLeaderboardBefore(GUILD, "2026-04-17 10:00:00")).toEqual([]);
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
    const rows = db.query("SELECT * FROM leetify_unknown").all();
    expect(rows).toHaveLength(1);
  });

  test("stale marks (>24h) are treated as unknown=false", () => {
    db.run(
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
