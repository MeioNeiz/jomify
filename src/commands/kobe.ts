import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { freshnessSuffix, requireTrackedGuild } from "../helpers.js";
import { refreshPlayers } from "../refresh.js";
import {
  getMostRecentMatchTime,
  getPlayerMatchStats,
  getPlayerStatAverages,
} from "../store.js";
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
      const lines = entries.map((e, i) => {
        const ff =
          e.heFriendsDamage > 1
            ? ` \u2022 friendly fire \`${e.heFriendsDamage.toFixed(1)}\``
            : "";
        return (
          `${i + 1}. **${e.name}** \u2014 ` +
          `\u{1F4A5} \`${e.heDamage.toFixed(1)}\` HE dmg` +
          ` \u2022 \u{1F9EA} \`${e.heThrown.toFixed(1)}\`` +
          ` \u2022 \u{1F525} \`${e.mollies.toFixed(1)}\`` +
          ` \u2022 \u{1F4A8} \`${e.smokes.toFixed(1)}\`` +
          ff
        );
      });
      const embed = new EmbedBuilder()
        .setTitle("Grenade Mastery (last 30)")
        .setColor(0xff9933)
        .setDescription(
          "Per-match averages \u2014 " +
            "\u{1F4A5} HE damage to enemies | " +
            "\u{1F9EA} HEs | \u{1F525} mollies | \u{1F4A8} smokes\n\n" +
            lines.join("\n") +
            freshnessSuffix(latest),
        );
      return { embeds: [embed] };
    },
    missingMessage: "No match data yet.",
  });
});
