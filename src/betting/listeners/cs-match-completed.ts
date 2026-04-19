// Betting's side of the cs:match-completed contract. Subscribes at
// module-init; imported for side effect from src/index.ts.
//
// This is the live path for balance grants. Backdating historical
// matches belongs in a separate admin script (not runtime), which can
// read from CS's match_stats directly — see betting-plan.md phase 3.7.
import { getGuildsForSteamId } from "../../cs/store.js";
import { logError } from "../../errors.js";
import type { EventMap } from "../../events.js";
import { on } from "../../events.js";
import log from "../../logger.js";
import {
  BAD_GAME_RATING,
  MATCH_GRANT_BASE,
  MATCH_GRANT_PER_TEAMMATE,
  MATCH_GRANT_WIN_BONUS,
  PENALTY_BAD_GAME,
  PENALTY_HE_FRIENDS,
  PENALTY_HE_FRIENDS_THRESHOLD,
  PENALTY_LOSS_STREAK,
  PENALTY_LOSS_STREAK_THRESHOLD,
  PENALTY_TEAM_FLASH,
  PENALTY_TEAM_FLASH_THRESHOLD,
  PENALTY_TEAMKILL,
  PENALTY_TEAMKILL_THRESHOLD,
} from "../config.js";
import { adjustBalance } from "../store.js";

type Event = EventMap["cs:match-completed"];

// Returns the net credits (can go negative on a real grief match). Pure
// function so tests can pin the grant formula against a payload
// without touching the DB.
export function computeMatchDelta(e: Event): number {
  let delta = MATCH_GRANT_BASE + MATCH_GRANT_PER_TEAMMATE * e.trackedTeammates.length;
  if (e.outcome === "win") delta += MATCH_GRANT_WIN_BONUS;
  if (e.rating <= BAD_GAME_RATING) delta -= PENALTY_BAD_GAME;
  const s = e.stats;
  if (s) {
    if (s.flashbangHitFriend >= PENALTY_TEAM_FLASH_THRESHOLD) delta -= PENALTY_TEAM_FLASH;
    if (s.heFriendsDamageAvg >= PENALTY_HE_FRIENDS_THRESHOLD) delta -= PENALTY_HE_FRIENDS;
    if (s.shotsHitFriendHead >= PENALTY_TEAMKILL_THRESHOLD) delta -= PENALTY_TEAMKILL;
    if (s.streakType === "loss" && s.streakCount >= PENALTY_LOSS_STREAK_THRESHOLD) {
      delta -= PENALTY_LOSS_STREAK;
    }
  }
  return delta;
}

on("cs:match-completed", (e) => {
  try {
    // Betting wallets are keyed on (discord_id, guild_id). Matches from
    // a tracked but unlinked Steam account have no one to credit — skip.
    if (!e.discordId) return;
    const delta = computeMatchDelta(e);
    if (delta === 0) return;
    // Apply the grant to every guild that tracks this steam ID.
    const guildIds = getGuildsForSteamId(e.steamId);
    for (const guildId of guildIds) {
      const next = adjustBalance(e.discordId, guildId, delta, "match", e.matchId);
      log.debug(
        { discordId: e.discordId, guildId, matchId: e.matchId, delta, balance: next },
        delta > 0 ? "granted match credits" : "deducted match penalty",
      );
    }
  } catch (err) {
    // Never throw back into the emitter — it will swallow and write to
    // the errors table anyway, but an explicit log here gives the row a
    // more specific source tag for Datasette queries.
    logError("betting:grant-match", err, { payload: e });
  }
});
