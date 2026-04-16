import { config } from "../config.js";
import log from "../logger.js";
import { saveSnapshots, trackApiCall } from "../store.js";
import type { LeetifyMatchDetails, LeetifyProfile } from "./types.js";

const BASE_URL = "https://api-public.cs-prod.leetify.com";
const MAX_RETRIES = 3;

// ── Circuit breaker ──

let circuitOpen = false;
let circuitOpensAt = 0;
const CIRCUIT_COOLDOWN = 60_000; // 1 min

function tripCircuit() {
  if (!circuitOpen) {
    log.warn("Leetify circuit breaker tripped — pausing requests for 1 min");
  }
  circuitOpen = true;
  circuitOpensAt = Date.now() + CIRCUIT_COOLDOWN;
}

function checkCircuit() {
  if (!circuitOpen) return;
  if (Date.now() >= circuitOpensAt) {
    circuitOpen = false;
    log.info("Leetify circuit breaker reset");
  }
}

export class LeetifyUnavailableError extends Error {
  constructor() {
    super("Leetify API unavailable");
  }
}

// ── Fetch with retries ──

async function leetifyFetch<T>(path: string): Promise<T> {
  checkCircuit();
  if (circuitOpen) throw new LeetifyUnavailableError();

  const endpoint = path.split("?")[0];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    trackApiCall(`leetify:${endpoint}`);
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${config.leetifyApiKey}` },
    });

    const retryable = res.status === 429 || res.status === 502 || res.status === 503;
    if (retryable && attempt < MAX_RETRIES) {
      const after = res.headers.get("Retry-After");
      const wait = after ? Number(after) * 1000 : 2000 * (attempt + 1);
      log.debug({ status: res.status, endpoint, attempt }, "Leetify retrying");
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      if (retryable) tripCircuit();
      log.warn(
        { status: res.status, endpoint, attempts: attempt + 1 },
        "Leetify API error",
      );
      throw new Error(`Leetify API error: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<T>;
  }

  tripCircuit();
  throw new Error("Leetify API: max retries exceeded");
}

// Snapshots in the DB are the only profile cache. Every successful fetch
// is written through so /stats, /compare, /leaderboard can serve stale
// while revalidating.
export async function getProfile(steamId: string): Promise<LeetifyProfile> {
  const data = await leetifyFetch<LeetifyProfile>(`/v3/profile?steam64_id=${steamId}`);
  saveSnapshots([
    {
      steamId: data.steam64_id,
      name: data.name,
      premier: data.ranks?.premier ?? null,
      leetify: data.ranks?.leetify ?? null,
      aim: data.rating?.aim ?? 0,
      positioning: data.rating?.positioning ?? 0,
      utility: data.rating?.utility ?? 0,
      clutch: data.rating?.clutch ?? 0,
    },
  ]);
  return data;
}

export async function getMatchHistory(steamId: string): Promise<LeetifyMatchDetails[]> {
  return leetifyFetch<LeetifyMatchDetails[]>(`/v3/profile/matches?steam64_id=${steamId}`);
}

export async function getMatchDetails(gameId: string): Promise<LeetifyMatchDetails> {
  return leetifyFetch<LeetifyMatchDetails>(`/v2/matches/${gameId}`);
}
