import { type Client, EmbedBuilder, type TextChannel } from "discord.js";
import log from "../logger.js";
import { getNotifyChannel } from "../store.js";
import { quickScan, SUSPECT_THRESHOLD } from "./analyse.js";
import type { LeetifyMatchDetails } from "./leetify/types.js";
import {
  getAllTrackedSteamIds,
  getDiscordId,
  getGuildsForSteamId,
  isOpponentAnalysed,
  markOpponentAnalysed,
  markStreakAlerted,
  updateGuildWinRecord,
} from "./store.js";

export async function sendToGuilds(
  client: Client,
  steamId: string,
  embed: EmbedBuilder,
  content?: string,
) {
  const guilds = getGuildsForSteamId(steamId);
  for (const guildId of guilds) {
    const channelId = getNotifyChannel(guildId);
    if (!channelId) continue;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({ content, embeds: [embed] });
      }
    } catch (err) {
      log.error({ guildId, channelId, err }, "Failed to send alert");
    }
  }
}

export function mentionOrName(steamId: string, name: string): string {
  const discordId = getDiscordId(steamId);
  return discordId ? `<@${discordId}>` : `**${name}**`;
}

// ── Big match detection ──

export function checkBigMatch(details: LeetifyMatchDetails, steamId: string): string[] {
  const stats = details.stats.find((s) => s.steam64_id === steamId);
  if (!stats) return [];

  const achievements: string[] = [];

  if (stats.total_kills >= 30) {
    achievements.push(`\u{1F4A5} **${stats.total_kills} kills**`);
  }

  if (stats.kd_ratio >= 2) {
    achievements.push(`\u{1F525} **${stats.kd_ratio.toFixed(1)} KDR**`);
  }

  if (stats.multi5k >= 1) {
    achievements.push(`\u{1F3AF} **Ace** (${stats.multi5k}x 5k)`);
  }

  const [t1, t2] = details.team_scores;
  const playerTeam = stats.initial_team_number;
  const playerScore = t1.team_number === playerTeam ? t1.score : t2.score;
  const enemyScore = t1.team_number === playerTeam ? t2.score : t1.score;

  if (playerScore === 16 && enemyScore === 0) {
    achievements.push(`\u{1F3C6} **16-0 clean sweep**`);
  }

  return achievements;
}

// ── Streak alerts ──

const WIN_MILESTONES: Record<number, string> = {
  6: "\u{1F525}\u{1F525}\u{1F525} someone stop this person!",
  10: "operating on a different plane of existence.",
  12: "actually inhuman. What is happening.",
  14: "cannot be contained. Security has been called.",
  16: "CANNOT BE STOPPED. Send help.",
};

const WIN_MILESTONE_COUNTS = new Set(Object.keys(WIN_MILESTONES).map(Number));

const LOSS_MESSAGES: Record<number, string> = {
  3: "Maybe take a break?",
  6: "Yikes.",
  10: "OPEN YOUR EYES SWITCH ON MONITOR AND PLUG IN KEYBOARD.",
};

const LOSS_MILESTONE_COUNTS = new Set(Object.keys(LOSS_MESSAGES).map(Number));

