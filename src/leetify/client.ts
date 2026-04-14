import { config } from "../config.js";
import type {
  LeetifyProfile,
  LeetifyRecentMatch,
  LeetifyMatchDetails,
} from "./types.js";

const BASE_URL =
  "https://api-public.cs-prod.leetify.com";

async function leetifyFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${config.leetifyApiKey}`,
    },
  });

  if (!res.ok) {
    throw new Error(
      `Leetify API error: ${res.status} ${res.statusText}`
    );
  }

  return res.json() as Promise<T>;
}

export async function getProfile(
  steamId: string
): Promise<LeetifyProfile> {
  return leetifyFetch<LeetifyProfile>(
    `/v3/profile?steam64_id=${steamId}`
  );
}

export async function getMatchHistory(
  steamId: string
): Promise<LeetifyMatchDetails[]> {
  return leetifyFetch<LeetifyMatchDetails[]>(
    `/v3/profile/matches?steam64_id=${steamId}`
  );
}

export async function getMatchDetails(
  gameId: string
): Promise<LeetifyMatchDetails> {
  return leetifyFetch<LeetifyMatchDetails>(
    `/v2/matches/${gameId}`
  );
}
