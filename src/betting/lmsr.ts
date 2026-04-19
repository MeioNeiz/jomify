// LMSR (Logarithmic Market Scoring Rule) for binary YES/NO markets.
//
// The market maker's maximum loss per market is bounded at b × ln(2) ≈ 0.693b
// shekels regardless of how participants bet — this is the key guarantee that
// makes LMSR practical as a subsidy-funded AMM.
//
// All functions are pure; the mutable state (qYes, qNo) lives in bets rows.

import type { Outcome } from "./store/bets.js";

/** Current implied YES probability given the running share counts. */
export function lmsrProb(qYes: number, qNo: number, b: number): number {
  const ey = Math.exp(qYes / b);
  const en = Math.exp(qNo / b);
  return ey / (ey + en);
}

/**
 * Shares of `outcome` received for spending `amount` shekels at the
 * current market state. Derived by solving C(q + Δ) − C(q) = amount for Δ,
 * where C(y, n) = b × ln(e^(y/b) + e^(n/b)).
 */
export function lmsrBuyShares(
  qYes: number,
  qNo: number,
  b: number,
  amount: number,
  outcome: Outcome,
): number {
  const ey = Math.exp(qYes / b);
  const en = Math.exp(qNo / b);
  const S = ey + en;
  if (outcome === "yes") {
    return b * Math.log((S * Math.exp(amount / b) - en) / ey);
  }
  return b * Math.log((S * Math.exp(amount / b) - ey) / en);
}

/**
 * Initial (qYes, qNo) share counts for a market starting at `initialProb`.
 * Sets one count to the log-odds value and the other to 0, so the lower
 * side starts at a natural baseline without inflating the absolute totals.
 *
 * At p = 0.5: both 0 (symmetric start, no pre-loaded bias).
 * At p = 0.7: qYes = b × ln(7/3) ≈ 25.4 (with b=30), qNo = 0.
 */
export function lmsrInitShares(
  initialProb: number,
  b: number,
): { qYes: number; qNo: number } {
  const logOdds = b * Math.log(initialProb / (1 - initialProb));
  return { qYes: Math.max(0, logOdds), qNo: Math.max(0, -logOdds) };
}

/** Expected payout (shekels) if `outcome` resolves, given `amount` staked now. */
export function lmsrExpectedPayout(
  qYes: number,
  qNo: number,
  b: number,
  amount: number,
  outcome: Outcome,
  rake: number,
): number {
  const shares = lmsrBuyShares(qYes, qNo, b, amount, outcome);
  return Math.floor(shares * (1 - rake));
}
