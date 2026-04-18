import type {
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
} from "discord.js";
import { fetchGuildProfiles } from "../helpers.js";
import { LeetifyUnavailableError } from "../leetify/client.js";
import type { LeetifyProfile } from "../leetify/types.js";
import log from "../logger.js";
import { markFirstReply, markLastReply, runWithMetrics } from "../metrics.js";
import { getSteamId } from "../store.js";

type CommandFn = (interaction: ChatInputCommandInteraction) => Promise<void>;

/**
 * Wraps `reply`/`editReply` on a single interaction so every call feeds
 * the active metrics collector. Mutates the interaction instance
 * directly — each interaction is used once and then discarded, so
 * scoping the wrapper to the instance avoids cross-talk between
 * concurrent invocations.
 */
function instrumentReplies(interaction: ChatInputCommandInteraction): void {
  const origReply = interaction.reply.bind(interaction);
  const origEditReply = interaction.editReply.bind(interaction);
  interaction.reply = (async (...args: Parameters<typeof origReply>) => {
    markFirstReply();
    markLastReply();
    return origReply(...args);
  }) as typeof interaction.reply;
  interaction.editReply = (async (...args: Parameters<typeof origEditReply>) => {
    markFirstReply();
    markLastReply();
    return origEditReply(...args);
  }) as typeof interaction.editReply;
}

/**
 * Wraps a command with deferReply + error handling.
 * Set defer to false for commands that reply immediately.
 */
function snapshotOptions(interaction: ChatInputCommandInteraction): string | undefined {
  try {
    // interaction.options.data is the raw CommandInteractionOption[]
    // — includes the resolved subcommand (if any) and each option's
    // name/type/value/user/etc. JSON.stringify handles the tree
    // natively; non-serialisable bits (e.g. resolved User instances)
    // stringify to simple {id, username} shapes.
    const data = interaction.options.data;
    if (!data?.length) return undefined;
    return JSON.stringify(data);
  } catch {
    return undefined;
  }
}

export function wrapCommand(fn: CommandFn, opts?: { defer?: boolean }): CommandFn {
  const defer = opts?.defer ?? true;
  return async (interaction) => {
    await runWithMetrics(
      {
        command: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId ?? undefined,
        options: snapshotOptions(interaction),
      },
      async () => {
        instrumentReplies(interaction);
        if (defer) await interaction.deferReply();
        try {
          await fn(interaction);
        } catch (err) {
          const e = err as { code?: number; message?: string } | undefined;
          if (e?.code === 10062) return;
          log.error({ cmd: interaction.commandName, err }, "Command error");

          let msg = "Something went wrong.";
          if (err instanceof LeetifyUnavailableError) {
            msg = "Leetify is down right now \u2014 try again in a minute.";
          } else if (e?.message?.includes("Leetify API error")) {
            msg = "Leetify API error \u2014 try again shortly.";
          } else if (e?.message?.includes("fetch failed")) {
            msg = "Network error \u2014 couldn't reach external services.";
          }

          try {
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply(msg);
            } else {
              await interaction.reply(msg);
            }
          } catch {
            /* interaction gone */
          }
        }
      },
    );
  };
}

/** Resolve a user option to a steamId, or reply with error. */
export async function requireLinkedUser(
  interaction: ChatInputCommandInteraction,
  userOpt = "user",
): Promise<{ steamId: string; label: string } | null> {
  const user = interaction.options.getUser(userOpt);
  const discordId = user?.id ?? interaction.user.id;
  const label = user?.displayName ?? interaction.user.displayName;
  const steamId = getSteamId(discordId);
  if (!steamId) {
    await interaction.editReply(`${label} hasn't linked. Use \`/link\` first.`);
    return null;
  }
  return { steamId, label };
}

/** Require a guild + tracked profiles, or reply with error. */
export async function requireGuildProfiles(
  interaction: ChatInputCommandInteraction,
): Promise<{ guildId: string; profiles: LeetifyProfile[] } | null> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Use this in a server.");
    return null;
  }
  const profiles = await fetchGuildProfiles(guildId);
  if (!profiles) {
    await interaction.editReply("No tracked players. Use `/track` to add some.");
    return null;
  }
  return { guildId, profiles };
}

/**
 * Stale-while-revalidate: reply immediately from local data, then fetch
 * fresh in parallel and update the message if it differs.
 *
 * - If `fetchCached` returns data, render it and editReply straight away.
 * - Meanwhile, await `fetchFresh`. On success and when the rendered payload
 *   differs from the cached one, edit the message with the fresh version.
 * - On fresh failure with a cached reply already shown: leave it, log a warn.
 * - On fresh failure with no cache: surface `missingMessage` (or rethrow).
 */
export async function respondWithRevalidate<T>(
  interaction: ChatInputCommandInteraction,
  opts: {
    fetchCached: () => { data: T; snapshotAt: string | null } | null;
    fetchFresh: () => Promise<T>;
    render: (
      data: T,
      meta: { cached: boolean; snapshotAt: string | null },
    ) => InteractionEditReplyOptions;
    missingMessage?: string;
  },
): Promise<void> {
  const cached = opts.fetchCached();
  let shownKey: string | null = null;

  if (cached) {
    const payload = opts.render(cached.data, {
      cached: true,
      snapshotAt: cached.snapshotAt,
    });
    await interaction.editReply(payload);
    shownKey = JSON.stringify(payload);
  }

  try {
    const fresh = await opts.fetchFresh();
    const payload = opts.render(fresh, { cached: false, snapshotAt: null });
    const key = JSON.stringify(payload);
    if (key !== shownKey) {
      await interaction.editReply(payload);
    }
  } catch (err) {
    if (cached) {
      log.warn(
        { err, cmd: interaction.commandName },
        "Revalidate failed \u2014 keeping cached reply",
      );
      return;
    }
    const msg = opts.missingMessage ?? "Leetify is down and no cached data is available.";
    await interaction.editReply(msg);
  }
}
