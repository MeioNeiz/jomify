import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { registerComponent } from "../components.js";
import { refreshPlayers } from "../cs/refresh.js";
import { getPlayerHistory, getStoredMatchCount, type HistoryRow } from "../cs/store.js";
import { freshnessSuffix, outcomeTag } from "../helpers.js";
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

type View = { rows: HistoryRow[]; total: number; offset: number; limit: number };

function shortDate(iso: string): string {
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

function buildEmbed(label: string, v: View): EmbedBuilder {
  if (!v.rows.length) {
    return embed().setTitle(`Match History — ${label}`).setDescription("No matches.");
  }
  const latest = v.rows[0]?.finishedAt ?? null;
  const pageNote =
    v.total > v.limit
      ? `-# ${v.offset + 1}–${v.offset + v.rows.length} of ${v.total} matches`
      : "";
  const desc =
    `${table(buildRows(v.rows))}` +
    (pageNote ? `\n${pageNote}` : "") +
    freshnessSuffix(latest, "last match");
  return embed().setTitle(`Match History — ${label}`).setDescription(desc);
}

function buildRow(steamId: string, v: View): ActionRowBuilder<ButtonBuilder> | null {
  if (v.total <= v.limit) return null; // nothing to paginate
  // Newest-first list: "◀ Newer" moves to a smaller offset, "Older ▶"
  // increases offset. Disabled when the button would go out of range.
  const prev = new ButtonBuilder()
    .setCustomId(`history:page:${steamId}:${v.limit}:${Math.max(0, v.offset - v.limit)}`)
    .setLabel("\u25C0 Newer")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(v.offset === 0);
  const nextOffset = v.offset + v.limit;
  const next = new ButtonBuilder()
    .setCustomId(`history:page:${steamId}:${v.limit}:${nextOffset}`)
    .setLabel("Older \u25B6")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(nextOffset >= v.total);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next);
}

function loadPage(steamId: string, limit: number, offset: number): View {
  return {
    rows: getPlayerHistory(steamId, limit, offset),
    total: getStoredMatchCount(steamId),
    offset,
    limit,
  };
}

export const execute = wrapCommand(async (interaction) => {
  const resolved = await requireLinkedUser(interaction);
  if (!resolved) return;
  const { steamId, label } = resolved;
  const limit = interaction.options.getInteger("count") ?? DEFAULT_LIMIT;

  await respondWithRevalidate<View>(interaction, {
    fetchCached: () => {
      const v = loadPage(steamId, limit, 0);
      return v.rows.length
        ? { data: v, snapshotAt: v.rows[0]?.finishedAt ?? null }
        : null;
    },
    fetchFresh: async () => {
      await refreshPlayers([steamId]).catch(() => undefined);
      return loadPage(steamId, limit, 0);
    },
    render: (v) => {
      if (!v.rows.length) {
        return {
          content: `No matches stored for ${label}. Try \`/track add\` if they're not tracked yet.`,
        };
      }
      const row = buildRow(steamId, v);
      return {
        embeds: [buildEmbed(label, v)],
        components: row ? [row] : [],
      };
    },
    missingMessage: `No match data for ${label} yet.`,
  });
});

// Button handler: customId is "history:page:<steamId>:<limit>:<offset>".
// The invoker isn't necessarily the caller who ran /history, but the
// data is tied to that steamId so anyone clicking gets the same view.
registerComponent("history", async (interaction) => {
  const [, action, steamId, limitStr, offsetStr] = interaction.customId.split(":");
  if (action !== "page" || !steamId || !limitStr || !offsetStr) return;
  const limit = Number(limitStr);
  const offset = Math.max(0, Number(offsetStr));
  const v = loadPage(steamId, limit, offset);
  const row = buildRow(steamId, v);
  // Preserve the player label from the existing message title so we
  // don't have to look up the Discord user again on every click.
  const currentTitle =
    interaction.message.embeds[0]?.title ?? `Match History — ${steamId}`;
  const nameFromTitle = currentTitle.replace(/^Match History — /, "");
  await interaction.update({
    embeds: [buildEmbed(nameFromTitle, v)],
    components: row ? [row] : [],
  });
});
