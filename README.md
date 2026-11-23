# btc-race-24h-20261123-0511

[![rank](https://make.fun/bounty/btc-race-24h-20261123-0511/badge/rank)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard)
[![reward](https://make.fun/bounty/btc-race-24h-20261123-0511/badge/reward)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![bounty](https://make.fun/bounty/btc-race-24h-20261123-0511/badge/bounty)](https://make.fun/bounty/btc-race-24h-20261123-0511)

CapBreak — a cbBTC/USDC 1-minute trading bot for make.fun's ["Race a BTC trading bot live for 24 hours"](https://make.fun/bounty/btc-race-24h-20261123-0511) bounty, $50 in USDC (1st place $12). It trades cbBTC/USDC on 1-minute bars, long only, from $1,000 of paper money: it buys the full cash either on a breakout-ride (new 120-bar high with +0.5% 60-minute momentum above the 21-bar EMA) or on a capitulation-bounce (a -1.2% 60-minute selloff with the close near its low and the 5-minute return already turning up), then exits at +2.0% take-profit, an armed trailing stop, a 0.8% hard stop, or a 480-bar time stop — at most two round trips, the second only if the first lost money. On the published dev window it nets +$21.03 over 1 trade (breakout buy at 59,590, take-profit sell at 61,052) with a 1.2% maximum drawdown; the same parameters also net +$17.84 on the previous race's down-day dev window. Pure Node standard library (the kit's SDK shim vendored under `vendor/`), deterministic, no network, no wall clock.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jme44qjv&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
