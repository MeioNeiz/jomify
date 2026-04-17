import type { ZodType } from "zod";
import { config } from "../config.js";
import log from "../logger.js";
import {
  clearLeetifyUnknown,
  markLeetifyUnknown,
  saveSnapshots,
  trackApiCall,
} from "../store.js";
import {
  leetifyMatchDetailsSchema,
  leetifyMatchHistorySchema,
  leetifyProfileSchema,
} from "./schemas.js";
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

/**
 * True if the breaker tripped in the last CIRCUIT_COOLDOWN ms —
 * consulted by presentation code to append a "Leetify unavailable"
 * note to stale data, so users understand why `/leaderboard` etc.
 * are showing an old snapshot.
 */
export function isLeetifyCircuitOpen(): boolean {
  checkCircuit();
  return circuitOpen;
}

export class LeetifyUnavailableError extends Error {
  constructor() {
    super("Leetify API unavailable");
  }
}

/**
 * Thrown when Leetify returns 404 for a Steam account — the user exists
 * on Steam but hasn't set up a Leetify profile. Callers should treat
 * this as a persistent state rather than a retryable failure.
 */
export class LeetifyNotFoundError extends Error {
  constructor(public readonly steamId: string) {
    super(`Leetify: no profile for ${steamId}`);
  }
}

// ── Fetch with retries ──

// We validate the shape at runtime via zod, but the declared return type T
// comes from the caller's interface (LeetifyProfile, LeetifyMatchDetails…).
// The schema's inferred output can differ slightly (passthrough adds an
// index signature, tuples/arrays may vary) so we accept any ZodType and
// let the caller assert T.
async function leetifyFetch<T>(path: string, schema: ZodType): Promise<T> {
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
      // 404s are persistent (user has no Leetify profile); callers mark
      // them and stop polling, so warn-level would be noise.
      const meta = { status: res.status, endpoint, attempts: attempt + 1 };
      if (res.status === 404) log.debug(meta, "Leetify API error");
      else log.warn(meta, "Leetify API error");
      throw new Error(`Leetify API error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      log.warn(
        { endpoint, issues: parsed.error.issues.slice(0, 5) },
        "Leetify response failed schema validation",
      );
      throw new Error(`Leetify API: invalid response shape from ${endpoint}`);
    }
    return parsed.data as T;
  }

  tripCircuit();
  throw new Error("Leetify API: max retries exceeded");
}

function is404(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

// Snapshots in the DB are the only profile cache. Every successful fetch
// is written through so /stats, /compare, /leaderboard can serve stale
// while revalidating.
export async function getProfile(steamId: string): Promise<LeetifyProfile> {
  let data: LeetifyProfile;
  try {
    data = await leetifyFetch<LeetifyProfile>(
      `/v3/profile?steam64_id=${steamId}`,
      leetifyProfileSchema,
    );
  } catch (err) {
    if (is404(err)) {
      markLeetifyUnknown(steamId);
      throw new LeetifyNotFoundError(steamId);
    }
    throw err;
  }
  // Successful fetch — if the user was previously marked unknown, they
  // just signed up. Clear the mark so future polls proceed normally.
  clearLeetifyUnknown(steamId);
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
  try {
    return await leetifyFetch<LeetifyMatchDetails[]>(
      `/v3/profile/matches?steam64_id=${steamId}`,
      leetifyMatchHistorySchema,
    );
  } catch (err) {
    if (is404(err)) {
      markLeetifyUnknown(steamId);
      throw new LeetifyNotFoundError(steamId);
    }
    throw err;
  }
}

export async function getMatchDetails(gameId: string): Promise<LeetifyMatchDetails> {
  return leetifyFetch<LeetifyMatchDetails>(
    `/v2/matches/${gameId}`,
    leetifyMatchDetailsSchema,
  );
}
