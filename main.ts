// Dip-Buy Rider: a cbBTC mean-reversion bot for the make.fun BTC race.
//
// Idea: Bitcoin's 1-minute cbBTC tape is choppy and mean-reverting on the
// hourly scale. The bot only buys after the tape has washed out, then rides
// the bounce back, and never chases a trend.
//
// Two layers, one position at a time (long only, no leverage):
//
//   BIG (capitulation): the 30-minute drop is 120 bps or worse -> buy half
//   the equity. If the washout deepens to 180 bps over 30 minutes, spend
//   the rest of the cash (second half). Exit at +250 bps or -150 bps
//   against the first entry price.
//
//   SMALL (dip): the close sits 50 bps or more below its 60-bar EMA and
//   the last bar bounced (close above previous close), while the 30-minute
//   drop is milder than 80 bps (so a small dip never blocks a BIG entry
//   forming in a waterfall) -> buy half the equity. Exit at +100 bps,
//   -100 bps, or when the close climbs back above the EMA.
//
// Everything is BigInt math on the harness's own units (closes are
// price-scale-5 ints, cash/equity are micro-USDC ints), so two runs on
// the same data decide the same orders. No clock, no network, no files,
// no randomness.

// Deliberately NO post-exit cooldown: a 30-bar cooldown was tried and
// rejected — on the dev window it blocked a profitable re-entry and
// turned +$16.49 into -$6.41. Exits already require a fresh signal to
// re-enter, which is the real guard against re-buying a falling knife.
import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const SLIP_BPS = 300;

const EMA_N = 60n; // bars in the mean the SMALL layer fades
const DROP_MIN = 30; // minutes in the capitulation window
const BIG_DROP_1_BPS = 120n; // tier-1 capitulation: buy half
const BIG_DROP_2_BPS = 180n; // tier-2 capitulation: spend the rest
const BIG_TP_BPS = 250n;
const BIG_SL_BPS = 150n;
const SMALL_DIP_BPS = 50n;
const SMALL_TP_BPS = 100n;
const SMALL_SL_BPS = 100n;
const SMALL_MAX_DROP_BPS = 80n; // never take a small dip inside a waterfall

const BPS = 10_000n;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in micro-USDC
const FP = 1_000_000n; // fixed-point scale for the EMA

type Mode = "big" | "small" | null;

class DipBuyRider {
  closes: bigint[] = [];
  emaFp: bigint | null = null; // EMA60, fixed point
  mode: Mode = null;
  tier = 0; // big layer: 1 after first buy, 2 after top-up
  entry: bigint | null = null; // first entry close (price-scale-5 int)

  // Reconcile our mode with what the account actually holds. A buy can
  // be rejected (cash, weight, slippage), so the account is the truth:
  // no position -> flat; a position we did not record -> adopt it with
  // its cost basis as the entry.
  syncPosition(state: BarsState): { qty: bigint; cost: bigint } | null {
    const holding = state.positions.get(SYMBOL);
    if (holding === undefined || holding.qty <= 0n) {
      this.mode = null;
      this.tier = 0;
      this.entry = null;
      return null;
    }
    if (this.mode === null) {
      // entry = average fill price from cost and qty. cost is micro-USDC,
      // qty is 1e-8 units, price is 1e-5 USD: entry = cost * 10^7 / qty.
      this.mode = "big";
      this.tier = 2;
      this.entry = (holding.cost * 10_000_000n) / holding.qty;
    }
    return holding;
  }

  sellAll(state: BarsState): OrderInput {
    const holding = state.positions.get(SYMBOL);
    return {
      side: "sell",
      symbol: SYMBOL,
      qty: holding!.qty,
      max_slippage_bps: SLIP_BPS,
    };
  }

  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    this.closes.push(close);
    if (this.emaFp === null) {
      this.emaFp = close * FP;
    } else {
      this.emaFp =
        (close * 2n * FP + this.emaFp * (EMA_N - 1n)) / (EMA_N + 1n);
    }
    if (this.closes.length < Number(EMA_N) + 1) return [];

    const holding = this.syncPosition(state);
    const prevClose = this.closes[this.closes.length - 2]!;
    const ref = this.closes[this.closes.length - 1 - DROP_MIN]!;
    const drop30 = ((close - ref) * BPS) / ref;

    if (holding !== null) return this.manage(state, close, drop30);
    return this.enter(state, close, drop30, prevClose);
  }

  manage(state: BarsState, close: bigint, drop30: bigint): OrderInput[] {
    const entry = this.entry!;
    if (this.mode === "big") {
      // Top up on a deeper washout, with the cash left over.
      if (this.tier === 1 && drop30 <= -BIG_DROP_2_BPS) {
        const room = state.weightRoom(SYMBOL);
        const notional = state.cash < room ? state.cash : room;
        if (notional >= MIN_NOTIONAL) {
          this.tier = 2;
          return [
            {
              side: "buy",
              symbol: SYMBOL,
              notional_quote_units: notional,
              max_slippage_bps: SLIP_BPS,
            },
          ];
        }
      }
      if (close * BPS >= entry * (BPS + BIG_TP_BPS)) return [this.sellAll(state)];
      if (close * BPS <= entry * (BPS - BIG_SL_BPS)) return [this.sellAll(state)];
      return [];
    }
    // small layer
    if (close * BPS >= entry * (BPS + SMALL_TP_BPS)) return [this.sellAll(state)];
    if (close * BPS <= entry * (BPS - SMALL_SL_BPS)) return [this.sellAll(state)];
    if (close * FP >= this.emaFp!) return [this.sellAll(state)];
    return [];
  }

  enter(state: BarsState, close: bigint, drop30: bigint, prevClose: bigint): OrderInput[] {
    if (drop30 <= -BIG_DROP_1_BPS) {
      let notional = state.equity / 2n;
      const room = state.weightRoom(SYMBOL);
      if (notional > room) notional = room;
      if (notional < MIN_NOTIONAL) return [];
      this.mode = "big";
      this.tier = 1;
      this.entry = close;
      return [
        {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: SLIP_BPS,
        },
      ];
    }
    const dip = ((this.emaFp! - close * FP) * BPS) / this.emaFp!;
    if (dip >= SMALL_DIP_BPS && close > prevClose && drop30 > -SMALL_MAX_DROP_BPS) {
      let notional = state.equity / 2n;
      const room = state.weightRoom(SYMBOL);
      if (notional > room) notional = room;
      if (notional < MIN_NOTIONAL) return [];
      this.mode = "small";
      this.tier = 0;
      this.entry = close;
      return [
        {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: SLIP_BPS,
        },
      ];
    }
    return [];
  }
}

const rider = new DipBuyRider();
await runBars({
  onBatch: (state, batch) => rider.onBatch(state, batch),
});
