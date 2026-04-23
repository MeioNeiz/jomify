#!/usr/bin/env bun
// Analyse theoretical match-grant drops vs. what actually landed on the
// ledger. Useful for tuning the formula in src/betting/config.ts once we
// have real data — e.g. checking whether 20k+ players are quietly
// farming credits because wins are still trivially cheap up there, or
// whether low-Premier players are getting griefed too often.
//
// Replays the cs:match-completed grant formula over every stored match
// in the last N days (default 30), buckets by post-match Premier tier,
// and prints per-tier descriptive stats + histograms. The "actual"
// figure is pulled from the betting ledger (reason='match') — the gap
// between theoretical and actual is almost entirely tracked-but-unlinked
// Steam accounts (no Discord wallet to credit).
//
// Caveat: heFriendsDamageAvg and shotsHitFriendHead penalties require
// fields only present in match_stats.raw JSON. Older rows may have been
// written with just the rating scalar stored in `raw` (pre-save-full-
// JSON refactor), in which case those two penalties silently score zero
// and a warning prints up-front. Loss streaks are reconstructed from
// ordered match_stats rows in this window, so a streak that started
// before the window is undercounted in its early matches.
//
// Usage: bun scripts/analyse-cs-drops.ts [--days <n>]
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  BAD_GAME_RATING,
  MATCH_GRANT_BASE,
  MATCH_GRANT_PER_TEAMMATE,
  MATCH_GRANT_WIN_BONUS,
  PENALTY_BAD_GAME,
  PENALTY_HE_FRIENDS,
  PENALTY_HE_FRIENDS_THRESHOLD,
  PENALTY_LOSS_STREAK,
  PENALTY_LOSS_STREAK_THRESHOLD,
  PENALTY_TEAM_FLASH,
  PENALTY_TEAM_FLASH_THRESHOLD,
  PENALTY_TEAMKILL,
  PENALTY_TEAMKILL_THRESHOLD,
} from "../src/betting/config.js";

