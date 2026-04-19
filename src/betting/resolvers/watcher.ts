// Polls every open resolver-backed market and asks its resolver
// whether to wait, resolve, or cancel. Mirrors the expiry watcher's
// shape — 60-second tick, DB as single source of truth, one-shot call
// on startup to catch anything that resolved while the bot was down.
//
// Per-resolver errors are caught + logged so one flaky upstream
// (future stocks / polymarket kinds) can't block the rest of the
// queue from running. The mutation path (cancelBet/resolveBet +
// message refresh) is isolated in this file; resolvers just return
// verdicts.
import type { Client, TextChannel } from "discord.js";
import { logError } from "../../errors.js";
import { on } from "../../events.js";
import log from "../../logger.js";
import { renderMarketView } from "../commands/market.js";
import {
  cancelBet,
  getBet,
  getOpenResolverBets,
  resolveBet,
  setResolverState,
} from "../store.js";
import { lookup, type Resolver, type ResolverVerdict } from "./index.js";

const TICK_MS = 60_000;

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function refreshMarketMessage(client: Client, betId: number): Promise<void> {
  const bet = getBet(betId);
  if (!bet?.channelId || !bet.messageId) return;
  try {
    const channel = await client.channels.fetch(bet.channelId);
    if (!channel?.isTextBased()) return;
    const message = await (channel as TextChannel).messages.fetch(bet.messageId);
    const view = renderMarketView(betId);
    await message.edit({
      content: view.content ?? null,
      embeds: view.embeds ?? [],
      components: view.components ?? [],
    });
  } catch (err) {
    // The resolution already landed in the DB; a dead message just
    // means the public post won't auto-update. The UI will catch up
    // next time anyone clicks a button in the market.
    log.warn({ betId, err }, "Couldn't edit market message after auto-resolve");
  }
}

async function applyVerdict(
  client: Client,
  betId: number,
  verdict: ResolverVerdict,
): Promise<void> {
  if (verdict.kind === "pending") {
    if (verdict.nextState !== undefined) setResolverState(betId, verdict.nextState);
    return;
  }
  if (verdict.kind === "cancel") {
    cancelBet(betId);
    log.info({ betId, note: verdict.note }, "Auto-cancelled market");
  } else {
    resolveBet(betId, verdict.outcome);
    log.info(
      { betId, outcome: verdict.outcome, note: verdict.note },
      "Auto-resolved market",
    );
  }
  await refreshMarketMessage(client, betId);
}

async function checkOne(
  client: Client,
  betId: number,
  resolver: Resolver,
): Promise<void> {
  const bet = getBet(betId);
  if (!bet || bet.status !== "open" || !bet.resolverKind) return;
  const verdict = await resolver.check({
    bet,
    args: parseJson(bet.resolverArgs),
    state: parseJson(bet.resolverState),
    now: new Date(),
    fetch,
  });
  await applyVerdict(client, betId, verdict);
}

/** Immediately tick only the resolver-backed bets whose resolver_args
 *  reference the given steamId. Called on the cs:match-completed fast-path
 *  so resolution fires within the same event loop tick as the match save,
 *  rather than waiting up to 60 s for the next scheduled poll. */
async function tickForSteamId(client: Client, steamId: string): Promise<void> {
  const open = getOpenResolverBets();
  for (const bet of open) {
    if (!bet.resolverArgs) continue;
    let args: unknown;
    try {
      args = JSON.parse(bet.resolverArgs);
    } catch {
      continue;
    }
    if ((args as { steamId?: string })?.steamId !== steamId) continue;
    const resolver = bet.resolverKind ? lookup(bet.resolverKind) : null;
    if (!resolver) continue;
    try {
      await checkOne(client, bet.id, resolver);
    } catch (err) {
      logError(`resolver:${bet.resolverKind}`, err, { betId: bet.id }, "warn");
    }
  }
}

export async function tick(client: Client): Promise<void> {
  const open = getOpenResolverBets();
  for (const bet of open) {
    const resolver = bet.resolverKind ? lookup(bet.resolverKind) : null;
    if (!resolver) {
      // Unregistered kind — log once per tick per bet so an operator
      // can spot a stale column without spamming.
      log.warn(
        { betId: bet.id, kind: bet.resolverKind },
        "Unknown resolver kind — ignoring",
      );
      continue;
    }
    try {
      await checkOne(client, bet.id, resolver);
    } catch (err) {
      logError(`resolver:${bet.resolverKind}`, err, { betId: bet.id }, "warn");
    }
  }
}

export function startResolverWatcher(client: Client): void {
  // Fast-path: tick bets for a player the moment their match is saved so
  // resolution lands within the same cycle rather than waiting for the poll.
  on("cs:match-completed", (e) => {
    tickForSteamId(client, e.steamId).catch((err) =>
      log.error({ err }, "Fast-path resolver tick failed"),
    );
  });
  setInterval(() => {
    tick(client).catch((err) => log.error({ err }, "Resolver tick failed"));
  }, TICK_MS);
  tick(client).catch((err) => log.error({ err }, "Initial resolver tick failed"));
}
