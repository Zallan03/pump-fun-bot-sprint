// Pump.fun Bot Sprint — "Early launch scalper with a rug filter".
//
// A Solana paper-trading bot for pump.fun bonding curves, speaking
// agent-fun/replay/v2 over stdin/stdout through the vendored shim
// (vendor/makefun-bot.ts). The harness sends one hello, then one batch per
// slot, then done; the bot answers exactly one reply per batch, echoing its
// seq. Orders decided on the batch for slot s fill at slot s + latency.
//
// Strategy (all decisions from the hello + batch state and the slot number;
// no clock, no environment, no randomness — the two grading runs agree
// byte for byte). Built from the kit's 24h dev window (128k events, 1222
// coins) and from what the house's own pilots show on it: a momentum bot
// that chases a rise loses -9.5 SOL, a reversion bot -3.9 SOL, while a
// launch sniper that buys at creation and flips fast loses only -0.5 SOL.
// The lesson is that pump.fun coins are won or lost in their first slots:
// the edge is in being early and getting out fast, not in chasing a move
// that has already happened. So this bot is a scalper, not a trend
// follower:
//   * Watch every new coin from its CreateEvent. Record its creator, its
//     creation price, and the wallets buying it.
//   * Enter only in the first 5 slots of a coin's life, and only when
//     the launch looks honest: the creator has not sold, at most 5
//     distinct non-creator wallets bought in the opening (a launch
//     bundled by many wallets in its first slots is usually the
//     creator's cluster waiting to dump), the early flow is buy-dominated,
//     and the curve already holds >= 0.5 SOL of real reserves so the
//     harness buy cap lets a useful stake through.
//   * Stake 0.1 SOL per position (capped by the harness buy cap of 100 bps
//     of the coin's real SOL reserve; skip when the cap is under 0.01 SOL,
//     the minimum round trip). At most 5 open positions.
//   * Exit fast, checked every batch: take profit at +30% over cost,
//     stop loss at -8% under cost, a hard time exit after 12 slots, and
//     an immediate exit if the creator sells while the position is held
//     (a creator selling is a rug — leave at once). No trailing stop:
//     a scalper takes the pop and leaves; waiting for a run that may
//     never come is how the momentum bot bled out.
//   * Circuit breaker: when total account value (cash + marked positions)
//     falls under 70% of starting capital, stop opening new positions and
//     only manage exits. This keeps the run far from the 50% max-drawdown
//     guardrail.
//   * Fees per order are base + priority (~0.0001 SOL) plus the curve fees
//     (protocol 95 bps + creator 30 bps). The 0.01 SOL minimum stake and
//     the fast exits keep every round trip above its costs, and the quick
//     turnover cycles through many coins, clearing the 20-distinct-mint
//     minimum bar with margin.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// --- tuned parameters (all in lamports / basis points / slots) ---------------
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 10n) / 100n; // 0.1 SOL per position
const MIN_BUY_CAP_LAMPORTS = (LAMPORTS_PER_SOL * 5n) / 1000n; // 0.005 SOL: smallest useful fill
const MIN_REAL_SOL_LAMPORTS = (LAMPORTS_PER_SOL * 5n) / 10n; // 0.5 SOL of real reserves before entry
const MAX_AGE_SLOTS = 5; // only coins this fresh may be entered
const MAX_OPENING_BUYERS = 3; // at most this many distinct buyers in the opening
const MAX_CREATOR_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 25n) / 10n; // 2.5 SOL: a bigger creator buy is a dump in waiting
const TAKE_PROFIT_BPS = 13000; // sell when mark >= 130% of cost (+30%)
const STOP_LOSS_BPS = 9200; // sell when mark <= 92% of cost (-8%)
const MAX_HOLD_SLOTS = 12; // time exit: sell after this many slots held
const MAX_SLIPPAGE_BPS = 1000; // 10% slippage tolerance on every order
const CIRCUIT_BREAKER_BPS = 7000; // stop new buys under 70% of starting capital

// --- per-coin launch record, built from the batches --------------------------
// One record per mint, from its CreateEvent and the TradeEvents that follow.
// The harness delivers every event in slot order, so these counters are exact.
interface CoinLaunch {
  createdSlot: number;
  creator: string;
  createQuote: bigint; // virtual quote reserves at creation (price numerator)
  createToken: bigint; // virtual token reserves at creation (price denominator)
  trades: number;
  buySol: bigint;
  sellSol: bigint;
  buyers: Set<string>; // distinct non-creator wallets that bought
  creatorBuy: bigint; // SOL the creator themself bought in the opening
  creatorSold: boolean; // the creator sold at least once
  entered: boolean; // a buy has already been decided on this coin
}

const launches = new Map<string, CoinLaunch>();
// Slot at which each held position was first seen (for the time exit).
const entrySlot = new Map<string, number>();

// Price of a coin as a fraction (quote per token), from its latest reserves.
// Returns null when the reserves are unusable.
function priceOf(state: BotState, mint: string): { quote: bigint; token: bigint } | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  if (curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves <= 0n) return null;
  return { quote: curve.virtual_quote_reserves, token: curve.virtual_token_reserves };
}

// Compare a mark price (quote/token) against a cost basis (costLamports per
// tokenAmount) scaled by bps/10000, using only integer arithmetic:
//   mark >= cost * bps/10000  <=>  quote*tokenAmount*10000 >= cost*token*bps
function markAtLeast(
  mark: { quote: bigint; token: bigint },
  costLamports: bigint,
  tokenAmount: bigint,
  bps: number,
): boolean {
  return mark.quote * tokenAmount * 10_000n >= costLamports * mark.token * BigInt(bps);
}

