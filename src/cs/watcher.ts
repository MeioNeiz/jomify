import { type Client, EmbedBuilder } from "discord.js";
import { config } from "../config.js";
import { logError } from "../errors.js";
import { emit } from "../events.js";
import log from "../logger.js";
import {
  checkBigMatch,
  checkStreakAlerts,
  mentionOrName,
  scanOpponents,
  sendToGuilds,
} from "./alerts.js";
import {
  getMatchDetails,
  getMatchHistory,
  getProfile,
  LeetifyNotFoundError,
  LeetifyUnavailableError,
} from "./leetify/client.js";
import type { LeetifyMatchDetails, LeetifyProfile } from "./leetify/types.js";
import {
  getAllTrackedSteamIds,
  getDiscordId,
  getPlayerStatAverages,
  getStoredMatchCount,
  hasMatchStats,
  isLeetifyUnknown,
  isMatchProcessed,
  markMatchProcessed,
  recordPremierAfter,
  saveMatchDetails,
  updatePlayerStreak,
} from "./store.js";

const BAD_GAME_RATING = -0.05;
const GREAT_GAME_RATING = 0.08;

const lastKnownPremier = new Map<string, number>();

// Steam IDs of other tracked players on the same team as `self` in this
// match. Used by the cs:match-completed event to feed betting's squad
// multiplier without coupling the watcher to betting's rules.
function trackedTeammatesFrom(details: LeetifyMatchDetails, self: string): string[] {
  const selfStats = details.stats.find((s) => s.steam64_id === self);
  if (!selfStats) return [];
  const tracked = new Set(getAllTrackedSteamIds());
  return details.stats
    .filter((s) => s.initial_team_number === selfStats.initial_team_number)
    .map((s) => s.steam64_id)
    .filter((id) => id !== self && tracked.has(id));
}

// Bulk load all match history for a new player.
//
// We intentionally hit /v2/matches/{id} per match rather than trusting
// the abbreviated stats returned by /v3/profile/matches — the history
// endpoint only returns the target's team (3-5 players), so it can't
// power /suspects opponent analysis. Costs 1 + N API calls per
// backfill; one-time per new player and the watcher handles everything
// else going forward.
export async function backfillPlayer(steamId: string): Promise<number> {
  const stored = getStoredMatchCount(steamId);
  if (stored > 0) return stored;

  if (isLeetifyUnknown(steamId)) return 0;

  try {
    const matches = await getMatchHistory(steamId);
    let saved = 0;
    for (const match of matches) {
      try {
        const full = await getMatchDetails(match.id);
        saveMatchDetails(full);
        markMatchProcessed(match.id, steamId, match.finished_at);
        saved++;
      } catch {
        // Per-match failure shouldn't abort the whole backfill — the
        // watcher will retry on subsequent polls.
      }
    }

    const profile = await getProfile(steamId);
    if (profile.ranks?.premier != null) {
      lastKnownPremier.set(steamId, profile.ranks.premier);
    }

    return saved;
  } catch (err) {
    if (err instanceof LeetifyNotFoundError) return 0;
    logError("watcher:backfill", err, { steamId });
    return 0;
  }
}

// ── Main check loop ──

