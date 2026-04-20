// Fast-path for the `cs:first-to` market kind.
//
// The generic resolver-watcher fast-path keys on `args.steamId`, but
// first-to markets are scoped on `guildId` (+ optional steamId list) —
// the event's steamId won't match any single arg field. This listener
// fills that gap: on every cs:match-completed event, it ticks every
// open first-to market whose scope includes the match's player and
// guild, so resolution fires within the same event loop tick as the
// match save rather than waiting up to 60 s for the next poll.
//
// The actual YES/NO decision lives in the resolver's check() — the
// listener just nudges it. We look up `cs:first-to` by kind so a
// future second listener (e.g. a list-scoped variant) can slot in
// without branching here.
import type { Client, TextChannel } from "discord.js";
import { getGuildsForSteamId } from "../../cs/store.js";
import { logError } from "../../errors.js";
import { on } from "../../events.js";
import log from "../../logger.js";
import { renderMarketView } from "../commands/market.js";
import { isInScope, parseFirstToArgs } from "../resolvers/cs-first-to.js";
import { lookup, type ResolverVerdict } from "../resolvers/index.js";
import {
  cancelBet,
  getBet,
  getOpenResolverBets,
  resolveBet,
  setResolverState,
} from "../store.js";

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
  } else {
    resolveBet(betId, verdict.outcome);
  }
  // Best-effort: edit the original market message so the new state
  // shows immediately. A dead message is harmless — the next user
  // click will re-render it.
  const bet = getBet(betId);
  if (!bet?.channelId || !bet.messageId) return;
  try {
    const channel = await client.channels.fetch(bet.channelId);
    if (!channel?.isTextBased()) return;
    const msg = await (channel as TextChannel).messages.fetch(bet.messageId);
    const view = renderMarketView(betId);
    await msg.edit({
      content: view.content ?? null,
      embeds: view.embeds ?? [],
      components: view.components ?? [],
    });
  } catch (err) {
    log.warn({ betId, err }, "Couldn't edit market message after first-to resolve");
  }
}

// Opt-in wiring: `startFirstToListener(client)` is called from index.ts
// alongside the other watchers so all event subscriptions are scoped
// to the live Discord client. Importing this module is otherwise a
// no-op — keeps tests that load the resolver free of the listener's
// Discord dependency.
export function startFirstToListener(client: Client): void {
  on("cs:match-completed", (e) => {
    queueMicrotask(() => {
      void runFastPath(client, e.steamId);
    });
  });
}

async function runFastPath(client: Client, steamId: string): Promise<void> {
  try {
    // Cheap pre-filter: which guilds track this player? `scope=guild`
    // markets for guilds that don't track them can't possibly match.
    const guilds = new Set(getGuildsForSteamId(steamId));
    if (guilds.size === 0) return;

    const open = getOpenResolverBets();
    for (const bet of open) {
      if (bet.resolverKind !== "cs:first-to") continue;
      const args = parseFirstToArgs(safeParse(bet.resolverArgs));
      if (!args) continue;
      if (!guilds.has(args.guildId)) continue;
      if (!isInScope(args, steamId, args.guildId)) continue;
      const resolver = lookup("cs:first-to");
      if (!resolver) continue;
      const current = getBet(bet.id);
      if (!current || current.status !== "open") continue;
      const verdict = await resolver.check({
        bet: current,
        args,
        state: safeParse(current.resolverState),
        now: new Date(),
        fetch,
      });
      await applyVerdict(client, bet.id, verdict);
    }
  } catch (err) {
    logError("listener:cs-first-to", err);
  }
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
