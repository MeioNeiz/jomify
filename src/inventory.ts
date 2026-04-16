interface PriceData {
  lowest_price?: string;
  median_price?: string;
}

export interface InventorySummary {
  totalItems: number;
  totalValue: number;
  topItem: { name: string; price: number } | null;
  top5: { name: string; priceStr: string }[];
}

const priceCache = new Map<string, { price: PriceData; at: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function getCachedPrice(name: string): PriceData | null {
  const e = priceCache.get(name);
  if (!e || Date.now() - e.at > CACHE_TTL) {
    priceCache.delete(name);
    return null;
  }
  return e.price;
}

function parsePrice(s: string | undefined): number {
  return s ? parseFloat(s.replace(/[^0-9.]/g, "")) || 0 : 0;
}

async function fetchPrice(name: string): Promise<PriceData | null> {
  const cached = getCachedPrice(name);
  if (cached) return cached;
  const res = await fetch(
    "https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=" +
      encodeURIComponent(name),
  );
  if (!res.ok) return null;
  const data = (await res.json()) as PriceData;
  priceCache.set(name, { price: data, at: Date.now() });
  return data;
}

export async function fetchInventorySummary(
  steamId: string,
): Promise<InventorySummary | "private" | "error"> {
  const res = await fetch(
    `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=100`,
  );
  if (res.status === 403) return "private";
  if (!res.ok) return "error";

  const inv = (await res.json()) as {
    assets: { classid: string; instanceid: string; amount: string }[];
    descriptions: {
      classid: string;
      instanceid: string;
      market_hash_name: string;
      name: string;
      type: string;
      marketable: number;
    }[];
    total_inventory_count: number;
  };

  const descMap = new Map<string, (typeof inv.descriptions)[0]>();
  for (const d of inv.descriptions) descMap.set(`${d.classid}_${d.instanceid}`, d);

  const counts = new Map<string, number>();
  for (const a of inv.assets) {
    const d = descMap.get(`${a.classid}_${a.instanceid}`);
    if (!d?.marketable) continue;
    counts.set(
      d.market_hash_name,
      (counts.get(d.market_hash_name) ?? 0) + parseInt(a.amount, 10),
    );
  }

  const priced: { name: string; price: number }[] = [];
  for (const name of [...counts.keys()].slice(0, 20)) {
    const p = await fetchPrice(name);
    if (!p) continue;
    const price = parsePrice(p.lowest_price) || parsePrice(p.median_price);
    if (price <= 0) continue;
    const qty = counts.get(name) ?? 1;
    priced.push({ name, price: price * qty });
  }
  priced.sort((a, b) => b.price - a.price);

  return {
    totalItems: inv.total_inventory_count,
    totalValue: priced.reduce((s, i) => s + i.price, 0),
    topItem: priced[0] ?? null,
    top5: priced.slice(0, 5).map((i) => ({
      name: i.name,
      priceStr: `$${i.price.toFixed(2)}`,
    })),
  };
}