export async function checkStreakAlerts(
  client: Client,
  steamId: string,
  player: string,
  streak: {
    streakType: "win" | "loss";
    streakCount: number;
    lastAlertedCount: number;
  },
): Promise<void> {
  const { streakType, streakCount, lastAlertedCount } = streak;

  if (
    streakType === "win" &&
    WIN_MILESTONE_COUNTS.has(streakCount) &&
    streakCount > lastAlertedCount
  ) {
    const guilds = getGuildsForSteamId(steamId);
    for (const guildId of guilds) {
      const channelId = getNotifyChannel(guildId);
      if (!channelId) continue;
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) continue;
        const isRecord = updateGuildWinRecord(guildId, steamId, streakCount);
        const suffix = WIN_MILESTONES[streakCount];
        let desc = `${player} — **${streakCount}** wins in a row — ${suffix}`;
        if (isRecord) desc += `\n\n\u{1F3C6} **New server record!**`;
        const embed = new EmbedBuilder()
          .setTitle("Win Streak!")
          .setColor(0x00ff00)
          .setDescription(desc);
        await (channel as TextChannel).send({ embeds: [embed] });
      } catch (err) {
        log.error({ guildId, channelId, err }, "Failed to send streak alert");
      }
    }
    markStreakAlerted(steamId, streakCount);
  }

  if (
    streakType === "loss" &&
    LOSS_MILESTONE_COUNTS.has(streakCount) &&
    streakCount > lastAlertedCount
  ) {
    const discordId = getDiscordId(steamId);
    const suffix = LOSS_MESSAGES[streakCount];
    const desc = `${player} has lost **${streakCount}** in a row \u2014 ${suffix}`;
    const embed = new EmbedBuilder()
      .setTitle("Rough Patch")
      .setColor(0xff6600)
      .setDescription(desc);
    await sendToGuilds(client, steamId, embed, discordId ? `<@${discordId}>` : undefined);
    markStreakAlerted(steamId, streakCount);
  }
}

// ── Opponent scanning ──

function csrepUrl(steamId: string): string {
  return `https://csrep.gg/player/${steamId}`;
}

export async function scanOpponents(
  client: Client,
  trackedSteamId: string,
  details: LeetifyMatchDetails,
) {
  const tracked = details.stats.find((s) => s.steam64_id === trackedSteamId);
  if (!tracked) return;

  const opponents = details.stats.filter(
    (s) => s.initial_team_number !== tracked.initial_team_number,
  );

  const susPlayers: { name: string; steamId: string; score: number }[] = [];

  for (const opp of opponents) {
    if (isOpponentAnalysed(details.id, opp.steam64_id)) continue;
    markOpponentAnalysed(details.id, opp.steam64_id);
    const score = quickScan(opp);
    if (score >= SUSPECT_THRESHOLD) {
      susPlayers.push({ name: opp.name, steamId: opp.steam64_id, score });
    }
  }

  if (!susPlayers.length) return;

  // Collect all tracked players on the same team so we notify every guild
  // that had a player in this match, sending only one message per guild.
  const allTracked = new Set(getAllTrackedSteamIds());
  const trackedTeam = details.stats
    .filter(
      (s) =>
        s.initial_team_number === tracked.initial_team_number &&
        allTracked.has(s.steam64_id),
    )
    .map((s) => s.steam64_id);

  susPlayers.sort((a, b) => b.score - a.score);
  const lines = susPlayers.map(
    (p) =>
      `\u26A0\uFE0F [**${p.name}**](${csrepUrl(p.steamId)}) (score: ${p.score.toFixed(1)})`,
  );

  // One message per guild, mentioning the tracked player(s) in that guild
  const seenGuilds = new Set<string>();
  for (const memberId of trackedTeam) {
    for (const guildId of getGuildsForSteamId(memberId)) {
      if (seenGuilds.has(guildId)) continue;
      seenGuilds.add(guildId);

      const channelId = getNotifyChannel(guildId);
      if (!channelId) continue;
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) continue;

        // Mention all tracked players in this guild who were on the team
        const mentions = trackedTeam
          .filter((id) => getGuildsForSteamId(id).includes(guildId))
          .map((id) => getDiscordId(id))
          .filter((id): id is string => id != null)
          .map((id) => `<@${id}>`)
          .join(" ");

        const embed = new EmbedBuilder()
          .setTitle("Likely Cheater Detected")
          .setColor(0xfee75c)
          .setDescription(
            `Likely cheater in a recent match on **${details.map_name}**:\n\n` +
              lines.join("\n"),
          )
          .setFooter({ text: "Single-match scan \u2022 check csrep before reporting" });

        await (channel as TextChannel).send({
          content: mentions || undefined,
          embeds: [embed],
        });
      } catch (err) {
        log.error({ guildId, channelId: channelId, err }, "Failed to send sus alert");
      }
    }
  }
}
