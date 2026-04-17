import { SlashCommandBuilder } from "discord.js";
import { freshnessSuffix, requireTrackedGuild } from "../helpers.js";
import { refreshPlayers } from "../refresh.js";
import {
  getMostRecentMatchTime,
  getPlayerMatchStats,
  getPlayerStatAverages,
} from "../store.js";
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
      // Use plain numeric prefix (not rankPrefix medals) because the table
      // runs up to 10 rows and mixing emoji medals with plain numbers
      // misaligns the columns in a code block.
      const rows = top.map((e, i) => {
        const prefix = pad(`${i + 1}.`, 3);
        const ff = e.heFriendsDamage > 1 ? `  FF ${e.heFriendsDamage.toFixed(1)}` : "";
        return (
          `${prefix}${pad(e.name, 16)} ` +
          `HE ${pad(e.heDamage.toFixed(1), 5)} ` +
          `thrown ${pad(e.heThrown.toFixed(1), 4)} ` +
          `moly ${pad(e.mollies.toFixed(1), 4)} ` +
          `smk ${e.smokes.toFixed(1)}` +
          ff
        );
      });
      const header =
        "Per-match averages. HE = damage dealt to enemies. FF = friendly-fire damage.";
      const e = embed("kobe")
        .setTitle("Grenade Mastery (Last 30)")
        .setDescription(
          `${header}\n${table(rows)}${freshnessSuffix(latest, "last match")}`,
        );
      return { embeds: [e] };
    },
    missingMessage: "No match data yet.",
  });
});
