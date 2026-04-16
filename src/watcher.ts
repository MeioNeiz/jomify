import { type Client, EmbedBuilder } from "discord.js";
import {
  checkBigMatch,
  checkStreakAlerts,
  mentionOrName,
  scanOpponents,
  sendToGuilds,
} from "./alerts.js";
import { config } from "./config.js";
import {
  getMatchDetails,
  getMatchHistory,
  getProfile,
  LeetifyUnavailableError,
} from "./leetify/client.js";
import type { LeetifyMatchDetails, LeetifyProfile } from "./leetify/types.js";
import log from "./logger.js";
import {
  getAllTrackedSteamIds,
  getPlayerStatAverages,
  getStoredMatchCount,
  isMatchProcessed,
  markMatchProcessed,
  recordPremierAfter,
  saveMatchDetails,
  updatePlayerStreak,
} from "./store.js";

const BAD_GAME_RATING = -0.05;
const GREAT_GAME_RATING = 0.08;

const lastKnownPremier = new Map<string, number>();

// Bulk load all match history for a new player.
export async function backfillPlayer(steamId: string): Promise<number> {
  const stored = getStoredMatchCount(steamId);
  if (stored > 0) return stored;

  try {
    const matches = await getMatchHistory(steamId);
    for (const match of matches) {
      try {
        saveMatchDetails(match);
        markMatchProcessed(match.id, steamId, match.finished_at);
      } catch {
        // Skip this match, continue with rest
      }
    }

    const profile = await getProfile(steamId);
    if (profile.ranks?.premier != null) {
      lastKnownPremier.set(steamId, profile.ranks.premier);
    }

    return matches.length;
  } catch (err) {
    log.error({ steamId, err }, "Backfill failed");
    return 0;
  }
}

// ── Main check loop ──

async function checkPlayer(client: Client, steamId: string) {
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

  // Check recent matches for new ones
  for (const match of profile.recent_matches ?? []) {
    if (isMatchProcessed(match.id, steamId)) {
      continue;
    }

    markMatchProcessed(match.id, steamId, match.finished_at);

    // Fetch and store full match details
    let details: LeetifyMatchDetails | null = null;
    try {
      details = await getMatchDetails(match.id);
      saveMatchDetails(details);
      // Stamp the per-match Premier snapshot so /carry can compute rating
      // deltas. Leetify exposes this on the match itself as `rank` when
      // `rank_type` is the premier system. If not, fall back to the
      // profile's current premier (close enough when the match is the
      // most recent one we're processing).
      const rank =
        match.rank_type?.toLowerCase().includes("premier") && match.rank
          ? match.rank
          : currentPremier;
      if (rank != null) recordPremierAfter(match.id, steamId, rank);
    } catch (err) {
      log.warn({ matchId: match.id, err }, "Failed to fetch match");
    }

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

    // Win/loss streak tracking
    const outcome = match.outcome as "win" | "loss" | "tie";
    if (outcome === "win" || outcome === "loss" || outcome === "tie") {
      const streak = updatePlayerStreak(steamId, outcome);
      await checkStreakAlerts(client, steamId, player, streak);
    }

    // Auto-scan opponents for sus players
    if (details) {
      await scanOpponents(client, steamId, details);
    }
  }
}

const CYCLE_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 1_000;

export function startWatcher(client: Client) {
  const steamIds = getAllTrackedSteamIds();
  (async () => {
    for (const id of steamIds) {
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
        log.warn({ steamId: id }, "Startup seed failed");
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
