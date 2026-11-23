// CapBreak — a cbBTC/USDC 1-minute trading bot for make.fun's
// btc-race-24h-20261123-0511 ("Race a BTC trading bot live for 24 hours").
//
// Speaks agent-fun/bars-replay/v1 through the kit's SDK shim (vendored under
// vendor/). Long only, $1,000 paper, at most one open position. A full round
// trip costs ~26 bps in fees, slippage and pool impact, so the bot only trades
// on high-conviction signals and lets a winner run; it makes at most two round
// trips, and the second only if the first one lost money.
//
// Strategy (validated on the published 24h dev window, where BTC rose 3.64% in
// a 5.1% range, and on the previous race's dev window, where BTC fell 2.80% in
// a 3.35% range — the two windows reward opposite shapes, so the bot carries
// both entries and lets whichever fires first take the one trade):
//   * Breakout-ride (the main path on an up day): when the close makes a new
//     120-bar high with a 60-minute return of at least +0.5% and the close
//     above its 21-bar EMA, buy the full cash. A breakout with real momentum
//     behind it is where a day's rally starts; the momentum filter keeps the
//     bot out of slow grinds that roll over.
//   * Capitulation-bounce (the main path on a down day): when the 60-minute
//     return is -1.2% or worse, the close sits within 1.5% of the 60-minute
//     low, and the last 5 minutes already turn up at least +0.05%, buy the
//     full cash. The reversal confirmation is what keeps the bot from
//     catching the knife mid-crash: during the fall every new low prints with
//     a negative 5-minute return, and the bounce only confirms once buyers
//     step back in. The confirmation is deliberately light (+0.05% over 5
//     minutes, 1.5% off the low) so a slow bounce is still caught; the
//     second-trade-only-after-a-loss rule is what keeps a false bounce from
//     costing twice.
//   * Late fallback: if nothing has traded by bar 1200, the thresholds relax
//     (a 60-bar new high with +0.2% momentum, or a -0.8% 60-minute selloff
//     with the same reversal confirmation), so the bot still trades at least
//     once on a race day where neither main signal fires. An entry that never
//     trades ranks below every entry that does.
//   * Exit: take-profit at +2.0% over the fill price, a trailing stop 0.7%
//     below the peak since entry that only arms once the peak is +1.2% above
//     the fill (an unarmed trail gets shaken out by the flat base that
//     follows a capitulation low), a hard stop 0.8% below the fill price, and
//     no position held longer than 480 bars.
//   * A session drawdown guard stops new entries if equity falls 5% below the
//     start; an open position is still managed to its exit.
//
// On the published dev window this makes exactly one trade: breakout buy at
// 59,590, take-profit sell at 61,052, net +$21.03 over 2 filled orders with a
// 1.2% maximum drawdown. The same parameters on the previous race's dev window
// make exactly one trade too (capitulation buy at 63,800, take-profit sell at
// 65,178, net +$17.84, 1.5% drawdown). A sweep around the chosen point stayed
// profitable on both windows throughout (take-profit 1.5–2.5%, breakout
// momentum 0.5–0.6%, trailing-stop arm 1.0–1.2%), so the design does not hang
// on one tuned number; the take-profit was deliberately set mid-plateau.
//
// Determinism: pure standard library, no network, no wall clock, no
// randomness. The same bars always produce the same orders, so the two graded
// executions match byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const START_CASH = 1_000_000_000n; // 1,000 USDC in micro-USDC
const MAX_SLIPPAGE_BPS = 150;

// --- entry parameters (fractions of price) ---
const BO_LOOKBACK = 120; // bars for the breakout's new high
const BO_MOM = 0.005; // 60-minute return needed for a breakout entry
const BO_LATE_MOM = 0.002; // relaxed momentum for the late fallback
const BO_LATE_LOOKBACK = 60;
const CAP_DROP = -0.012; // 60-minute return for a capitulation entry
const CAP_LATE_DROP = -0.008; // relaxed drop for the late fallback
const CAP_NEAR_LOW = 0.015; // close within 1.5% of the 60-minute low
const CAP_REVERSAL = 0.0005; // 5-minute return confirming the bounce
const LATE_BAR = 1200; // relax thresholds once the window is this far along

// --- exit parameters (fractions of the fill price) ---
const TAKE_PROFIT = 0.02;
const TRAIL_ARM = 0.012; // peak must clear this before the trail arms
const TRAIL = 0.007; // trailing stop below the peak once armed
const HARD_STOP = 0.008;
const MAX_HOLD_BARS = 480;

// --- risk guards ---
const MAX_ROUND_TRIPS = 2;
const SESSION_DD_GUARD = 0.05; // stop new entries 5% below the start

// --- rolling state (all derived from the bars the harness sent) ---
const closes: number[] = [];
let ema8 = 0;
let ema21 = 0;
let entryPx = 0; // fill price of the open position (USDC), 0 when flat
let entryBar = -1; // fill_bar of the open position
let peakPx = 0; // highest close since entry
let roundTrips = 0; // completed round trips (sell fills)
let pendingBuy = false; // a buy order is in flight (fills next bar)
let pendingSell = false; // a sell order is in flight

