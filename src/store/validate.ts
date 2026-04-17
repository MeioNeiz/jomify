// Shared runtime guards for store-layer write paths.
//
// The vanity-URL incident that prompted this module: `/link` used to
// accept any string as the steam id, so rows like
// {discord: ..., steam_id: "laryisland"} ended up in linked_accounts.
// The fix had to resolve existing data AND ensure no future caller
// could slip an unresolved vanity through. An explicit check at the
// write boundary is the cheapest place to enforce it — commands can
// still call resolveSteamId upfront, but they can't skip normalisation
// and expect the store to silently store junk.

/**
 * Steam64 IDs for personal accounts always start with 7656119 and are
 * exactly 17 digits. (Group/clan IDs start with 103582791 etc — we
 * don't accept those here.) Matches `src/steam/client.ts:STEAM64_RE`.
 */
const STEAM64_RE = /^7656119\d{10}$/;

/**
 * Throw if the given string is not a steam64. Callers that need to
 * store a steam id (linkAccount, addTrackedPlayer…) must call a
 * resolver first — we refuse to persist vanity handles, URLs, or
 * anything else that'd read back as junk in the other tables.
 */
export function assertSteam64(value: string): void {
  if (!STEAM64_RE.test(value)) {
    throw new Error(
      `Expected a 17-digit Steam64 ID, got ${JSON.stringify(value)}. ` +
        "Call resolveSteamId() before handing the value to the store.",
    );
  }
}
