import { type Client, EmbedBuilder, type TextChannel } from "discord.js";
import log from "../logger.js";
import { getNotifyChannel } from "../store.js";
import { quickScan, SUSPECT_THRESHOLD } from "./analyse.js";
import type { LeetifyMatchDetails } from "./leetify/types.js";
import {
  getDiscordId,
  getGuildsForSteamId,
  isOpponentAnalysed,
  markOpponentAnalysed,
  markStreakAlerted,
} from "./store.js";

export async function sendToGuilds(client: Client, steamId: string, embed: EmbedBuilder) {
  const guilds = getGuildsForSteamId(steamId);
  for (const guildId of guilds) {
    const channelId = getNotifyChannel(guildId);
    if (!channelId) continue;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({
          embeds: [embed],
        });
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

  if (streakType === "win" && streakCount >= 3) {
    if (streakCount > lastAlertedCount) {
      const hype =
        streakCount >= 5
          ? `${player} is UNSTOPPABLE! ` +
            `\u{1F525}\u{1F525}\u{1F525} ` +
            `**${streakCount}** wins in a row!`
          : `${player} is on fire! \u{1F525} **${streakCount}** wins in a row`;

      const embed = new EmbedBuilder()
        .setTitle("Win Streak!")
        .setColor(0x00ff00)
        .setDescription(hype);
      await sendToGuilds(client, steamId, embed);
      markStreakAlerted(steamId, streakCount);
    }
  }

  if (streakType === "loss" && streakCount >= 3) {
    const atThreshold = streakCount % 2 === 1 && streakCount > lastAlertedCount;

    if (atThreshold) {
      const desc = `${player} has lost **${streakCount}** in a row \u2014 time for a break?`;

      const embed = new EmbedBuilder()
        .setTitle("Rough Patch")
        .setColor(0xff6600)
        .setDescription(desc);
      await sendToGuilds(client, steamId, embed);
      markStreakAlerted(steamId, streakCount);
    }
  }
}

// ── Opponent scanning ──

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

  const susPlayers: {
    name: string;
    score: number;
  }[] = [];

  for (const opp of opponents) {
    if (isOpponentAnalysed(details.id, opp.steam64_id)) continue;
    markOpponentAnalysed(details.id, opp.steam64_id);

    const score = quickScan(opp);
    if (score >= SUSPECT_THRESHOLD) {
      susPlayers.push({
        name: opp.name,
        score,
      });
    }
  }

  if (!susPlayers.length) return;

  susPlayers.sort((a, b) => b.score - a.score);
  const lines = susPlayers.map(
    (p) => `\u26A0\uFE0F **${p.name}** ` + `(score: ${p.score.toFixed(1)})`,
  );

  const embed = new EmbedBuilder()
    .setTitle("Sussy Opponents Detected")
    .setColor(0xfee75c)
    .setDescription(
      `In ${mentionOrName(trackedSteamId, "your")}'s last match on ` +
        `**${details.map_name}**:\n\n` +
        lines.join("\n"),
    )
    .setFooter({
      text: "Single-match scan \u2022 not definitive",
    });
  await sendToGuilds(client, trackedSteamId, embed);
}
