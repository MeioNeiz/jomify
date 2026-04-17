import { SlashCommandBuilder } from "discord.js";
import { fetchGuildProfiles, freshnessSuffix } from "../helpers.js";
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

  type View = { entries: Entry[]; prev: Prev[] };

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
      const prev = cached.recordedAt
        ? getLeaderboardBefore(guildId, cached.recordedAt)
        : [];
      return { data: { entries, prev }, snapshotAt: cached.recordedAt };
    },
    fetchFresh: async () => {
      // Snapshot the previous leaderboard *before* we save the new one,
      // otherwise arrows would compare against ourselves.
      const prev = getLastLeaderboard(guildId);
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
      return { entries, prev };
    },
    render: (v, { cached, snapshotAt }) => {
      const rows = buildRows(v.entries, v.prev);
      const desc =
        table(rows) + (cached ? freshnessSuffix(snapshotAt, "snapshot from") : "");
      return { embeds: [embed().setTitle("Leaderboard").setDescription(desc)] };
    },
    missingMessage:
      "Leetify is down and there's no cached leaderboard yet \u2014 try again shortly.",
  });
});