async function checkPlayer(client: Client, steamId: string) {
  if (isLeetifyUnknown(steamId)) return;
  let profile: LeetifyProfile;
  try {
    profile = await getProfile(steamId);
  } catch {
    return;
  }

  const player = mentionOrName(steamId, profile.name);

  // Check for rank changes
  const currentPremier = profile.ranks?.premier;
  const prevPremier = lastKnownPremier.get(steamId);

  if (currentPremier != null && prevPremier != null && currentPremier !== prevPremier) {
    const diff = currentPremier - prevPremier;
    if (diff > 0) {
      const embed = new EmbedBuilder()
        .setTitle("Rank Up!")
        .setColor(0x00ff00)
        .setDescription(
          `${player} ranked up!\n\n` +
            `**${prevPremier.toLocaleString()}` +
            `** \u2192 ` +
            `**${currentPremier.toLocaleString()}` +
            `** (+${diff})`,
        );
      await sendToGuilds(client, steamId, embed);
    }
  }

  if (currentPremier != null) {
    lastKnownPremier.set(steamId, currentPremier);
  }

  // Check recent matches for new ones. Detail-fetch and alerts are
  // now tracked separately: we retry getMatchDetails until match_stats
  // is populated (so transient Leetify failures don't permanently black
  // -hole a match), but alerts fire at most once per match.
  for (const match of profile.recent_matches ?? []) {
    const alertsSent = isMatchProcessed(match.id, steamId);
    const detailsSaved = hasMatchStats(match.id, steamId);

    let details: LeetifyMatchDetails | null = null;
    if (!detailsSaved) {
      try {
        details = await getMatchDetails(match.id);
        saveMatchDetails(details);
        // Stamp the per-match Premier snapshot so /carry can compute rating
        // deltas. Premier ratings are 4-5 digits; competitive ranks are 1-18.
        // Leetify's `rank_type` is now an opaque numeric enum so we just
        // gate on the magnitude of `rank` itself.
        const rank =
          typeof match.rank === "number" && match.rank >= 1000
            ? match.rank
            : currentPremier;
        if (rank != null) recordPremierAfter(match.id, steamId, rank);
      } catch (err) {
        logError("watcher:match-details", err, { matchId: match.id }, "warn");
      }
    }

    if (alertsSent) continue;
    markMatchProcessed(match.id, steamId, match.finished_at);

    const avgs = getPlayerStatAverages(steamId);

    if (match.leetify_rating <= BAD_GAME_RATING) {
      let desc =
        `${player} had a shocker on ` +
        `**${match.map_name}**\n\n` +
        `Rating: **` +
        `${match.leetify_rating.toFixed(2)}` +
        `**\n` +
        `Score: ${match.score[0]}` +
        `-${match.score[1]} ` +
        `(${match.outcome})`;

      if (avgs && avgs.avg_rating != null) {
        const diff = match.leetify_rating - avgs.avg_rating;
        desc +=
          `\nAvg rating: ` +
          `${avgs.avg_rating.toFixed(2)} ` +
          `(${diff.toFixed(2)} from avg)`;
      }

      const embed = new EmbedBuilder()
        .setTitle("Rough Game")
        .setColor(0xff0000)
        .setDescription(desc);
      await sendToGuilds(client, steamId, embed);
    }

    if (match.leetify_rating >= GREAT_GAME_RATING) {
      let desc =
        `${player} went off on ` +
        `**${match.map_name}**\n\n` +
        `Rating: **` +
        `${match.leetify_rating.toFixed(2)}` +
        `**\n` +
        `Score: ${match.score[0]}` +
        `-${match.score[1]} ` +
        `(${match.outcome})`;

      if (avgs && avgs.avg_rating != null) {
        const diff = match.leetify_rating - avgs.avg_rating;
        desc +=
          `\nAvg rating: ` +
          `${avgs.avg_rating.toFixed(2)} ` +
          `(+${diff.toFixed(2)} above avg)`;
      }

      const embed = new EmbedBuilder()
        .setTitle("Great Game!")
        .setColor(0x00ff00)
        .setDescription(desc);
      await sendToGuilds(client, steamId, embed);
    }

    // Big match alerts
    if (details) {
      const achievements = checkBigMatch(details, steamId);
      if (achievements.length > 0) {
        const desc = `${player} on **${match.map_name}**\n\n${achievements.join("\n")}`;
        const embed = new EmbedBuilder()
          .setTitle("Monster Game!")
          .setColor(0x00ff00)
          .setDescription(desc);
        await sendToGuilds(client, steamId, embed);
      }
    }

    // Win/loss streak tracking — also captured for the event payload
    // below so downstream subscribers (betting) can penalise losing
    // streaks without re-querying the streaks table.
    const outcome = match.outcome as "win" | "loss" | "tie";
    const knownOutcome = outcome === "win" || outcome === "loss" || outcome === "tie";
    let streakType: "win" | "loss" | "tie" = "tie";
    let streakCount = 0;
    if (knownOutcome) {
      const streak = updatePlayerStreak(steamId, outcome);
      streakType = streak.streakType as "win" | "loss" | "tie";
      streakCount = streak.streakCount;
      await checkStreakAlerts(client, steamId, player, streak);
    }

    // Auto-scan opponents for sus players
    if (details) {
      await scanOpponents(client, steamId, details);
    }

    // Fan-out to non-CS subscribers (e.g. betting). Gated by the same
    // alertsSent guard above, so it fires at most once per (matchId,
    // steamId). Teammates list is empty when the details fetch failed
    // this cycle — subscribers must tolerate that.
    if (knownOutcome) {
      const selfStats = details?.stats.find((s) => s.steam64_id === steamId) ?? null;
      emit("cs:match-completed", {
        matchId: match.id,
        steamId,
        discordId: getDiscordId(steamId),
        rating: match.leetify_rating,
        outcome,
        premierDelta:
          currentPremier != null && prevPremier != null
            ? currentPremier - prevPremier
            : null,
        trackedTeammates: details ? trackedTeammatesFrom(details, steamId) : [],
        mapName: match.map_name,
        finishedAt: match.finished_at,
        stats: selfStats
          ? {
              flashbangHitFriend: selfStats.flashbang_hit_friend,
              heFriendsDamageAvg: selfStats.he_friends_damage_avg,
              shotsHitFriend: selfStats.shots_hit_friend,
              shotsHitFriendHead: selfStats.shots_hit_friend_head,
              streakType,
              streakCount,
            }
          : null,
      });
    }
  }
}

