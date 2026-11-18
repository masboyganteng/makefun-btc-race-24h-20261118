# Dip-Buy Rider — BTC race bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/masboyganteng/makefun-btc-race-24h-20261118/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/masboyganteng/makefun-btc-race-24h-20261118/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A cbBTC mean-reversion bot for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444) on make.fun. Long only, paper money, one position at a time.

## Strategy

Bitcoin's 1-minute cbBTC tape is choppy and mean-reverting on the hourly scale. The bot only buys after the tape has washed out, then rides the bounce back. It never chases a trend.

- **BIG (capitulation):** the 30-minute drop is 120 bps or worse → buy half the equity. If the washout deepens to 180 bps, spend the rest of the cash. Exit at +250 bps or −150 bps against the first entry.
- **SMALL (dip):** the close sits 50 bps or more below its 60-bar EMA and the last bar bounced, while the 30-minute drop is milder than 80 bps (so a small dip never blocks a BIG entry forming in a waterfall) → buy half the equity. Exit at +100 bps, −100 bps, or when the close climbs back above the EMA.

## Implementation

- `main.py` — the whole bot. Integer math on the harness's own units (price-scale-5 closes, micro-USDC cash), so two runs on the same data decide the same orders. No clock, no network, no files, no randomness.
- `vendor/makefun_bars.py` — byte-for-byte copy of the kit's Python protocol shim.

## Local grade

Dev-window result (grade-local, `--driver process`): **net PnL +$16.49, max drawdown 1.49%, 6 trades, win rate 66.7%** — passes the dev gate (net PnL above $0).

## License

MIT — see `LICENSE`.
