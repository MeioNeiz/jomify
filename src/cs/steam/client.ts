import { z } from "zod";
import { config } from "../../config.js";
import log from "../../logger.js";

const VANITY_URL = "https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/";

// 17-digit IDs starting with 7656119 are individual Steam64 accounts.
// (Groups/clans start with 103582791 etc — we don't accept those.)
const STEAM64_RE = /^7656119\d{10}$/;

const resolveSchema = z.object({
  response: z.object({
    steamid: z.string().optional(),
    success: z.number(),
    message: z.string().optional(),
  }),
});

export type ResolveResult =
  | { ok: true; steamId: string }
  | { ok: false; reason: "not-found" | "invalid-input" | "api-error" };

/**
 * Accepts any of: raw steam64, full profile URL, full vanity URL, or
 * bare vanity handle. Returns the steam64 or a reason string if it
 * can't be resolved.
 */
export async function resolveSteamId(input: string): Promise<ResolveResult> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "invalid-input" };

  // Profile URL with numeric id.
  const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profileMatch) return { ok: true, steamId: profileMatch[1] };

  // Vanity URL.
  const vanityMatch = trimmed.match(/steamcommunity\.com\/id\/([^/?#\s]+)/i);
  const handle = vanityMatch?.[1] ?? trimmed;

  if (STEAM64_RE.test(handle)) return { ok: true, steamId: handle };

  // Reject anything with a slash or whitespace — likely a malformed URL.
  if (/[\s/]/.test(handle)) return { ok: false, reason: "invalid-input" };

  return resolveVanity(handle);
}

async function resolveVanity(handle: string): Promise<ResolveResult> {
  const url = `${VANITY_URL}?key=${config.steamApiKey}&vanityurl=${encodeURIComponent(handle)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    log.warn({ err, handle }, "Steam vanity fetch failed");
    return { ok: false, reason: "api-error" };
  }
  if (!res.ok) {
    log.warn({ status: res.status, handle }, "Steam vanity non-2xx");
    return { ok: false, reason: "api-error" };
  }
  const parsed = resolveSchema.safeParse(await res.json());
  if (!parsed.success) {
    log.warn({ handle }, "Steam vanity response failed schema");
    return { ok: false, reason: "api-error" };
  }
  const { success, steamid } = parsed.data.response;
  if (success === 1 && steamid) return { ok: true, steamId: steamid };
  return { ok: false, reason: "not-found" };
}
