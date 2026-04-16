import { SlashCommandBuilder } from "discord.js";
import { freshnessSuffix, leetifyEmbed, signed } from "../helpers.js";
import { refreshPlayers } from "../refresh.js";
import { type CarryRow, getCarryStats, getMostRecentMatchTime } from "../store.js";
import { requireLinkedUser, respondWithRevalidate, wrapCommand } from "./handler.js";

export const data = new SlashCommandBuilder()
  .setName("carry")
  .setDescription("Who has carried you the most? (Based on shared matches)")
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Player to analyse (defaults to you)"),
  );

type View = { rows: CarryRow[]; latest: string | null };

const MIN_SHARED = 3;

function computeView(steamId: string): View {
  const rows = getCarryStats(steamId)
    .filter((r) => r.sharedMatches >= MIN_SHARED)
    .sort((a, b) => scoreFor(b) - scoreFor(a));
  return {
    rows: rows.slice(0, 8),
    latest: getMostRecentMatchTime([steamId]),
  };
}

/** Sort key: Premier score if we have data, proxy score otherwise. */
function scoreFor(r: CarryRow): number {
  return r.premierSamples > 0 ? r.premierScore : r.proxyScore;
}

function formatRow(r: CarryRow, i: number): string {
  const main =
    r.premierSamples > 0
      ? `**${signed(r.premierScore)}** Premier`
      : `**${signedProxy(r.proxyScore)}** carry score`;
  const note =
    r.premierSamples > 0 && r.premierSamples < r.sharedMatches
      ? ` (${r.premierSamples}/${r.sharedMatches} with rating data)`
      : ` (${r.sharedMatches} games)`;
  return `${i + 1}. **${r.teammateName}** \u2014 ${main}${note}`;
}

function signedProxy(n: number): string {
  const s = n.toFixed(2);
  return n > 0 ? `+${s}` : s;
}

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const v = computeView(resolved.steamId);
      if (!v.rows.length) return null;
      return { data: v, snapshotAt: v.latest };
    },
    fetchFresh: async () => {
      await refreshPlayers([resolved.steamId]).catch(() => undefined);
      return computeView(resolved.steamId);
    },
    render: ({ rows, latest }) => {
      const body = rows.map((r, i) => formatRow(r, i)).join("\n");
      const embed = leetifyEmbed(`${resolved.label} \u2014 Who Carries?`).setDescription(
        body + freshnessSuffix(latest),
      );
      return { embeds: [embed] };
    },
    missingMessage: `Need at least ${MIN_SHARED} shared matches with a teammate. Play more together.`,
  });
});
