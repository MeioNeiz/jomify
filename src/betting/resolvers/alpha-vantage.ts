// Alpha Vantage quote client. Thin wrapper used by the stock resolvers;
// rate-limiting and skip logic live in the resolvers themselves so each
// bet tracks its own last-checked timestamp independently.
export type Quote = { price: number; tradingDay: string };

export async function fetchQuote(
  ticker: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<Quote | null> {
  const url =
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE` +
    `&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;
    const q = (data as { "Global Quote"?: Record<string, string> })["Global Quote"];
    if (!q) return null;
    const price = parseFloat(q["05. price"] ?? "");
    const tradingDay = q["07. latest trading day"] ?? "";
    if (!Number.isFinite(price)) return null;
    return { price, tradingDay };
  } catch {
    return null;
  }
}

const POLL_MIN = 15;

/** NYSE market hours: Mon–Fri 14:30–21:00 UTC (EST/EDT approximation). */
export function isDuringTradingHours(now: Date): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return totalMin >= 14 * 60 + 30 && totalMin <= 21 * 60;
}

export function shouldPoll(
  lastCheckedIso: string | null | undefined,
  now: Date,
): boolean {
  if (!lastCheckedIso) return true;
  return now.getTime() - new Date(lastCheckedIso).getTime() >= POLL_MIN * 60_000;
}
