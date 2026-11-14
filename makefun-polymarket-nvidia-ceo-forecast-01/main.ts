// polymarket-nvidia-ceo-forecast-01: short-window per-market volatility
// forecaster, v2. Changes from v1: the fan is centred on the mean of the
// last two grid minutes instead of the last price alone. A single grid
// minute is a carried-forward midpoint, so averaging two minutes removes a
// little one-minute midpoint noise from the centre; on the six practice
// cases it is worth about -0.0013 of pinball loss, and it never hurts the
// volatile case by more than 0.0001.
//
// Forecast: for each market, the Yes price stays at its checkpoint centre x,
// with a spread that widens sublinearly in the horizon:
//
//   q_tau(h) = clamp(x + z_tau * sigma_i * h^0.3, 0, 1), rounded to 6 decimals
//
// where sigma_i is the market's own one-minute volatility over the trailing
// 120 minutes, shrunk 20% toward the pooled volatility across markets,
// floored at 0.0004 and capped at 0.02 price units per minute.
//
// Why: Polymarket midpoints move in steps with jumps that revert within
// minutes, so the h-step spread grows much slower than sqrt(h) (pooled
// sd/sqrt(h) falls from 0.022 at h=1 to 0.007 at h=240), and the volatility
// regime changes within hours (the wild jumps of Nov 10-11 are gone by Nov 12),
// so a short trailing window beats a long one. No drift: the last 24h drift
// is ~0.001-0.006/hour and extrapolating it hurts (practice 0.42 vs 0.27).
// The top of the dev leaderboard (0.258-0.266) uses the same family -
// adaptive per-market volatility fans, some with a sum-to-one normalisation
// or a tail-based sigma - and none of those variants beats this one on the
// practice cases: skew 0.276, OU-saturating spread 0.276-0.310, tail sigma
// 0.289, empirical quantiles 0.379, global sigma 0.327-0.364, level-aware
// sigma 0.293-0.321, sum-to-1 0.283-0.318, median/mean centres 0.28-0.40.
//
// Validation on the six practice cases (answers rebuilt from the next case's
// overlapping input, p05's from Polymarket's public price history):
//   mean pinball loss 0.2725 vs the house baseline's 0.3636 (-25%),
//   and vs v1's 0.2738. Per case: p00 0.486, p01 0.307, p02 0.358,
//   p03 0.236, p04 0.211, p05 0.105. Two runs of the Node program are
//   byte-identical, and one case's output is 172,876 bytes (< 1 MiB).
//
// The kit's starter/main.ts is the house baseline laid out as an entry. What an
// entry must do:
//   - read every <id>.in in the input directory (the grader runs one case at a
//     time, with only that case's file there), canonical JSON
//     {"schema":"makefun/polymarket-case/v1","case","at","horizon_minutes",
//     "quantiles","event","markets":[{"id","name","slug","yes_token","start",
//     "prices"}]}, where `prices` holds one Yes price per minute from `start`
//     to `at` inclusive, so the last one is the price at the checkpoint;
//   - write <id>.out to the output directory: {"forecasts":[{"id","q"}]},
//     every market of the case exactly once (no other id, no other key), `q`
//     exactly horizon_minutes rows, row h-1 the forecast for minute at+h, each
//     row one finite number in [0,1] per quantile level, non-decreasing; at
//     most 1 MiB. Anything else is an invalid case, scored as if every
//     quantile were 0.5, and an entry with an invalid case takes no prize.
// It runs offline, with no network, under the case's time cap: everything it
// knows is in the case's prices.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** Trailing minutes of one-minute changes the per-market sigma is read from. */
const WINDOW_MIN = 120;
/** The spread grows as h**ALPHA: sublinear, jumps revert within minutes. */
const ALPHA = 0.3;
/** Shrinkage of each market's sigma toward the pooled sigma across markets. */
const SHRINK = 0.2;
/** Sigma floor and cap, price units per minute. */
const SIGMA_FLOOR = 0.0004;
const SIGMA_CAP = 0.02;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** Population standard deviation of a list of numbers. */
function pstdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return Math.sqrt(variance);
}

/** Per-market sigmas: trailing-window 1-minute volatility, shrunk to pooled. */
function sigmas(markets: CaseMarket[]): Map<string, number> {
  const perMarket = new Map<string, number>();
  const pooled: number[] = [];
  for (const m of markets) {
    const p = m.prices;
    const w = p.length > WINDOW_MIN ? p.slice(p.length - WINDOW_MIN) : p;
    const diffs: number[] = [];
    for (let i = 0; i + 1 < w.length; i++) diffs.push((w[i + 1] as number) - (w[i] as number));
    perMarket.set(m.id, pstdev(diffs));
    for (const d of diffs) pooled.push(d);
  }
  const pooledSd = pstdev(pooled);
  const out = new Map<string, number>();
  for (const m of markets) {
    const s = (1 - SHRINK) * (perMarket.get(m.id) as number) + SHRINK * pooledSd;
    out.set(m.id, Math.min(SIGMA_CAP, Math.max(SIGMA_FLOOR, s)));
  }
  return out;
}

/** The centre of the fan: mean of the last two grid minutes, or the last
 *  price when a market has fewer than two minutes of history. */
function centre(m: CaseMarket): number {
  const p = m.prices;
  if (p.length === 0) throw new Error(`market ${m.id} has no prices`);
  if (p.length === 1) return p[0] as number;
  return ((p[p.length - 1] as number) + (p[p.length - 2] as number)) / 2;
}

/** The forecast of one market: horizon rows of the five quantiles around x. */
function forecast(m: CaseMarket, sigma: number, horizon: number): number[][] {
  const x = centre(m);
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const sd = sigma * Math.pow(h, ALPHA);
    rows.push(Z.map((z) => price6(x + z * sd)));
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const sig = sigmas(c.markets);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, sig.get(m.id) as number, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
