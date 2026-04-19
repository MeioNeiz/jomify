// Auto-cancels open markets whose expires_at has passed and edits
// their original Discord message to show the cancelled state.
//
// Polls every 30 s. Cheap: an index on expires_at means the query is
// O(expired rows). Polling beats a per-market setTimeout because:
//   - restarts don't leak timers,
//   - DB is the single source of truth (no in-memory queue to
//     reconcile),
//   - a 30 s lag between expiry and cancel is fine for a chat-paced
//     product.
import type { Client, TextChannel } from "discord.js";
import log from "../logger.js";
import { renderMarketView } from "./commands/market.js";
import { cancelBet, getExpiredOpenBets } from "./store.js";

const TICK_MS = 30_000;

async function tick(client: Client): Promise<void> {
  const expired = getExpiredOpenBets();
  for (const b of expired) {
    try {
      cancelBet(b.id);
    } catch (err) {
      log.error({ betId: b.id, err }, "Market auto-cancel failed");
      continue;
    }
    if (!b.channelId || !b.messageId) continue;
    try {
      const channel = await client.channels.fetch(b.channelId);
      if (!channel?.isTextBased()) continue;
      const message = await (channel as TextChannel).messages.fetch(b.messageId);
      const view = renderMarketView(b.id);
      await message.edit({
        content: view.content ?? null,
        embeds: view.embeds ?? [],
        components: view.components ?? [],
      });
    } catch (err) {
      // Message probably deleted — the cancel is still applied in the
      // DB, so this is purely a UI-sync failure.
      log.warn({ betId: b.id, err }, "Couldn't edit expired market message");
    }
  }
}

export function startExpiryWatcher(client: Client): void {
  setInterval(() => {
    tick(client).catch((err) => log.error({ err }, "Market expiry tick failed"));
  }, TICK_MS);
  // Run once on startup to pick up anything that expired while the
  // bot was down.
  tick(client).catch((err) => log.error({ err }, "Initial market expiry tick failed"));
}
