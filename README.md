# Pump.fun Bot Sprint: Make Bot And Win

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Zallan03/pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Zallan03/pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Entry for the make.fun bounty [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) — a Solana paper-trading bot for pump.fun bonding curves, ranked on net PnL.

## Strategy

An early launch scalper with a rug filter. It watches every new coin from its `CreateEvent`, enters only in the first 5 slots of a coin's life when the launch looks honest (creator has not sold, at most 3 distinct buyers in the opening, buy-dominated early flow, ≥ 0.5 SOL of real reserves), stakes 0.1 SOL per position, and exits fast: take profit +30%, stop loss −8%, a 12-slot time exit, and an immediate exit if the creator sells. A circuit breaker stops new entries if account value falls under 70% of starting capital.

Paper money only: no live trading, no real funds, no network, no external keys. Fully deterministic — the two grading runs agree byte for byte.

## Run

The bot speaks `agent-fun/replay/v2` over stdin/stdout through the vendored shim (`vendor/makefun-bot.ts`). The grader runs it as `node /bot/main.ts` (Node 22).

## Files

- `main.ts` — the bot (entrypoint).
- `vendor/makefun-bot.ts` — the kit's protocol shim, copied unchanged from the kit SDK.
- `LICENSE` — MIT.
