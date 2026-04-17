import { SlashCommandBuilder } from "discord.js";
import { freshnessSuffix, outcomeTag } from "../helpers.js";
import { refreshPlayers } from "../refresh.js";
import { getPlayerHistory, type HistoryRow } from "../store.js";
import { embed, pad, table } from "../ui.js";
import { requireLinkedUser, respondWithRevalidate, wrapCommand } from "./handler.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export const data = new SlashCommandBuilder()
  .setName("history")
  .setDescription("Recent matches for a player with per-game Premier delta")
  .addUserOption((opt) =>
    opt.setName("user").setDescription("Player to look up (defaults to you)"),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("count")
      .setDescription(`How many games (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`)
      .setMinValue(1)
      .setMaxValue(MAX_LIMIT),
  );

type View = { rows: HistoryRow[]; latest: string | null };

function shortDate(iso: string): string {
  // "2026-04-17 19:30:00" or "2026-04-17T19:30:00Z" → "Apr 17"
  const d = new Date(iso.replace(" ", "T").endsWith("Z") ? iso : `${iso}Z`);
  return d.toLocaleDateString("en-GB", {
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  });
}

function signedDelta(n: number | null): string {
  if (n == null) return "";
  if (n > 0) return `+${n}`;
  return `${n}`;
}

function buildRows(rows: HistoryRow[]): string[] {
  // Header + data rows. Widths chosen to fit mobile comfortably (~52 chars).
  const header =
    `${pad("Date", 7)}${pad("Map", 12)}${pad("Score", 8)}` +
    `${pad("KDA", 9)}${pad("ADR", 5)}${pad("Rtg", 7)}Δ`;
  const body = rows.map((r) => {
    const score = outcomeTag(r.roundsWon ?? 0, r.roundsLost ?? 0);
    const kda = `${r.kills}/${r.deaths}/${r.assists}`;
    const map = r.mapName.replace(/^de_/, "");
    const rating = r.rating != null ? r.rating.toFixed(2) : "—";
    return (
      `${pad(shortDate(r.finishedAt), 7)}${pad(map, 12)}${pad(score, 8)}` +
      `${pad(kda, 9)}${pad(Math.round(r.dpr).toString(), 5)}${pad(rating, 7)}` +
      `${signedDelta(r.premierDelta)}`
    );
  });
  return [header, ...body];
}

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;
  const { steamId, label } = resolved;
  const count = interaction.options.getInteger("count") ?? DEFAULT_LIMIT;

  const compute = (): View => {
    const rows = getPlayerHistory(steamId, count);
    return { rows, latest: rows[0]?.finishedAt ?? null };
  };

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const v = compute();
      return v.rows.length ? { data: v, snapshotAt: v.latest } : null;
    },
    fetchFresh: async () => {
      await refreshPlayers([steamId]).catch(() => undefined);
      return compute();
    },
    render: ({ rows, latest }) => {
      if (!rows.length) {
        return {
          content: `No matches stored for ${label}. Try \`/track add\` if they're not tracked yet.`,
        };
      }
      const e = embed()
        .setTitle(`Match History — ${label}`)
        .setDescription(
          `${table(buildRows(rows))}${freshnessSuffix(latest, "last match")}`,
        );
      return { embeds: [e] };
    },
    missingMessage: `No match data for ${label} yet.`,
  });
});
