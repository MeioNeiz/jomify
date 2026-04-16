import type { LeetifyPlayerStats } from "./leetify/types.js";

const BASELINES: Record<string, { mean: number; std: number }> = {
  accuracy_head: { mean: 0.35, std: 0.1 },
  accuracy_enemy_spotted: { mean: 0.25, std: 0.07 },
  spray_accuracy: { mean: 0.25, std: 0.08 },
  reaction_time: { mean: 0.4, std: 0.12 },
  kd_ratio: { mean: 1.0, std: 0.3 },
  dpr: { mean: 75, std: 12 },
};

function mean(vals: number[]): number {
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function std(vals: number[], avg: number): number {
  return Math.sqrt(vals.reduce((s, v) => s + (v - avg) ** 2, 0) / vals.length);
}

function cv(vals: number[]): number {
  const avg = mean(vals);
  return avg === 0 ? 0 : std(vals, avg) / Math.abs(avg);
}

function zScore(playerAvg: number, key: string): number {
  const b = BASELINES[key];
  if (!b || b.std === 0) return 0;
  return (playerAvg - b.mean) / b.std;
}

function fmt(val: number | null | undefined, d = 1): string {
  return val != null ? val.toFixed(d) : "N/A";
}

export interface Check {
  name: string;
  value: string;
  z: number;
  flagged: boolean;
}

export interface AnalysisResult {
  checks: Check[];
  score: number;
}

export const SUSPECT_THRESHOLD = 4;

/** Analyse an array of per-match stats for suspicious patterns. */
export function analyseStats(stats: LeetifyPlayerStats[]): AnalysisResult {
  const n = stats.length;
  const checks: Check[] = [];
  let totalScore = 0;

  const hsVals = stats.map((p) => p.accuracy_head);
  const hsAvg = mean(hsVals);
  const hsZ = zScore(hsAvg, "accuracy_head");
  const hsCv = cv(hsVals);
  if (hsZ > 2) totalScore += hsZ;
  checks.push({
    name: "Headshot %",
    value: `${fmt(hsAvg * 100)}% (z=${fmt(hsZ, 1)})`,
    z: hsZ,
    flagged: hsZ > 2,
  });

  const accVals = stats.map((p) => p.accuracy_enemy_spotted);
  const accAvg = mean(accVals);
  const accZ = zScore(accAvg, "accuracy_enemy_spotted");
  if (accZ > 2) totalScore += accZ;
  checks.push({
    name: "Accuracy (spotted)",
    value: `${fmt(accAvg * 100)}% (z=${fmt(accZ, 1)})`,
    z: accZ,
    flagged: accZ > 2,
  });

  const rtVals = stats.map((p) => p.reaction_time);
  const rtAvg = mean(rtVals);
  const rtZ = -zScore(rtAvg, "reaction_time");
  if (rtZ > 2) totalScore += rtZ;
  checks.push({
    name: "Reaction time",
    value: `${fmt(rtAvg * 1000, 0)}ms (z=${fmt(rtZ, 1)})`,
    z: rtZ,
    flagged: rtZ > 2,
  });

  const kdVals = stats.map((p) => p.kd_ratio);
  const kdAvg = mean(kdVals);
  const kdZ = zScore(kdAvg, "kd_ratio");
  if (kdZ > 2.5) totalScore += kdZ;
  checks.push({
    name: "KD ratio",
    value: `${fmt(kdAvg, 2)} (z=${fmt(kdZ, 1)})`,
    z: kdZ,
    flagged: kdZ > 2.5,
  });

  const dprVals = stats.map((p) => p.dpr);
  const dprAvg = mean(dprVals);
  const dprZ = zScore(dprAvg, "dpr");
  if (dprZ > 2.5) totalScore += dprZ;
  checks.push({
    name: "Damage/round",
    value: `${fmt(dprAvg, 0)} (z=${fmt(dprZ, 1)})`,
    z: dprZ,
    flagged: dprZ > 2.5,
  });

  const consistencyFlag = hsCv < 0.1 && n >= 10;
  if (consistencyFlag) totalScore += 3;
  checks.push({
    name: "HS consistency",
    value: `CV=${fmt(hsCv, 2)}${consistencyFlag ? " (inhuman)" : ""}`,
    z: consistencyFlag ? 3 : 0,
    flagged: consistencyFlag,
  });

  const totalRounds = stats.reduce((s, p) => s + p.rounds_count, 0);
  const total4k5k = stats.reduce((s, p) => s + p.multi4k + p.multi5k, 0);
  const multiRate = totalRounds > 0 ? total4k5k / totalRounds : 0;
  const multiFlag = multiRate > 0.04 && total4k5k >= 3;
  if (multiFlag) totalScore += 2.5;
  checks.push({
    name: "4k/5k rate",
    value: `${total4k5k}/${totalRounds}rd (${fmt(multiRate * 100, 2)}%)`,
    z: multiFlag ? 2.5 : 0,
    flagged: multiFlag,
  });

  return { checks, score: totalScore };
}

/** Quick single-match analysis from raw stats. */
export function quickScan(stats: LeetifyPlayerStats): number {
  return analyseStats([stats]).score;
}
