// Low-bounce scalper + one slope trade: a selective long-only bot for
// CBBTC 1-minute bars.
//
// The dev window is a -491 bps down day: slow trend bots lose on every
// whipsaw (the old EMA(60) slope rider: -$23.01 here) while the only real
// money is the one sharp V-bounce (+174 bps in 60 min off the session low).
// So this bot trades almost nothing: it waits for a bounce off a fresh low
// and rides it with a trailing stop.
//
//   - Entry A (flat only): the close is within 60 bps above the rolling
//     240-minute low AND the 5-minute return is at least +50 bps, i.e. a
//     sharp jump that starts at the low. On the dev window this fires once
//     (bar 411, $68,359) and catches the whole bounce to $69,097 (+$10.00).
//   - Entry B (flat only, at most once a day): the EMA(60) slope over
//     20 bars is above 15 bps AND the close is above the EMA. This is the
//     old slope rider's signal, kept for days that trend up from the open
//     instead of bouncing: on the previous race's dev window it catches the
//     early uptrend (+$3.93). One shot only, because every later slope
//     signal on a choppy day is a whipsaw.
//   - Exit (holding only): trailing stop 40 bps below the running peak
//     value, take-profit +120 bps over cost, hard stop -75 bps, max hold
//     90 bars. A 45-bar cooldown after any exit keeps the bot from
//     re-entering the top of the move it just sold.
//   - No trade in the first 240 bars (low still seeding), no orders while
//     warming up, no shorts, no leverage, no clock, no randomness.
//
// Validated on two published dev windows (exact local grader, two runs,
// byte-identical action logs): this window +$9.95 (2 round trips), the
// previous race's window +$3.93 (1 round trip). The S1 leg alone makes
// +$10.00 here but never trades there, which would fail the race's
// 1-trade guardrail on an uptrend day; the slope leg alone makes +$4.28
// there but -$23.01 here. Together, each leg covers the other's day type.
//
// Ported from an identical Python version validated bar-for-bar against the
// kit's local grader (same fills, same PnL to the micro-USDC).

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOW_WINDOW = 240;
const LOW_MAX_ABOVE_BPS = 60;
const REC_LOOKBACK = 5;
const REC_MIN_BPS = 50;
const EMA_SPAN = 60;
const SLOPE_BARS = 20;
const SLOPE_MIN_BPS = 15;
const TRAIL_BPS = 40;
const TAKE_PROFIT_BPS = 120;
const STOP_LOSS_BPS = 75;
const MAX_HOLD_BARS = 90;
const COOLDOWN_BARS = 45;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
class Ema {
  span: number;
  warm: number[] = [];
  value: number | null = null;
  constructor(span: number) {
    this.span = span;
  }
  step(close: number): number | null {
    if (this.value !== null) {
      this.value += (2 / (this.span + 1)) * (close - this.value);
      return this.value;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      this.value = this.warm.reduce((a, x) => a + x, 0) / this.span;
    }
    return this.value;
  }
}

const ema = new Ema(EMA_SPAN);
const emaHist: (number | null)[] = []; // EMA value per close index (null before seeded)
const closes: number[] = []; // non-null closes, in order
let peak: bigint | null = null; // running peak held value since entry
let entryIdx: number | null = null; // closes-index of the buy decision
let lastExitIdx = -1000000; // closes-index of the last sell decision
let slopeTrades = 0; // slope-leg entries taken (at most one a day)

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return []; // gap bar: no new information
    const close = Number(closeBig);
    const idx = closes.length;
    closes.push(close);
    if (close !== null) ema.step(close);
    emaHist.push(ema.value);
    if (state.warmingUp) return [];

    const pos = state.positions.get(SYMBOL);
    if (pos === undefined) {
      if (idx - lastExitIdx < COOLDOWN_BARS) return [];
      if (
        idx >= LOW_WINDOW &&
        idx >= REC_LOOKBACK &&
        close <=
          Math.min(...closes.slice(idx - LOW_WINDOW + 1, idx + 1)) *
            (1 + LOW_MAX_ABOVE_BPS / 10000) &&
        (close / closes[idx - REC_LOOKBACK] - 1) * 10000 >= REC_MIN_BPS
      ) {
        const notional = state.cash;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          peak = null;
          entryIdx = idx;
          return [{
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: notional,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          }];
        }
      }
      if (
        slopeTrades < 1 &&
        idx >= SLOPE_BARS &&
        emaHist[idx] !== null &&
        emaHist[idx - SLOPE_BARS] !== null &&
        (emaHist[idx]! / emaHist[idx - SLOPE_BARS]! - 1) * 10000 > SLOPE_MIN_BPS &&
        close > emaHist[idx]!
      ) {
        const notional = state.cash;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          peak = null;
          entryIdx = idx;
          slopeTrades += 1;
          return [{
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: notional,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          }];
        }
      }
      return [];
    }

    // Holding: trailing stop / take-profit / hard stop / max hold.
    const heldValue = state.value(SYMBOL, pos.qty);
    if (peak === null || heldValue > peak) peak = heldValue;
    const cost = pos.cost;
    const sell: OrderInput = {
      side: 'sell',
      symbol: SYMBOL,
      qty: pos.qty,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
    if (heldValue < (cost * BigInt(10000 - STOP_LOSS_BPS)) / 10000n) {
      lastExitIdx = idx;
      return [sell];
    }
    if (heldValue > (cost * BigInt(10000 + TAKE_PROFIT_BPS)) / 10000n) {
      lastExitIdx = idx;
      return [sell];
    }
    if (entryIdx !== null && idx - entryIdx >= MAX_HOLD_BARS) {
      lastExitIdx = idx;
      return [sell];
    }
    if (peak !== null && heldValue <= (peak * BigInt(10000 - TRAIL_BPS)) / 10000n) {
      lastExitIdx = idx;
      return [sell];
    }
    return [];
  },
});
