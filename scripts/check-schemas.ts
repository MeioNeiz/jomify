// Probe Leetify live responses against our Zod schemas.
// Run on prod: ssh opc@host 'cd ~/jomify && bun scripts/check-schemas.ts <steamId> [gameId]'
import type { ZodType } from "zod";
import {
  leetifyMatchDetailsSchema,
  leetifyMatchHistorySchema,
  leetifyProfileSchema,
} from "../src/cs/leetify/schemas.js";

const steamId = process.argv[2];
if (!steamId) {
  console.error("usage: bun scripts/check-schemas.ts <steam64> [gameId]");
  process.exit(1);
}
const key = process.env.LEETIFY_API_KEY;
if (!key) {
  console.error("LEETIFY_API_KEY not set");
  process.exit(1);
}

const BASE = "https://api-public.cs-prod.leetify.com";
const h = { Authorization: `Bearer ${key}` };

async function probe(label: string, path: string, schema: ZodType): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: h });
  console.log(`\n── ${label} (${res.status}) ${path}`);
  if (!res.ok) {
    console.log(`  HTTP ${res.status} ${res.statusText}`);
    return null;
  }
  const json = await res.json();
  const parsed = schema.safeParse(json);
  if (parsed.success) {
    console.log("  ✓ schema OK");
    return json;
  }
  console.log(`  ✗ ${parsed.error.issues.length} issues:`);
  const seen = new Set<string>();
  for (const i of parsed.error.issues) {
    const keyPath = i.path
      .map((p) => (typeof p === "number" ? "[]" : String(p)))
      .join(".");
    const sig = `${keyPath}|${i.code}|${i.message}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    console.log(`    ${keyPath}: ${i.message}`);
  }
  return json;
}

const profile = (await probe(
  "profile",
  `/v3/profile?steam64_id=${steamId}`,
  leetifyProfileSchema,
)) as { recent_matches?: { id: string }[] } | null;

const history = (await probe(
  "match-history",
  `/v3/profile/matches?steam64_id=${steamId}`,
  leetifyMatchHistorySchema,
)) as { id: string }[] | null;

const gameId = process.argv[3] || history?.[0]?.id || profile?.recent_matches?.[0]?.id;
if (gameId) {
  await probe("match-details", `/v2/matches/${gameId}`, leetifyMatchDetailsSchema);
} else {
  console.log("\n(no gameId to probe match-details)");
}
