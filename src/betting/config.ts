// Starting wallet on first interaction. Grants via ensureAccount land
// one 'starting-grant' row on the ledger so balance = sum(ledger).
export const STARTING_BALANCE = 5;

// Live match grant, applied by the cs:match-completed listener.
//
// Net formula (integer credits, may go negative on a true grief match):
//   grant = BASE
//         + PER_TEAMMATE * trackedTeammates
//         + (win ? WIN_BONUS : 0)
//         - (teamFlashes >= TEAM_FLASH_THRESHOLD ? PENALTY_TEAM_FLASH : 0)
//         - (heFriendsDmgAvg >= HE_FRIENDS_THRESHOLD ? PENALTY_HE_FRIENDS : 0)
//         - (shotsHitFriendHead >= TEAMKILL_THRESHOLD ? PENALTY_TEAMKILL : 0)
//         - (rating <= BAD_GAME_RATING ? PENALTY_BAD_GAME : 0)
//         - (lossStreak >= LOSS_STREAK_THRESHOLD ? PENALTY_LOSS_STREAK : 0)
//
// Provisional defaults — tune once we see a week of real numbers. The
// goal is for a casual solo player to accumulate a few credits a day,
// a four-stack win to pay out noticeably more, and a genuine grief
// match to actually cost credits rather than just grant fewer.
export const MATCH_GRANT_BASE = 1;
export const MATCH_GRANT_PER_TEAMMATE = 1;
export const MATCH_GRANT_WIN_BONUS = 1;

// Penalty thresholds — chosen generously so a fluke doesn't sting and
// only real grief bites. Tune from real data once we see some.
export const PENALTY_TEAM_FLASH_THRESHOLD = 2;
export const PENALTY_TEAM_FLASH = 1;
export const PENALTY_HE_FRIENDS_THRESHOLD = 50;
export const PENALTY_HE_FRIENDS = 1;
export const PENALTY_TEAMKILL_THRESHOLD = 1;
export const PENALTY_TEAMKILL = 2;
// Mirrors CS's BAD_GAME_RATING in src/cs/watcher.ts. Duplicated here so
// betting doesn't reach into CS's config — the tradeoff is that if CS
// ever retunes its bad-game band, betting needs to track.
export const BAD_GAME_RATING = -0.05;
export const PENALTY_BAD_GAME = 1;
export const PENALTY_LOSS_STREAK_THRESHOLD = 3;
export const PENALTY_LOSS_STREAK = 1;

// How many ranks get archived into weekly_wins at each reset. Covers
// the Monday post (top 3) + a little headroom for histogram queries
// later.
export const WEEKLY_ARCHIVE_RANKS = 5;

// Cost to open a dispute on a resolved market. Deducted from the
// opener's wallet on Report submit. Refunded in full if the dispute
// is upheld (flip-yes / flip-no / cancel rulings); forfeit on "keep"
// so drive-by reports still cost something.
export const DISPUTE_COST = 5;

// LMSR market parameters.
//
// LMSR_RAKE is deducted from winning shares at resolution (e.g. 0.02 = 2%).
// Under the creator-LP model this falls out as the creator's trading
// profit on balanced markets rather than house revenue.
//
// DEFAULT_EXPIRY_HOURS: markets auto-cancel after this long if not manually
// resolved. Keeps the market list tidy; creators can override at creation.
export const LMSR_RAKE = 0.02;
export const DEFAULT_EXPIRY_HOURS = 72;

// Creator-as-LP stake. Escrowed from the creator's balance at
// createBet; `b = stake / ln 2` guarantees max creator loss == stake.
// Stake is a plain integer — no tiers. Per-trader bonus rewards
// engagement (not notional), paid from the protocol reserve at
// settlement, capped at TRADER_BONUS_CAP traders.
export const TRADER_BONUS_CAP = 50;

// Smallest stake allowed — keeps tiny markets honest (b ≈ 7.2 at 5).
export const MIN_CREATOR_STAKE = 5;

// Default when the user doesn't pick an explicit stake.
export const DEFAULT_CREATOR_STAKE = MIN_CREATOR_STAKE;

// Challenge markets gatekeep with a higher floor — the challenge
// itself is the market, so the stake needs to mean something.
export const CHALLENGE_MIN_STAKE = 20;

/** LMSR liquidity depth derived from the creator's stake (max loss == stake). */
export function bFromStake(stake: number): number {
  return stake / Math.LN2;
}

/**
 * Per-trader engagement bonus paid from protocol reserve at settlement.
 * Super-linear in practice via the LMSR side (bigger stake → deeper
 * book → more volume → more rake) — this bonus just adds a flat 5% of
 * stake per unique trader, capped at TRADER_BONUS_CAP.
 */
export function perTraderBonus(stake: number): number {
  return stake * 0.05;
}

// Auto-extend: when a wager lands within AUTO_EXTEND_THRESHOLD_HOURS of
// the deadline, push it forward by AUTO_EXTEND_ON_BET_HOURS from now.
// Only fires on markets that already have an expiry set.
export const AUTO_EXTEND_THRESHOLD_HOURS = 12;
export const AUTO_EXTEND_ON_BET_HOURS = 24;
