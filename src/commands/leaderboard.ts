import { SlashCommandBuilder } from "discord.js";
import { fetchGuildProfiles, relTime } from "../helpers.js";
import { isLeetifyCircuitOpen } from "../leetify/client.js";
import {
  getLastLeaderboard,
  getLastLeaderboardWithNames,
  getLeaderboardBefore,
  getTrackedPlayers,
  saveLeaderboardSnapshot,
} from "../store.js";
import { embed, pad, rankPrefix, table } from "../ui.js";
import { respondWithRevalidate, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Rank tracked players by Premier rating");

type Entry = { steamId: string; name: string; premier: number };
type Prev = { steamId: string; premier: number | null };

const NAME_WIDTH = 18;
const RATING_WIDTH = 7;
const DELTA_WIDTH = 6;

function buildRows(entries: Entry[], prev: Prev[]): string[] {
  const prevMap = new Map(prev.map((e) => [e.steamId, e.premier]));
  const prevOrder = [...prev]
    .sort((a, b) => (b.premier ?? 0) - (a.premier ?? 0))
    .map((e) => e.steamId);

  return entries.map((e, i) => {
    const rating = e.premier ? e.premier.toLocaleString() : "Unranked";

    const prevRating = prevMap.get(e.steamId);
    let delta = "";
    if (prevRating != null && e.premier) {
      const diff = e.premier - prevRating;
      if (diff > 0) delta = `+${diff}`;
      else if (diff < 0) delta = `${diff}`;
    }

    let move = "";
    if (prevOrder.length) {
      const oldPos = prevOrder.indexOf(e.steamId);
      if (oldPos !== -1 && oldPos !== i) {
        const steps = oldPos - i;
        move = steps > 0 ? `\u2B06 ${steps}` : `\u2B07 ${Math.abs(steps)}`;
      }
    }

    return (
      `${rankPrefix(i)} ${pad(e.name, NAME_WIDTH)}` +
      `${pad(rating, RATING_WIDTH)}` +
      `${pad(delta, DELTA_WIDTH)}` +
      `${move}`
    );
  });
}

export const execute = wrapCommand(async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return;
  }

  const trackedIds = getTrackedPlayers(guildId);
  if (!trackedIds.length) {
    await interaction.editReply("No tracked players. Use `/track` to add some.");
    return;
  }

  type View = { entries: Entry[]; prev: Prev[]; prevRecordedAt: string | null };

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const cached = getLastLeaderboardWithNames(guildId);
      if (!cached.entries.length) return null;
      const entries = cached.entries
        .map((e) => ({
          steamId: e.steamId,
          name: e.name,
          premier: e.premier ?? 0,
        }))
        .sort((a, b) => b.premier - a.premier);
      // Compare the cached snapshot to the one before it so rank arrows
      // still render when Leetify is down.
      const before = cached.recordedAt
        ? getLeaderboardBefore(guildId, cached.recordedAt)
        : { recordedAt: null, entries: [] };
      return {
        data: { entries, prev: before.entries, prevRecordedAt: before.recordedAt },
        snapshotAt: cached.recordedAt,
      };
    },
    fetchFresh: async () => {
      // Snapshot the previous leaderboard *before* we save the new one,
      // otherwise arrows would compare against ourselves.
      const before = getLastLeaderboard(guildId);
      const profiles = await fetchGuildProfiles(guildId);
      const entries: Entry[] = (profiles ?? [])
        .map((p) => ({
          steamId: p.steam64_id,
          name: p.name,
          premier: p.ranks?.premier ?? 0,
        }))
        .sort((a, b) => b.premier - a.premier);
      saveLeaderboardSnapshot(
        guildId,
        entries.map((e) => ({ steamId: e.steamId, premier: e.premier })),
      );
      return { entries, prev: before.entries, prevRecordedAt: before.recordedAt };
    },
    render: (v, { cached, snapshotAt }) => {
      const rows = buildRows(v.entries, v.prev);
      // One footer line. Left side tells you when the shown data is
      // from (only when stale); right side tells you what the arrows
      // are relative to. Omitted entirely on a first-ever run.
      const bits: string[] = [];
      if (cached && snapshotAt) {
        bits.push(`snapshot ${relTime(snapshotAt)}`);
      }
      if (v.prevRecordedAt) {
        bits.push(`arrows since ${relTime(v.prevRecordedAt)}`);
      }
      if (isLeetifyCircuitOpen()) {
        bits.push("Leetify unavailable");
      }
      const footer = bits.length ? `\n-# ${bits.join(" \u00B7 ")}` : "";
      return {
        embeds: [
          embed()
            .setTitle("Leaderboard")
            .setDescription(table(rows) + footer),
        ],
      };
    },
    missingMessage:
      "Leetify is down and there's no cached leaderboard yet \u2014 try again shortly.",
  });
});
