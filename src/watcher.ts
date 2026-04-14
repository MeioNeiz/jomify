import {
  Client,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import {
  getProfile,
  getMatchHistory,
  getMatchDetails,
} from "./leetify/client.js";
import {
  getAllTrackedSteamIds,
  getGuildsForSteamId,
  getNotifyChannel,
  isMatchProcessed,
  markMatchProcessed,
  getDiscordId,
  saveMatchDetails,
  getPlayerStatAverages,
  getProcessedMatchCount,
} from "./store.js";
import type { LeetifyProfile } from "./leetify/types.js";

const BAD_GAME_RATING = -0.05;
const GREAT_GAME_RATING = 0.08;

const lastKnownPremier = new Map<string, number>();

async function sendToGuilds(
  client: Client,
  steamId: string,
  embed: EmbedBuilder
) {
  const guilds = getGuildsForSteamId(steamId);
  for (const guildId of guilds) {
    const channelId = getNotifyChannel(guildId);
    if (!channelId) continue;
    try {
      const channel = await client.channels.fetch(
        channelId
      );
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({
          embeds: [embed],
        });
      }
    } catch (err) {
      console.error(
        `Failed to send to ${guildId}/${channelId}:`,
        err
      );
    }
  }
}

function mentionOrName(
  steamId: string,
  name: string
): string {
  const discordId = getDiscordId(steamId);
  return discordId ? `<@${discordId}>` : `**${name}**`;
}

// Bulk load all match history for a new player.
// Call this when a player is first tracked.
export async function backfillPlayer(
  steamId: string
): Promise<number> {
  const stored = getProcessedMatchCount(steamId);
  if (stored > 0) return stored;

  try {
    const matches = await getMatchHistory(steamId);
    for (const match of matches) {
      saveMatchDetails(match);
      markMatchProcessed(
        match.id, steamId, match.finished_at
      );
    }

    // Seed premier rank
    const profile = await getProfile(steamId);
    if (profile.ranks?.premier != null) {
      lastKnownPremier.set(
        steamId, profile.ranks.premier
      );
    }

    return matches.length;
  } catch (err) {
    console.error(
      `Backfill failed for ${steamId}:`, err
    );
    return 0;
  }
}

async function checkPlayer(
  client: Client,
  steamId: string
) {
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

  if (
    currentPremier != null
    && prevPremier != null
    && currentPremier !== prevPremier
  ) {
    const diff = currentPremier - prevPremier;
    if (diff > 0) {
      const embed = new EmbedBuilder()
        .setTitle("Rank Up!")
        .setColor(0x00ff00)
        .setDescription(
          `${player} ranked up!\n\n`
          + `**${prevPremier.toLocaleString()}** \u2192 `
          + `**${currentPremier.toLocaleString()}** `
          + `(+${diff})`
        )
        .setTimestamp();
      await sendToGuilds(client, steamId, embed);
    }
  }

  if (currentPremier != null) {
    lastKnownPremier.set(steamId, currentPremier);
  }

  // Check recent matches for new ones
  for (const match of profile.recent_matches ?? []) {
    if (isMatchProcessed(match.id, steamId)) continue;

    markMatchProcessed(
      match.id, steamId, match.finished_at
    );

    // Fetch and store full match details
    try {
      const details = await getMatchDetails(match.id);
      saveMatchDetails(details);
    } catch (err) {
      console.error(
        `Failed to fetch match ${match.id}:`, err
      );
    }

    const avgs = getPlayerStatAverages(steamId);

    if (match.leetify_rating <= BAD_GAME_RATING) {
      let desc =
        `${player} had a shocker on `
        + `**${match.map_name}**\n\n`
        + `Rating: **${match.leetify_rating.toFixed(2)}**\n`
        + `Score: ${match.score[0]}-${match.score[1]} `
        + `(${match.outcome})`;

      if (avgs && avgs.avg_rating != null) {
        const diff =
          match.leetify_rating - avgs.avg_rating;
        desc +=
          `\nAvg rating: ${avgs.avg_rating.toFixed(2)} `
          + `(${diff.toFixed(2)} from avg)`;
      }

      const embed = new EmbedBuilder()
        .setTitle("Rough Game")
        .setColor(0xff0000)
        .setDescription(desc)
        .setTimestamp();
      await sendToGuilds(client, steamId, embed);
    }

    if (match.leetify_rating >= GREAT_GAME_RATING) {
      let desc =
        `${player} went off on `
        + `**${match.map_name}**\n\n`
        + `Rating: **${match.leetify_rating.toFixed(2)}**\n`
        + `Score: ${match.score[0]}-${match.score[1]} `
        + `(${match.outcome})`;

      if (avgs && avgs.avg_rating != null) {
        const diff =
          match.leetify_rating - avgs.avg_rating;
        desc +=
          `\nAvg rating: ${avgs.avg_rating.toFixed(2)} `
          + `(+${diff.toFixed(2)} above avg)`;
      }

      const embed = new EmbedBuilder()
        .setTitle("Great Game!")
        .setColor(0x00ff00)
        .setDescription(desc)
        .setTimestamp();
      await sendToGuilds(client, steamId, embed);
    }
  }
}

export function startWatcher(client: Client) {
  // Seed premier ranks for existing players on startup
  // (no backfill — that happens when they're first
  // tracked)
  const steamIds = getAllTrackedSteamIds();
  for (const id of steamIds) {
    getProfile(id)
      .then((p) => {
        if (p.ranks?.premier != null) {
          lastKnownPremier.set(id, p.ranks.premier);
        }
        for (const m of p.recent_matches ?? []) {
          markMatchProcessed(m.id, id, m.finished_at);
        }
      })
      .catch(() => {});
  }

  const INTERVAL = 5 * 60 * 1000;

  setInterval(async () => {
    const ids = getAllTrackedSteamIds();
    for (const id of ids) {
      await checkPlayer(client, id);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, INTERVAL);

  console.log(
    `Watcher started \u2014 polling ${steamIds.length} `
    + `player(s) every 5 minutes`
  );
}
