// Sunday-midnight reset: snapshots the top N balances into weekly_wins,
// wipes every account back to STARTING_BALANCE, and posts a
// Monday-morning summary to each guild's notify channel. Bets and
// wagers are untouched on purpose — winnings that resolve post-reset
// land in the fresh balance, and end-of-week bets create interesting
// edge-play where you "park" credits across the reset.
//
// Scheduler cadence mirrors src/cs/weekly.ts (Monday 00:00 UTC). The
// fire time is the boundary — we run, then the *completed* week's
// winners get archived against a week_ending of the Sunday that just
// finished.
import type { Client, TextChannel } from "discord.js";
import { desc, sql } from "drizzle-orm";
import { getDiscordId } from "../cs/store.js";
import log from "../logger.js";
import { getAllGuildIds, getNotifyChannel } from "../store.js";
import { embed, rankPrefix } from "../ui.js";
import { STARTING_BALANCE, WEEKLY_ARCHIVE_RANKS } from "./config.js";
import db from "./db.js";
import { accounts, weeklyWins } from "./schema.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function msUntilNextMonday00UTC(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun … 6=Sat
  let daysUntil = (8 - day) % 7;
  if (daysUntil === 0) {
    const todayAt00 = new Date(now);
    todayAt00.setUTCHours(0, 0, 0, 0);
    if (now >= todayAt00) daysUntil = 7;
  }
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntil);
  next.setUTCHours(0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

/**
 * YYYY-MM-DD of the Sunday the just-completed week ended on (i.e. the
 * day before the fire time). Used as the `week_ending` key in
 * weekly_wins so rank=1 rows per steamId give the weeks-won count.
 */
function lastSundayIso(now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1); // back off from Monday fire to Sunday
  return d.toISOString().slice(0, 10);
}

type Snapshot = { steamId: string; balance: number };

/**
 * Snapshot top balances, archive them, then wipe every account back to
 * the starting balance. One transaction so a crash mid-reset can't
 * leave us in a split state. Returns the archived snapshot so the
 * caller can post it.
 */
function runWeeklyReset(weekEnding = lastSundayIso()): Snapshot[] {
  return db.transaction((tx) => {
    const top = tx
      .select({ steamId: accounts.steamId, balance: accounts.balance })
      .from(accounts)
      .orderBy(desc(accounts.balance))
      .limit(WEEKLY_ARCHIVE_RANKS)
      .all();

    for (let i = 0; i < top.length; i++) {
      const row = top[i];
      if (!row) continue;
      tx.insert(weeklyWins)
        .values({
          weekEnding,
          steamId: row.steamId,
          rank: i + 1,
          balanceSnapshot: row.balance,
        })
        .run();
    }

    // Wipe all existing accounts back to the starting balance. No
    // ledger row per wipe — the weekly reset is a global event, not a
    // per-player grant, and the weekly_wins row *is* the audit trail.
    tx.update(accounts).set({ balance: STARTING_BALANCE }).where(sql`1 = 1`).run();

    return top;
  });
}

async function postWeeklyReset(client: Client, snapshot: Snapshot[]) {
  if (!snapshot.length) return;
  const lines = snapshot.map((s, i) => {
    const discordId = getDiscordId(s.steamId);
    const who = discordId ? `<@${discordId}>` : s.steamId;
    return `${rankPrefix(i)} ${who} \u2014 **${s.balance}** credits`;
  });

  const e = embed()
    .setTitle("Weekly Wins")
    .setDescription(
      [
        "The week is over. Top balances have been archived, everyone's back to " +
          `${STARTING_BALANCE} credits. Last week's standings:`,
        "",
        ...lines,
      ].join("\n"),
    );

  for (const guildId of getAllGuildIds()) {
    const channelId = getNotifyChannel(guildId);
    if (!channelId) continue;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({ embeds: [e] });
      }
    } catch (err) {
      log.error({ guildId, err }, "Weekly reset post failed");
    }
  }
}

async function tick(client: Client) {
  try {
    const weekEnding = lastSundayIso();
    const snapshot = runWeeklyReset(weekEnding);
    log.info({ weekEnding, winners: snapshot.length }, "Weekly reset done");
    await postWeeklyReset(client, snapshot);
  } catch (err) {
    log.error({ err }, "Weekly reset failed");
  }
}

export function startWeeklyReset(client: Client) {
  const delay = msUntilNextMonday00UTC();
  const nextRun = new Date(Date.now() + delay);
  log.info({ nextRun: nextRun.toUTCString() }, "Weekly reset scheduled");
  setTimeout(() => {
    tick(client);
    setInterval(() => tick(client), WEEK_MS);
  }, delay);
}
