import { decodeLink } from "@csfloat/cs2-inspect-serializer";
import { config } from "./config.js";
import log from "./logger.js";

export interface InventoryItem {
  name: string;
  price: number;
  inspectUrl: string | null;
  float: number | null;
  paintSeed: number | null;
}

export interface InventorySummary {
  totalItems: number;
  totalValue: number;
  topItem: { name: string; price: number } | null;
  top5: InventoryItem[];
}

// ── USD→GBP rate (cached 24h) ──

let rateCache: { gbp: number; at: number } | null = null;
const RATE_TTL = 24 * 60 * 60 * 1000;
const FALLBACK_RATE = 0.79;

async function usdToGbp(): Promise<number> {
  if (rateCache && Date.now() - rateCache.at < RATE_TTL) return rateCache.gbp;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = (await res.json()) as { rates?: { GBP?: number } };
    if (data.rates?.GBP) {
      rateCache = { gbp: data.rates.GBP, at: Date.now() };
      return data.rates.GBP;
    }
  } catch (err) {
    log.warn({ err }, "USD→GBP rate fetch failed, using fallback");
  }
  return rateCache?.gbp ?? FALLBACK_RATE;
}

// ── Price lookup (CSFloat primary, Steam Market fallback) ──

const priceCache = new Map<string, { price: number; at: number }>();
const PRICE_TTL = 5 * 60 * 1000;

function getCachedPrice(name: string): number | null {
  const e = priceCache.get(name);
  if (!e || Date.now() - e.at > PRICE_TTL) {
    priceCache.delete(name);
    return null;
  }
  return e.price;
}

async function fetchCsfloatPriceGbp(name: string, rate: number): Promise<number | null> {
  const url =
    "https://csfloat.com/api/v1/listings?" +
    `market_hash_name=${encodeURIComponent(name)}&sort_by=lowest_price&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: config.csfloatApiKey ?? "" },
  });
  if (!res.ok) {
    log.debug({ status: res.status, name }, "CSFloat price lookup failed");
    return null;
  }
  const data = (await res.json()) as { data?: Array<{ price: number }> };
  const cents = data.data?.[0]?.price;
  if (cents == null) return null;
  return (cents / 100) * rate;
}

async function fetchSteamPriceGbp(name: string): Promise<number | null> {
  // currency=2 = GBP
  const res = await fetch(
    "https://steamcommunity.com/market/priceoverview/?appid=730&currency=2" +
      `&market_hash_name=${encodeURIComponent(name)}`,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    lowest_price?: string;
    median_price?: string;
  };
  const s = data.lowest_price ?? data.median_price;
  if (!s) return null;
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchPriceGbp(name: string, rate: number): Promise<number | null> {
  const cached = getCachedPrice(name);
  if (cached != null) return cached > 0 ? cached : null;

  let price: number | null = null;
  if (config.csfloatApiKey) price = await fetchCsfloatPriceGbp(name, rate);
  if (price == null) price = await fetchSteamPriceGbp(name);
  priceCache.set(name, { price: price ?? 0, at: Date.now() });
  return price;
}

// ── Inspect link handling ──

/** Fill in %owner_steamid% / %assetid% placeholders if present. */
function resolveInspectUrl(
  template: string | undefined,
  steamId: string,
  assetId: string,
): string | null {
  if (!template) return null;
  return template.replace("%owner_steamid%", steamId).replace("%assetid%", assetId);
}

function safeDecode(url: string | null): { float: number | null; seed: number | null } {
  if (!url) return { float: null, seed: null };
  try {
    const d = decodeLink(url);
    return { float: d.paintwear ?? null, seed: d.paintseed ?? null };
  } catch {
    return { float: null, seed: null };
  }
}

// ── Inventory fetch ──

type SteamAction = { name?: string; link?: string };
type SteamAsset = {
  assetid: string;
  classid: string;
  instanceid: string;
  amount: string;
};
type SteamDesc = {
  classid: string;
  instanceid: string;
  market_hash_name: string;
  marketable: number;
  actions?: SteamAction[];
};
type SteamInventory = {
  assets: SteamAsset[];
  descriptions: SteamDesc[];
  total_inventory_count: number;
};

export async function fetchInventorySummary(
  steamId: string,
): Promise<InventorySummary | "private" | "error"> {
  const res = await fetch(
    `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=100`,
  );
  if (res.status === 403) return "private";
  if (!res.ok) return "error";

  const inv = (await res.json()) as SteamInventory;

  const descMap = new Map<string, SteamDesc>();
  for (const d of inv.descriptions) descMap.set(`${d.classid}_${d.instanceid}`, d);

  type AssetItem = {
    name: string;
    assetId: string;
    inspectUrl: string | null;
  };
  const items: AssetItem[] = [];
  for (const a of inv.assets) {
    const d = descMap.get(`${a.classid}_${a.instanceid}`);
    if (!d?.marketable) continue;
    const template = d.actions?.find((x) => x.name?.includes("Inspect"))?.link;
    items.push({
      name: d.market_hash_name,
      assetId: a.assetid,
      inspectUrl: resolveInspectUrl(template, steamId, a.assetid),
    });
  }

  // Dedupe price lookups by name, cap at 20 distinct names.
  const rate = await usdToGbp();
  const names = [...new Set(items.map((i) => i.name))].slice(0, 20);
  const prices = new Map<string, number>();
  for (const name of names) {
    const p = await fetchPriceGbp(name, rate);
    if (p != null && p > 0) prices.set(name, p);
  }

  const priced = items
    .filter((i) => prices.has(i.name))
    .map((i) => ({ ...i, price: prices.get(i.name) ?? 0 }))
    .sort((a, b) => b.price - a.price);

  const top5: InventoryItem[] = priced.slice(0, 5).map((i) => {
    const { float, seed } = safeDecode(i.inspectUrl);
    return {
      name: i.name,
      price: i.price,
      inspectUrl: i.inspectUrl,
      float,
      paintSeed: seed,
    };
  });

  return {
    totalItems: inv.total_inventory_count,
    totalValue: priced.reduce((s, i) => s + i.price, 0),
    topItem: priced[0] ? { name: priced[0].name, price: priced[0].price } : null,
    top5,
  };
}