const argv = process.argv.slice(2);
let days = 30;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--days") {
    const n = Number(argv[++i]);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("--days must be a positive number");
      process.exit(1);
    }
    days = n;
  } else if (a === "-h" || a === "--help") {
    console.error("Usage: bun scripts/analyse-cs-drops.ts [--days <n>]");
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}`);
    process.exit(1);
  }
}

const ROOT = join(import.meta.dir, "..");
const csDb = new Database(join(ROOT, "jomify-cs.db"), { readonly: true });
const betDb = new Database(join(ROOT, "jomify-betting.db"), { readonly: true });

const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

type Row = {
  match_id: string;
  steam_id: string;
  finished_at: string;
  team_number: number | null;
  team1_score: number | null;
  team2_score: number | null;
  leetify_rating: number | null;
  premier_after: number | null;
  flashbang_hit_friend: number | null;
  he_friends: number | null;
  shots_hit_friend_head: number | null;
};

// JSON_EXTRACT returns null when the key is missing (older rows store
// just a scalar rating in `raw`). Coalescing to 0 there is fine — the
// threshold comparisons will simply never fire. We warn separately.
const rows = csDb
  .query<Row, [string]>(
    `SELECT ms.match_id, ms.steam_id, m.finished_at,
            ms.team_number, m.team1_score, m.team2_score,
            ms.leetify_rating, ms.premier_after,
            ms.flashbang_hit_friend,
            CAST(json_extract(ms.raw, '$.he_friends_damage_avg') AS REAL) AS he_friends,
            CAST(json_extract(ms.raw, '$.shots_hit_friend_head') AS INTEGER)
              AS shots_hit_friend_head
       FROM match_stats ms
       JOIN matches m ON m.match_id = ms.match_id
       WHERE m.finished_at >= ?
       ORDER BY m.finished_at ASC`,
  )
  .all(sinceIso);

if (rows.length === 0) {
  console.log(`No matches in the last ${days} day(s) since ${sinceIso}.`);
  process.exit(0);
}

const heMissing = rows.filter((r) => r.he_friends === null).length;
const tkMissing = rows.filter((r) => r.shots_hit_friend_head === null).length;
if (heMissing || tkMissing) {
  console.warn(
    `warning: ${heMissing}/${rows.length} rows missing he_friends_damage_avg,`,
    `${tkMissing}/${rows.length} missing shots_hit_friend_head — those`,
    "penalties scored as zero for affected rows (legacy raw shape).",
  );
}

const trackedSet = new Set(
  csDb
    .query<{ steam_id: string }, []>("SELECT DISTINCT steam_id FROM tracked_players")
    .all()
    .map((r) => r.steam_id),
);

// Group by match for teammate lookup: players on the same team_number.
const byMatch = new Map<string, Row[]>();
for (const r of rows) {
  const arr = byMatch.get(r.match_id);
  if (arr) arr.push(r);
  else byMatch.set(r.match_id, [r]);
}

function outcomeFor(r: Row): "win" | "loss" | "tie" | "unknown" {
  if (r.team1_score == null || r.team2_score == null || r.team_number == null) {
    return "unknown";
  }
  if (r.team1_score === r.team2_score) return "tie";
  // team_number 2 → t1 side, team_number 3 → t2 side (convention used
  // throughout the CS store — see src/cs/store/maps.ts).
  const won =
    (r.team_number === 2 && r.team1_score > r.team2_score) ||
    (r.team_number === 3 && r.team2_score > r.team1_score);
  return won ? "win" : "loss";
}

function trackedTeammatesFor(r: Row): number {
  const others = byMatch.get(r.match_id) ?? [];
  let n = 0;
  for (const o of others) {
    if (o.steam_id === r.steam_id) continue;
    if (o.team_number !== r.team_number) continue;
    if (trackedSet.has(o.steam_id)) n++;
  }
  return n;
}

// Reconstruct loss streaks from the window. Rows are already sorted by
// finished_at ASC. Streaks that predate the window start fresh at 0 —
// noted in the header comment.
const streakState = new Map<string, { type: "win" | "loss" | "tie"; count: number }>();

type Computed = {
  steamId: string;
  matchId: string;
  grant: number;
  tier: string;
  hits: {
    win: boolean;
    teamFlash: boolean;
    heFriends: boolean;
    teamkill: boolean;
    badGame: boolean;
    lossStreak: boolean;
  };
};

function tierOf(premier: number | null): string {
  if (premier == null) return "unranked";
  if (premier < 5000) return "<5k";
  if (premier < 10000) return "5-10k";
  if (premier < 15000) return "10-15k";
  if (premier < 20000) return "15-20k";
  return "20k+";
}

const computed: Computed[] = [];
for (const r of rows) {
  const outcome = outcomeFor(r);
  if (outcome === "unknown") continue;

  const prev = streakState.get(r.steam_id);
  const nextCount = prev && prev.type === outcome ? prev.count + 1 : 1;
  streakState.set(r.steam_id, { type: outcome, count: nextCount });

  const teammates = trackedTeammatesFor(r);
  const rating = r.leetify_rating ?? 0;

  let grant = MATCH_GRANT_BASE + MATCH_GRANT_PER_TEAMMATE * teammates;
  const win = outcome === "win";
  if (win) grant += MATCH_GRANT_WIN_BONUS;

  const teamFlash = (r.flashbang_hit_friend ?? 0) >= PENALTY_TEAM_FLASH_THRESHOLD;
  if (teamFlash) grant -= PENALTY_TEAM_FLASH;

  const heFriends = (r.he_friends ?? 0) >= PENALTY_HE_FRIENDS_THRESHOLD;
  if (heFriends) grant -= PENALTY_HE_FRIENDS;

  const teamkill = (r.shots_hit_friend_head ?? 0) >= PENALTY_TEAMKILL_THRESHOLD;
  if (teamkill) grant -= PENALTY_TEAMKILL;

  const badGame = rating <= BAD_GAME_RATING;
  if (badGame) grant -= PENALTY_BAD_GAME;

  const lossStreak = outcome === "loss" && nextCount >= PENALTY_LOSS_STREAK_THRESHOLD;
  if (lossStreak) grant -= PENALTY_LOSS_STREAK;

  computed.push({
    steamId: r.steam_id,
    matchId: r.match_id,
    grant,
    tier: tierOf(r.premier_after),
    hits: { win, teamFlash, heFriends, teamkill, badGame, lossStreak },
  });
}

if (computed.length === 0) {
  console.log("No matches with derivable outcome in window.");
  process.exit(0);
}

const TIER_ORDER = ["<5k", "5-10k", "10-15k", "15-20k", "20k+", "unranked"];

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function stddev(nums: number[], mean: number): number {
  if (nums.length < 2) return 0;
  const v = nums.reduce((a, x) => a + (x - mean) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

function pct(hits: number, n: number): string {
  return n === 0 ? "—" : `${((hits / n) * 100).toFixed(1)}%`;
}

function histogram(nums: number[]): string {
  if (!nums.length) return "";
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const buckets = new Map<number, number>();
  for (const n of nums) buckets.set(n, (buckets.get(n) ?? 0) + 1);
  const max = Math.max(...buckets.values());
  const width = 30;
  const lines: string[] = [];
  for (let v = lo; v <= hi; v++) {
    const c = buckets.get(v) ?? 0;
    const bar = "#".repeat(Math.round((c / max) * width));
    lines.push(`    ${String(v).padStart(3)} | ${bar} ${c}`);
  }
  return lines.join("\n");
}

console.log(
  `\nWindow: last ${days} day(s) (since ${sinceIso})\n` +
    `Rows analysed: ${computed.length} (of ${rows.length} raw)\n`,
);

const header =
  "tier      n     mean  median  stddev   min  max   flash%   he%   tk%   bad%  lstreak%  win%";
console.log(header);
console.log("-".repeat(header.length));

const byTier = new Map<string, Computed[]>();
for (const c of computed) {
  const arr = byTier.get(c.tier);
  if (arr) arr.push(c);
  else byTier.set(c.tier, [c]);
}

for (const tier of TIER_ORDER) {
  const group = byTier.get(tier);
  if (!group?.length) continue;
  const grants = group.map((g) => g.grant);
  const mean = grants.reduce((a, b) => a + b, 0) / grants.length;
  const med = median(grants);
  const sd = stddev(grants, mean);
  const lo = Math.min(...grants);
  const hi = Math.max(...grants);
  const n = group.length;
  const flashP = pct(group.filter((g) => g.hits.teamFlash).length, n);
  const heP = pct(group.filter((g) => g.hits.heFriends).length, n);
  const tkP = pct(group.filter((g) => g.hits.teamkill).length, n);
  const badP = pct(group.filter((g) => g.hits.badGame).length, n);
  const lstP = pct(group.filter((g) => g.hits.lossStreak).length, n);
  const winP = pct(group.filter((g) => g.hits.win).length, n);
  console.log(
    [
      tier.padEnd(8),
      String(n).padStart(5),
      mean.toFixed(2).padStart(7),
      med.toFixed(2).padStart(7),
      sd.toFixed(2).padStart(7),
      String(lo).padStart(5),
      String(hi).padStart(4),
      flashP.padStart(7),
      heP.padStart(6),
      tkP.padStart(6),
      badP.padStart(6),
      lstP.padStart(8),
      winP.padStart(6),
    ].join("  "),
  );
}

console.log("\nPer-tier histograms:");
for (const tier of TIER_ORDER) {
  const group = byTier.get(tier);
  if (!group?.length) continue;
  console.log(`\n  ${tier} (n=${group.length}):`);
  console.log(histogram(group.map((g) => g.grant)));
}

const theoretical = computed.reduce((a, c) => a + c.grant, 0);
const actualRow = betDb
  .query<{ s: number | null }, [string]>(
    "SELECT SUM(delta) AS s FROM ledger WHERE reason = 'match' AND at >= ?",
  )
  .get(sinceIso);
const actual = actualRow?.s ?? 0;

console.log("\nGlobal summary:");
console.log(`  Theoretical total : ${theoretical}`);
console.log(`  Actual (ledger)   : ${actual}`);
console.log(
  `  Gap (unlinked)    : ${theoretical - actual}` +
    " (tracked Steam IDs with no Discord wallet)",
);