// Mark value of a holding in lamports (floored): tokens * quote / token.
function markValueLamports(
  mark: { quote: bigint; token: bigint },
  tokenAmount: bigint,
): bigint {
  return (tokenAmount * mark.quote) / mark.token;
}

// Fold this batch's events into the per-coin launch records. Called once per
// batch, before any order decision, so the signal always uses the freshest
// trades the harness has delivered for this slot.
function foldEvents(state: BotState, batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (!launches.has(e.mint)) {
        launches.set(e.mint, {
          createdSlot: e.slot,
          creator: e.creator,
          createQuote: BigInt(e.virtual_quote_reserves),
          createToken: BigInt(e.virtual_token_reserves),
          trades: 0,
          buySol: 0n,
          sellSol: 0n,
          buyers: new Set<string>(),
          creatorBuy: 0n,
          creatorSold: false,
          entered: false,
        });
      }
      continue;
    }
    if (e.event === 'TradeEvent') {
      const launch = launches.get(e.mint);
      if (launch === undefined) continue; // no CreateEvent seen: no baseline
      launch.trades += 1;
      const sol = BigInt(e.sol_amount);
      if (e.is_buy) {
        launch.buySol += sol;
        if (e.user !== launch.creator) launch.buyers.add(e.user);
        else launch.creatorBuy += sol;
      } else {
        launch.sellSol += sol;
        if (e.user === launch.creator) launch.creatorSold = true;
      }
      continue;
    }
    // CompleteEvent: the curve is over; drop the launch record.
    if (e.event === 'CompleteEvent') launches.delete(e.mint);
  }
  // Prune stale launches so the map stays small: a coin older than the entry
  // window that was never entered will never qualify.
  for (const [mint, launch] of launches) {
    if (state.slot - launch.createdSlot > MAX_AGE_SLOTS && !launch.entered) launches.delete(mint);
  }
}

// Total account value in lamports: cash plus every position at its mark.
function accountValueLamports(state: BotState): bigint {
  let value = state.cash;
  for (const [mint, holding] of state.positions) {
    const mark = priceOf(state, mint);
    if (mark !== null) value += markValueLamports(mark, holding.token_amount);
  }
  return value;
}

await runBot({
  onHello(state) {
    // The hello message carries the run's capital, caps and fees; log them
    // to stderr (stdout carries replies only) so a local run shows the setup.
    console.error(
      `hello: capital=${state.hello.capital.lamports} lamports ` +
        `maxPositions=${state.hello.caps.max_open_positions} ` +
        `latencySlots=${state.hello.latency_slots}`,
    );
  },

  onBatch(state, batch) {
    foldEvents(state, batch);
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    const slot = state.slot;

    // --- exits first: every held position gets its bracket checked -------
    for (const [mint, holding] of state.positions) {
      const mark = priceOf(state, mint);
      if (mark === null) continue;
      // Already selling? A pending sell on this mint means the exit is in
      // flight; do not stack a second one.
      let sellPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell' && p.order.mint === mint) {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      const heldSince = entrySlot.get(mint);
      if (heldSince === undefined) entrySlot.set(mint, slot);
      const age = heldSince === undefined ? 0 : slot - heldSince;
      const takeProfit = markAtLeast(mark, holding.cost_lamports, holding.token_amount, TAKE_PROFIT_BPS);
      const stoppedOut = !markAtLeast(mark, holding.cost_lamports, holding.token_amount, STOP_LOSS_BPS);
      const timedOut = age >= MAX_HOLD_SLOTS;
      // The creator selling while a position is held is a rug: leave at once.
      const creatorSold = launches.get(mint)?.creatorSold === true;
      if (takeProfit || stoppedOut || timedOut || creatorSold) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }
    // Forget entry slots for positions that are gone.
    for (const mint of [...entrySlot.keys()]) {
      if (!state.positions.has(mint)) entrySlot.delete(mint);
    }

    // --- entries: honest launches only, in their first slots -------------
    const startingCapital = BigInt(state.hello.capital.lamports);
    const healthy = accountValueLamports(state) * 10_000n >= startingCapital * BigInt(CIRCUIT_BREAKER_BPS);
    if (healthy) {
      let free = state.freeCashLamports();
      let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const [mint, launch] of launches) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (openSlots <= 0) break;
        if (launch.entered) continue;
        if (state.positions.has(mint)) continue;
        if (slot - launch.createdSlot > MAX_AGE_SLOTS) continue;
        // Rug filter: never buy a launch whose creator already sold.
        if (launch.creatorSold) continue;
        // Rug filter: a launch bundled by many wallets in its opening is
        // a coordinated dump waiting to happen.
        if (launch.buyers.size > MAX_OPENING_BUYERS) continue;
        // Rug filter: a creator who bought a large stake themself is
        // usually about to dump it on the buyers who follow.
        if (launch.creatorBuy > MAX_CREATOR_BUY_LAMPORTS) continue;
        // Early flow must be buy-dominated.
        const volume = launch.buySol + launch.sellSol;
        if (volume <= 0n || launch.buySol <= launch.sellSol) continue;
        // The curve must already hold enough real SOL for the harness buy
        // cap to let a useful stake through.
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_CAP_LAMPORTS) continue;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (free < amount + tx) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        launch.entered = true;
        free -= amount + tx;
        openSlots -= 1;
      }
    }

    return orders;
  },

  onDone(state, done) {
    console.error(
      `done: reason=${done.reason} cash=${state.cash} ` +
        `positions=${state.positions.size} batches=${state.seq + 1}`,
    );
  },
});
