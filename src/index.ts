import {
  ChannelType,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  type TextChannel,
} from "discord.js";
import { type Command, commands } from "./commands/index.js";
import { dispatchComponent } from "./components.js";
// Side-effect import: subscribes betting to cs:match-completed. Keeps
// the CS module ignorant of betting while ensuring grants land in the
// same process.
import "./betting/listeners/cs-match-completed.js";
import { startFirstToListener } from "./betting/listeners/cs-first-to.js";
// Side-effect import: registers the CS next-match resolver kinds. Must
// land before the watcher starts so the registry is populated when the
// first tick fires.
import "./betting/resolvers/cs-next-match.js";
import "./betting/resolvers/cs-premier-milestone.js";
import "./betting/resolvers/cs-win-streak.js";
import "./betting/resolvers/cs-clutch-count.js";
import "./betting/resolvers/cs-first-to.js";
import "./betting/resolvers/stock.js";
import "./betting/resolvers/crypto.js";
import "./betting/resolvers/polymarket.js";
import "./betting/resolvers/kalshi.js";
import { renderMarketView } from "./betting/commands/market.js";
import { startExpiryWatcher } from "./betting/expiry.js";
import { startResolverWatcher } from "./betting/resolvers/watcher.js";
import { getBet, setBetMessage } from "./betting/store/bets.js";
import { getDispute } from "./betting/store/disputes.js";
import { config } from "./config.js";
import { startWatcher } from "./cs/watcher.js";
import log from "./logger.js";
import { startWeekly } from "./weekly.js";

const commandMap = new Collection<string, Command>();
for (const [name, cmd] of commands) commandMap.set(name, cmd);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  // Default: never ping anyone. Mentions still render as clickable
  // names but don't trigger notifications. Commands can override
  // per-message if they need to ping (e.g. alerts).
  allowedMentions: { parse: [] },
});

client.once(Events.ClientReady, (c) => {
  log.info({ tag: c.user.tag }, "Jomify online");
  startWatcher(client);
  startWeekly(client);
  startExpiryWatcher(client);
  startResolverWatcher(client);
  startFirstToListener(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isModalSubmit()
  ) {
    await dispatchComponent(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    if ((err as { code?: number })?.code === 10062) return;
    log.error({ cmd: interaction.commandName, err }, "Unhandled command error");
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Something went wrong.");
      } else {
        await interaction.reply("Something went wrong.");
      }
    } catch {
      /* interaction gone */
    }
  }
});

client.login(config.discordToken);

// ── Admin IPC loopback ────────────────────────────────────────────────
// Listens on 127.0.0.1 only. Admin site POSTs here after writes so
// Discord messages re-render immediately without waiting for a button click.

const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT ?? "3001", 10);

Bun.serve({
  port: INTERNAL_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/channels") {
      const guildId = url.searchParams.get("guildId");
      if (!guildId) return new Response("Missing guildId", { status: 400 });
      try {
        const guild = await client.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        const textLike = [...channels.values()]
          .filter(
            (ch): ch is NonNullable<typeof ch> =>
              ch != null &&
              (ch.type === ChannelType.GuildText ||
                ch.type === ChannelType.GuildAnnouncement),
          )
          .map((ch) => ({
            id: ch.id,
            name: ch.name,
            parentName: ch.parent?.name ?? null,
            position: ch.position,
          }))
          .sort((a, b) => a.position - b.position);
        return Response.json({ channels: textLike });
      } catch (err) {
        log.warn({ guildId, err }, "IPC /channels failed");
        return Response.json(
          { error: (err as Error).message, channels: [] },
          { status: 502 },
        );
      }
    }
    if (req.method === "POST" && url.pathname === "/post-market") {
      let payload: { betId: number; channelId: string };
      try {
        payload = (await req.json()) as { betId: number; channelId: string };
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      if (!payload.betId || !payload.channelId) {
        return new Response("Missing betId or channelId", { status: 400 });
      }
      const bet = getBet(payload.betId);
      if (!bet) return new Response(`Bet ${payload.betId} not found`, { status: 404 });
      try {
        const ch = await client.channels.fetch(payload.channelId);
        if (!ch?.isTextBased()) {
          return new Response("Channel is not text-capable", { status: 400 });
        }
        const view = renderMarketView(payload.betId);
        const msg = await (ch as TextChannel).send({
          content: view.content ?? undefined,
          embeds: view.embeds ?? [],
          components: view.components ?? [],
        });
        setBetMessage(payload.betId, msg.channelId, msg.id);
        return new Response("OK");
      } catch (err) {
        log.warn({ betId: payload.betId, err }, "IPC /post-market failed");
        return new Response((err as Error).message, { status: 502 });
      }
    }
    if (req.method !== "POST" || url.pathname !== "/refresh") {
      return new Response("Not Found", { status: 404 });
    }
    let body: { type: string; id: number };
    try {
      body = (await req.json()) as { type: string; id: number };
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      if (body.type === "market") {
        const bet = getBet(body.id);
        if (bet?.channelId && bet.messageId) {
          const ch = await client.channels.fetch(bet.channelId);
          if (ch?.isTextBased()) {
            const msg = await (ch as TextChannel).messages.fetch(bet.messageId);
            const view = renderMarketView(body.id);
            await msg.edit({
              content: view.content ?? null,
              embeds: view.embeds ?? [],
              components: view.components ?? [],
            });
          }
        }
      } else if (body.type === "dispute") {
        // Dispute panel re-render is handled by re-importing the render
        // function. We import lazily to avoid a circular dep at module load.
        const { renderDisputeView } = await import("./betting/disputes.js");
        const dispute = getDispute(body.id);
        if (dispute?.channelId && dispute.messageId) {
          const ch = await client.channels.fetch(dispute.channelId);
          if (ch?.isTextBased()) {
            const msg = await (ch as TextChannel).messages.fetch(dispute.messageId);
            const view = renderDisputeView(body.id);
            await msg.edit({
              embeds: view.embeds ?? [],
              components: view.components ?? [],
            });
          }
        }
      }
    } catch (err) {
      log.warn({ type: body.type, id: body.id, err }, "IPC refresh failed");
    }

    return new Response("OK");
  },
});