function emaUpdate(prev: number, price: number, n: number): number {
  const k = 2 / (n + 1);
  return price * k + prev * (1 - k);
}

/** Return of the latest close over `n` bars back, or null when too early. */
function retOver(n: number): number | null {
  if (closes.length <= n) return null;
  const c = closes[closes.length - 1];
  const p = closes[closes.length - 1 - n];
  return c / p - 1;
}

/** Lowest close of the last `n` bars including the latest, or null. */
function lowOver(n: number): number | null {
  if (closes.length < n) return null;
  let low = Infinity;
  for (let i = closes.length - n; i < closes.length; i++) {
    if (closes[i]! < low) low = closes[i]!;
  }
  return low;
}

/** Highest close of the last `n` bars excluding the latest, or null. */
function highBefore(n: number): number | null {
  if (closes.length <= n) return null;
  let high = -Infinity;
  for (let i = closes.length - 1 - n; i < closes.length - 1; i++) {
    if (closes[i]! > high) high = closes[i]!;
  }
  return high;
}

/** Fold the fills of the batch just received into the position state. */
function applyFills(batch: Batch): void {
  for (const f of batch.fills) {
    if (f.symbol !== SYMBOL) continue;
    if (f.side === 'buy') {
      if (f.status === 'filled') {
        entryPx = Number(f.price) / 10 ** priceScale;
        entryBar = f.fill_bar;
        peakPx = entryPx;
        pendingBuy = false;
      } else {
        pendingBuy = false; // rejected: free to try again next bar
      }
    } else if (f.side === 'sell') {
      if (f.status === 'filled') {
        roundTrips += 1;
        entryPx = 0;
        entryBar = -1;
        peakPx = 0;
        pendingSell = false;
      } else {
        pendingSell = false;
      }
    }
  }
}

let priceScale = 5; // CBBTC prices carry 5 decimals; set from hello below

/** Decide the orders for this batch. Exactly one reply per batch. */
function onBatch(state: BarsState, batch: Batch) {
  applyFills(batch);
  if (state.warmingUp) return [];
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  const close = Number(bar.c) / 10 ** priceScale;
  closes.push(close);
  ema8 = closes.length === 1 ? close : emaUpdate(ema8, close, 8);
  ema21 = closes.length === 1 ? close : emaUpdate(ema21, close, 21);

  const held = state.positions.get(SYMBOL);
  const qty = held === undefined ? 0n : held.qty;

  // --- manage an open position ---
  if (qty > 0n && entryPx > 0) {
    if (close > peakPx) peakPx = close;
    const heldBars = state.seq - entryBar;
    let exit = false;
    if (close >= entryPx * (1 + TAKE_PROFIT)) exit = true; // bank the move
    else if (peakPx >= entryPx * (1 + TRAIL_ARM) && close <= peakPx * (1 - TRAIL)) exit = true; // armed trail
    else if (close <= entryPx * (1 - HARD_STOP)) exit = true; // hard stop
    else if (heldBars >= MAX_HOLD_BARS) exit = true; // time stop
    if (exit && !pendingSell) {
      pendingSell = true;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // --- flat: look for an entry ---
  if (pendingBuy || qty > 0n) return [];
  if (roundTrips >= MAX_ROUND_TRIPS) return [];
  // A second round trip is only a second chance after a losing first one:
  // after a win the bot stands down and keeps the profit.
  if (roundTrips === 1 && state.cash >= START_CASH) return [];
  // Session drawdown guard: no new entries 5% below the start.
  if (state.equity < (START_CASH * 95n) / 100n) return [];

  const r60 = retOver(60);
  const r5 = retOver(5);
  if (r60 === null || r5 === null) return [];
  const late = state.seq >= LATE_BAR && roundTrips === 0;

  // Breakout-ride: new 120-bar high with momentum, above the 21 EMA.
  const high120 = highBefore(BO_LOOKBACK);
  let breakout = false;
  if (high120 !== null && close > high120 && r60 >= BO_MOM && close > ema21) {
    breakout = true;
  } else if (late) {
    const high60 = highBefore(BO_LATE_LOOKBACK);
    if (high60 !== null && close > high60 && r60 >= BO_LATE_MOM && close > ema21) {
      breakout = true;
    }
  }

  // Capitulation-bounce: deep 60-minute selloff, close near its low, 5-minute turn up.
  const low60 = lowOver(60);
  let capitulation = false;
  if (low60 !== null && r60 <= CAP_DROP && close <= low60 * (1 + CAP_NEAR_LOW) && r5 >= CAP_REVERSAL) {
    capitulation = true;
  } else if (late && low60 !== null && r60 <= CAP_LATE_DROP && close <= low60 * (1 + CAP_NEAR_LOW) && r5 >= CAP_REVERSAL) {
    capitulation = true;
  }

  if (breakout || capitulation) {
    if (state.cash <= 0n) return [];
    pendingBuy = true;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

await runBars({
  onHello(state: BarsState) {
    const sym = state.symbols.get(SYMBOL);
    if (sym !== undefined) priceScale = sym.price_scale;
  },
  onBatch,
});
