// Fire-and-forget POST to the bot's loopback /refresh endpoint so
// Discord messages re-render after an admin write. Non-throwing: a
// missing bot just means the message stays stale until next click.
export async function notifyBot(payload: {
  type: "market" | "dispute";
  id: number;
}): Promise<void> {
  const port = process.env.INTERNAL_PORT ?? "3001";
  try {
    await fetch(`http://127.0.0.1:${port}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* bot not running or refresh failed — not fatal */
  }
}

export type IpcChannel = {
  id: string;
  name: string;
  parentName: string | null;
  position: number;
};

/**
 * Ask the bot loopback for the guild's text + announcement channels.
 * Returns an empty list if the bot isn't running, isn't in the guild,
 * or the call times out — caller shows a fallback text input.
 */
export async function fetchGuildChannels(guildId: string): Promise<IpcChannel[]> {
  const port = process.env.INTERNAL_PORT ?? "3001";
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/channels?guildId=${encodeURIComponent(guildId)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { channels?: IpcChannel[] };
    return body.channels ?? [];
  } catch {
    return [];
  }
}