// Full-cycle = each tracked player polled once. 10 minutes keeps the
// alert latency tolerable (matches rarely finish within 10 min of
// starting) while roughly halving the baseline Leetify API load
// compared to the old 5-minute cycle.
const CYCLE_MS = 10 * 60 * 1000;
const MIN_GAP_MS = 1_000;

export function startWatcher(client: Client) {
  const steamIds = getAllTrackedSteamIds();
  (async () => {
    for (const id of steamIds) {
      if (isLeetifyUnknown(id)) continue;
      try {
        const p = await getProfile(id);
        if (p.ranks?.premier != null) {
          lastKnownPremier.set(id, p.ranks.premier);
        }
        for (const m of p.recent_matches ?? []) {
          markMatchProcessed(m.id, id, m.finished_at);
        }
      } catch (err) {
        if (err instanceof LeetifyUnavailableError) break;
        if (err instanceof LeetifyNotFoundError) continue;
        logError("watcher:startup-seed", err, { steamId: id }, "warn");
      }
      await new Promise((r) => setTimeout(r, MIN_GAP_MS));
    }
  })();

  // Rotate: one player per tick, gap = CYCLE_MS / playerCount (min 1s).
  // Spreads API load evenly across the cycle instead of bursting every 5 min.
  let queue: string[] = [];
  const tick = async () => {
    if (queue.length === 0) {
      queue = [...getAllTrackedSteamIds()];
      // Heartbeat at the start of each cycle. If this ping stops arriving
      // at Healthchecks.io, the bot has stalled or crashed and we get an
      // email within the configured grace period.
      if (config.healthcheckUrl) {
        fetch(config.healthcheckUrl).catch(() => undefined);
      }
    }
    const id = queue.shift();
    if (id) await checkPlayer(client, id);
    const count = Math.max(queue.length, getAllTrackedSteamIds().length);
    const gap = Math.max(MIN_GAP_MS, Math.floor(CYCLE_MS / (count || 1)));
    setTimeout(tick, gap);
  };
  setTimeout(tick, MIN_GAP_MS);

  log.info({ players: steamIds.length }, "Watcher started");
}
