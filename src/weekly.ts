import type { Client, TextChannel } from "discord.js";
import { fetchGuildProfiles } from "./helpers.js";
import log from "./logger.js";
import {
  getAllGuildIds,
  getNotifyChannel,
  getWeekAgoLeaderboard,
  type PlayerSnapshot,
  saveLeaderboardSnapshot,
  saveSnapshots,
} from "./store.js";
import { embed, rankPrefix } from "./ui.js";

const WEEKLY_COLOUR = 0x5865f2; // Discord blurple
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function msUntilNextMonday09UTC(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun … 6=Sat
  let daysUntil = (8 - day) % 7;
  if (daysUntil === 0) {
    const todayAt09 = new Date(now);
    todayAt09.setUTCHours(9, 0, 0, 0);
    if (now >= todayAt09) daysUntil = 7;
  }
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntil);
  next.setUTCHours(9, 0, 0, 0);
  return next.getTime() - now.getTime();
}

async function postWeeklyLeaderboard(client: Client) {
  const guildIds = getAllGuildIds();

  for (const guildId of guildIds) {
    const channelId = getNotifyChannel(guildId);
    if (!channelId) continue;

    try {
      const profiles = await fetchGuildProfiles(guildId);
      if (!profiles?.length) continue;

      const snapshots: PlayerSnapshot[] = profiles.map((p) => ({
        steamId: p.steam64_id,
        name: p.name,
        premier: p.ranks?.premier ?? null,
        leetify: p.ranks?.leetify ?? null,
        aim: p.rating?.aim,
        positioning: p.rating?.positioning,
        utility: p.rating?.utility,
        clutch: p.rating?.clutch,
      }));
      saveSnapshots(snapshots);

      const entries = profiles
        .map((p) => ({
          steamId: p.steam64_id,
          name: p.name,
          premier: p.ranks?.premier ?? 0,
        }))
        .sort((a, b) => b.premier - a.premier);

      const weekAgo = getWeekAgoLeaderboard(guildId);
      const weekMap = new Map(weekAgo.map((e) => [e.steamId, e.premier]));
      const weekOrder = [...weekAgo]
        .sort((a, b) => (b.premier ?? 0) - (a.premier ?? 0))
        .map((e) => e.steamId);

      const lines = entries.map((e, i) => {
        const prefix = rankPrefix(i);
        const rating = e.premier ? e.premier.toLocaleString() : "Unranked";

        let change = "";
        const prev = weekMap.get(e.steamId);
        if (prev != null && e.premier) {
          const diff = e.premier - prev;
          if (diff > 0) change = ` (+${diff})`;
          else if (diff < 0) change = ` (${diff})`;
        }

        let posChange = "";
        if (weekOrder.length) {
          const oldPos = weekOrder.indexOf(e.steamId);
          if (oldPos !== -1 && oldPos !== i) {
            const moved = oldPos - i;
            posChange =
              moved > 0 ? ` \u2B06\uFE0F${moved}` : ` \u2B07\uFE0F${Math.abs(moved)}`;
          }
        }

        return `${prefix} **${e.name}** ${rating}${change}${posChange}`;
      });

      const weeklyEmbed = embed()
        .setTitle("Weekly Leaderboard")
        .setColor(WEEKLY_COLOUR)
        .setDescription(lines.join("\n"));

      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({
          embeds: [weeklyEmbed],
        });
      }

      saveLeaderboardSnapshot(
        guildId,
        entries.map((e) => ({
          steamId: e.steamId,
          premier: e.premier,
        })),
      );
    } catch (err) {
      log.error({ guildId, err }, "Weekly leaderboard failed");
    }
  }
}

export function startWeeklyLeaderboard(client: Client) {
  const delay = msUntilNextMonday09UTC();
  const nextRun = new Date(Date.now() + delay);
  log.info({ nextRun: nextRun.toUTCString() }, "Weekly leaderboard scheduled");

  setTimeout(() => {
    postWeeklyLeaderboard(client);
    setInterval(() => postWeeklyLeaderboard(client), WEEK_MS);
  }, delay);
}
