// CoinGecko simple-price client. Thin wrapper used by the crypto
// resolvers; rate-limiting and skip logic live in the resolvers themselves
// so each bet tracks its own last-checked timestamp independently.
//
// No API key required for the free simple-price endpoint. Unknown symbols
// return null (the resolver treats that the same as a transient fetch
// failure — keep pending, try again later).
export type CryptoPrice = { price: number };

// User-facing symbol → CoinGecko coin id. Extend as needed; anything not
// listed here is passed through lowercased as a fallback so exotic coins
// can still work if the user knows the CoinGecko id.
const SYMBOL_TO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  DOGE: "dogecoin",
  ADA: "cardano",
  XRP: "ripple",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  MATIC: "matic-network",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  DOT: "polkadot",
  TRX: "tron",
  SHIB: "shiba-inu",
  PEPE: "pepe",
};

function toCoinId(symbol: string): string {
  const upper = symbol.toUpperCase();
  return SYMBOL_TO_ID[upper] ?? symbol.toLowerCase();
}

export async function fetchCryptoPrice(
  symbol: string,
  fetchFn: typeof fetch = fetch,
): Promise<CryptoPrice | null> {
  const id = toCoinId(symbol);
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}` +
    `&vs_currencies=usd`;
  try {
    const resp = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, { usd?: number }>;
    const entry = data[id];
    if (!entry || typeof entry.usd !== "number" || !Number.isFinite(entry.usd)) {
      return null;
    }
    return { price: entry.usd };
  } catch {
    return null;
  }
}

const POLL_MIN = 5;

export function shouldPoll(
  lastCheckedIso: string | null | undefined,
  now: Date,
): boolean {
  if (!lastCheckedIso) return true;
  return now.getTime() - new Date(lastCheckedIso).getTime() >= POLL_MIN * 60_000;
}
