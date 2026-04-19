// Weekly cycle. Fires every Monday 00:00 Europe/London (handles DST
// by recomputing the delay after each tick). One tick archives last
// week's top betting balances, posts a per-guild leaderboard, then
// wipes every wallet back to STARTING_BALANCE.
//
// Per-guild mode selection is data-driven:
//   - merged   — guild has tracked CS players AND at least one of them
//                has a betting account. Sort by balance, show premier +
//                rating delta since last week.
//   - cs       — guild has tracked CS players, no bettors. Sort by
//                premier, show rating/position deltas.
//   - betting  — guild has no tracked CS players but the bot has
//                balances. Show global top balances.
//   - skip     — nothing to post.
import type { Client, TextChannel } from "discord.js";
import { sql } from "drizzle-orm";
import { STARTING_BALANCE, WEEKLY_ARCHIVE_RANKS } from "./betting/config.js";
import bettingDb from "./betting/db.js";
import { accounts, weeklyWins } from "./betting/schema.js";
import type { LeetifyProfile } from "./cs/leetify/types.js";
import {
  getDiscordId,
  getWeekAgoLeaderboard,
  type PlayerSnapshot,
  saveLeaderboardSnapshot,
  saveSnapshots,
} from "./cs/store.js";
import { fetchGuildProfiles } from "./helpers.js";
import log from "./logger.js";
import { getAllGuildIds, getNotifyChannel } from "./store.js";
import { embed, rankPrefix } from "./ui.js";

const WEEKLY_COLOUR = 0x5865f2; // Discord blurple

function msUntilNextMondayLondon(now = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  const get = (d: Date, type: string) =>
    fmt.formatToParts(d).find((p) => p.type === type)?.value ?? "";

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const wd = weekdayMap[get(now, "weekday")] ?? 0;
  const h = Number(get(now, "hour"));
  const mi = Number(get(now, "minute"));
  const s = Number(get(now, "second"));
  let daysUntil = (1 - wd + 7) % 7;
  if (daysUntil === 0 && (h > 0 || mi > 0 || s > 0)) daysUntil = 7;

  const y = Number(get(now, "year"));
  const mo = Number(get(now, "month"));
  const d = Number(get(now, "day"));

  // Converge on the UTC instant whose London-local wall clock is the
  // target Monday 00:00. A handful of iterations handles the DST
  // transitions where naive Date.UTC math lands in the wrong hour.
  let target = new Date(Date.UTC(y, mo - 1, d + daysUntil, 0, 0, 0));
  for (let i = 0; i < 4; i++) {
    const ty = Number(get(target, "year"));
    const tmo = Number(get(target, "month"));
    const td = Number(get(target, "day"));
    const th = Number(get(target, "hour"));
    const tmi = Number(get(target, "minute"));
    const ts = Number(get(target, "second"));
    const have = Date.UTC(ty, tmo - 1, td, th, tmi, ts);
    const want = Date.UTC(y, mo - 1, d + daysUntil, 0, 0, 0);
    const diff = want - have;
    if (Math.abs(diff) < 1000) break;
    target = new Date(target.getTime() + diff);
  }
  return Math.max(target.getTime() - now.getTime(), 0);
}

