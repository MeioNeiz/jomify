import { SlashCommandBuilder } from "discord.js";
import { refreshPlayers } from "../cs/refresh.js";
import {
  getMostRecentMatchTime,
  getPlayerMatchStats,
  getPlayerStatAverages,
} from "../cs/store.js";
import { freshnessSuffix, requireTrackedGuild } from "../helpers.js";
import { embed, pad, table } from "../ui.js";
import { respondWithRevalidate, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("kobe")
  .setDescription("Grenade stats — HE damage, molly/smoke throws per match");

type Entry = {
  name: string;
  heDamage: number;
  heFriendsDamage: number;
  heThrown: number;
  mollies: number;
  smokes: number;
};
type View = { entries: Entry[]; latest: string | null };

function computeView(steamIds: string[]): View {
  const entries: Entry[] = [];
  for (const id of steamIds) {
    const avgs = getPlayerStatAverages(id, 30);
    if (!avgs) continue;
    const recent = getPlayerMatchStats(id, 1);
    entries.push({
      name: recent[0]?.raw.name ?? id,
      heDamage: avgs.avg_he_damage ?? 0,
      heFriendsDamage: avgs.avg_he_friends_damage ?? 0,
      heThrown: avgs.avg_he_thrown ?? 0,
      mollies: avgs.avg_molotov_thrown ?? 0,
      smokes: avgs.avg_smoke_thrown ?? 0,
    });
  }
  // Best HE placement first (most damage to enemies per match).
  entries.sort((a, b) => b.heDamage - a.heDamage);
  return { entries, latest: getMostRecentMatchTime(steamIds) };
}

export const execute = wrapCommand(async (interaction) => {
  const guild = await requireTrackedGuild(interaction);
  if (!guild) return;
  const { steamIds } = guild;

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const data = computeView(steamIds);
      if (!data.entries.length) return null;
      return { data, snapshotAt: data.latest };
    },
    fetchFresh: async () => {
      await refreshPlayers(steamIds);
      return computeView(steamIds);
    },
    render: ({ entries, latest }) => {
      const top = entries.slice(0, 10);
      // Numeric prefix (not rankPrefix medals) so all rows stay aligned
      // — emoji medals render wider than "N." and break the columns.
      const fmtNum = (n: number, w: number) => n.toFixed(1).padStart(w, " ");
      const header = `${pad("", 4)}${pad("Name", 14)}    HE   Thr   Mol   Smk`;
      const rows = top.map((e, i) => {
        return (
          `${pad(`${i + 1}.`, 4)}${pad(e.name, 14)}` +
          ` ${fmtNum(e.heDamage, 5)}` +
          ` ${fmtNum(e.heThrown, 5)}` +
          ` ${fmtNum(e.mollies, 5)}` +
          ` ${fmtNum(e.smokes, 5)}`
        );
      });
      // FF-heavy players footnoted below the table so the main grid
      // stays mobile-width — anything in the inline row pushed it over.
      const ffNotes = top
        .filter((e) => e.heFriendsDamage > 1)
        .map((e) => `${e.name}: ${e.heFriendsDamage.toFixed(1)}`);
      const footer = ffNotes.length
        ? `\n-# Friendly-fire HE damage: ${ffNotes.join(", ")}`
        : "";
      const headerText = "-# Per-match averages. HE = damage dealt to enemies.";
      const e = embed("kobe")
        .setTitle("Grenade Mastery (Last 30)")
        .setDescription(
          `${headerText}\n${table([header, ...rows])}${footer}${freshnessSuffix(latest, "last match")}`,
        );
      return { embeds: [e] };
    },
    missingMessage: "No match data yet.",
  });
});
