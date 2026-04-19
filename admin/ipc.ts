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