/** YYYY-MM-DD of the Sunday the just-completed week ended on. */
function lastSundayIso(now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Archive top-N live balances, then wipe every account back to
 * STARTING_BALANCE. Returns the pre-wipe balance map so the caller can
 * render it into the weekly embed.
 */
function runReset(weekEnding: string): Map<string, number> {
  return bettingDb.transaction((tx) => {
    const all = tx
      .select({ discordId: accounts.discordId, balance: accounts.balance })
      .from(accounts)
      .all();
    const top = [...all]
      .sort((a, b) => b.balance - a.balance)
      .slice(0, WEEKLY_ARCHIVE_RANKS);
    for (let i = 0; i < top.length; i++) {
      const row = top[i];
      if (!row) continue;
      tx.insert(weeklyWins)
        .values({
          weekEnding,
          discordId: row.discordId,
          rank: i + 1,
          balanceSnapshot: row.balance,
        })
        .run();
    }
    tx.update(accounts).set({ balance: STARTING_BALANCE }).where(sql`1 = 1`).run();
    return new Map(all.map((r) => [r.discordId, r.balance]));
  });
}

// ── Render helpers ───────────────────────────────────────────────────

function fmtDelta(diff: number | null): string {
  if (diff == null || diff === 0) return "";
  return diff > 0 ? ` (+${diff})` : ` (${diff})`;
}

function fmtMove(steps: number | null): string {
  if (steps == null || steps === 0) return "";
  return steps > 0 ? ` \u2B06\uFE0F${steps}` : ` \u2B07\uFE0F${Math.abs(steps)}`;
}

type CsRow = {
  steamId: string;
  name: string;
  premier: number;
  premierDelta: number | null;
  posDelta: number | null;
};

function buildCsLines(rows: CsRow[]): string[] {
  return rows.map((r, i) => {
    const rating = r.premier ? r.premier.toLocaleString() : "Unranked";
    return `${rankPrefix(i)} **${r.name}** ${rating}${fmtDelta(r.premierDelta)}${fmtMove(r.posDelta)}`;
  });
}

type MergedRow = CsRow & { balance: number };

function buildMergedLines(rows: MergedRow[]): string[] {
  return rows.map((r, i) => {
    const rating = r.premier ? r.premier.toLocaleString() : "Unranked";
    return (
      `${rankPrefix(i)} **${r.name}** \u2014 **${r.balance}** credits` +
      ` \u00B7 ${rating}${fmtDelta(r.premierDelta)}${fmtMove(r.posDelta)}`
    );
  });
}

function buildBettingLines(rows: { discordId: string; balance: number }[]): string[] {
  return rows.map(
    (r, i) => `${rankPrefix(i)} <@${r.discordId}> \u2014 **${r.balance}** credits`,
  );
}

const RESET_FOOTER = `\n\n_Week over — everyone's back to ${STARTING_BALANCE} credits. Place your bets._`;

// ── Per-guild post ───────────────────────────────────────────────────

type BuiltPost = {
  description: string;
  order: { steamId: string; premier: number }[];
};

function buildCsOnly(profiles: LeetifyProfile[], guildId: string): BuiltPost {
  const week = getWeekAgoLeaderboard(guildId);
  const prevMap = new Map(week.map((e) => [e.steamId, e.premier ?? 0]));
  const prevOrder = [...week]
    .sort((a, b) => (b.premier ?? 0) - (a.premier ?? 0))
    .map((e) => e.steamId);

  const rows: CsRow[] = profiles
    .map((p) => ({
      steamId: p.steam64_id,
      name: p.name,
      premier: p.ranks?.premier ?? 0,
      premierDelta: null as number | null,
      posDelta: null as number | null,
    }))
    .sort((a, b) => b.premier - a.premier);

  rows.forEach((r, i) => {
    const prev = prevMap.get(r.steamId);
    if (prev != null && r.premier) r.premierDelta = r.premier - prev;
    if (prevOrder.length) {
      const oldPos = prevOrder.indexOf(r.steamId);
      if (oldPos !== -1 && oldPos !== i) r.posDelta = oldPos - i;
    }
  });

  return {
    description: buildCsLines(rows).join("\n"),
    order: rows.map((r) => ({ steamId: r.steamId, premier: r.premier })),
  };
}

function buildMerged(
  profiles: LeetifyProfile[],
  guildId: string,
  balances: Map<string, number>,
): BuiltPost {
  const week = getWeekAgoLeaderboard(guildId);
  const prevMap = new Map(week.map((e) => [e.steamId, e.premier ?? 0]));

  // Steam → Discord lookup so CS profiles (steam-keyed) can pull their
  // balance from the discord-keyed wallet map. Unlinked profiles show
  // as zero-balance rows and naturally sort to the bottom.
  const rows: MergedRow[] = profiles.map((p) => {
    const discordId = getDiscordId(p.steam64_id);
    return {
      steamId: p.steam64_id,
      name: p.name,
      premier: p.ranks?.premier ?? 0,
      premierDelta: null,
      posDelta: null,
      balance: (discordId && balances.get(discordId)) || 0,
    };
  });

  // Balance desc, premier desc tie-break so unbetted players group at
  // the bottom sorted by premier rather than by insertion order.
  rows.sort((a, b) => b.balance - a.balance || b.premier - a.premier);

  rows.forEach((r) => {
    const prev = prevMap.get(r.steamId);
    if (prev != null && r.premier) r.premierDelta = r.premier - prev;
    // Position arrows intentionally omitted in merged mode — we don't
    // yet snapshot per-guild balance orderings, so arrows comparing a
    // balance-sorted row to a premier-sorted baseline would mislead.
  });

  return {
    description: buildMergedLines(rows).join("\n") + RESET_FOOTER,
    order: rows.map((r) => ({ steamId: r.steamId, premier: r.premier })),
  };
}

function buildBettingOnly(balances: Map<string, number>): BuiltPost {
  const rows = [...balances.entries()]
    .map(([discordId, balance]) => ({ discordId, balance }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);
  return {
    description: `Last week's standings:\n\n${buildBettingLines(rows).join("\n")}${RESET_FOOTER}`,
    order: [],
  };
}

async function postGuild(
  client: Client,
  guildId: string,
  balances: Map<string, number>,
): Promise<void> {
  const channelId = getNotifyChannel(guildId);
  if (!channelId) return;

  let profiles: LeetifyProfile[] | null = null;
  try {
    profiles = await fetchGuildProfiles(guildId);
  } catch (err) {
    log.error({ guildId, err }, "Weekly CS profile fetch failed");
  }

  if (profiles?.length) {
    saveSnapshots(
      profiles.map(
        (p): PlayerSnapshot => ({
          steamId: p.steam64_id,
          name: p.name,
          premier: p.ranks?.premier ?? null,
          leetify: p.ranks?.leetify ?? null,
          aim: p.rating?.aim ?? 0,
          positioning: p.rating?.positioning ?? 0,
          utility: p.rating?.utility ?? 0,
          clutch: p.rating?.clutch ?? 0,
        }),
      ),
    );
  }

  const hasCs = !!profiles?.length;
  const guildBettors = hasCs
    ? (profiles ?? []).filter((p) => {
        const did = getDiscordId(p.steam64_id);
        return did != null && balances.has(did);
      })
    : [];
  const hasMerged = hasCs && guildBettors.length > 0;
  const hasBetting = !hasCs && balances.size > 0;

  let built: BuiltPost | null = null;
  if (hasMerged) built = buildMerged(profiles ?? [], guildId, balances);
  else if (hasCs) built = buildCsOnly(profiles ?? [], guildId);
  else if (hasBetting) built = buildBettingOnly(balances);

  if (!built) return;

  const e = embed()
    .setTitle("Weekly Leaderboard")
    .setColor(WEEKLY_COLOUR)
    .setDescription(built.description);

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).send({ embeds: [e] });
    }
  } catch (err) {
    log.error({ guildId, err }, "Weekly post send failed");
  }

  if (built.order.length) {
    saveLeaderboardSnapshot(
      guildId,
      built.order.map((r) => ({ steamId: r.steamId, premier: r.premier })),
    );
  }
}

// ── Orchestration ────────────────────────────────────────────────────

async function tick(client: Client) {
  try {
    const weekEnding = lastSundayIso();
    // Archive + wipe first; the returned map is the pre-wipe balances
    // we render against. Doing it up front also means a crash mid-loop
    // can't leave the reset half-applied.
    const balances = runReset(weekEnding);
    for (const guildId of getAllGuildIds()) {
      try {
        await postGuild(client, guildId, balances);
      } catch (err) {
        log.error({ guildId, err }, "Weekly guild post failed");
      }
    }
    log.info({ weekEnding, wallets: balances.size }, "Weekly cycle done");
  } catch (err) {
    log.error({ err }, "Weekly tick failed");
  }
}

export function startWeekly(client: Client): void {
  const schedule = () => {
    const delay = msUntilNextMondayLondon();
    const nextRun = new Date(Date.now() + delay);
    log.info({ nextRun: nextRun.toISOString() }, "Weekly scheduled");
    setTimeout(async () => {
      await tick(client);
      schedule();
    }, delay);
  };
  schedule();
}
