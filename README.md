# Forex Trading Bot

## About The Program

This program is a forex trading bot that works on the popular trading platform, MetaTrader 5. It is implemented in TypeScript under `src/`.

The bot employs a variation of a SuperTrend strategy (18 periods, multiplicative factor of 5). Buy when the previous candle low is at or below the down-trend line and the current open is below the average line; sell when the previous high is at or above the up-trend line and the current open is above the average line.

## TypeScript Project Structure

| Path | Role |
| --- | --- |
| `src/index.ts` | Main program loop |
| `src/dataProcessing.ts` | SuperTrend indicator (ATR implemented in TypeScript) |
| `src/orderProcessing.ts` | Order execution with **Kelly stake sizing** via [`stake-math`](https://www.npmjs.com/package/stake-math) |
| `src/timeProcessing.ts` | Market hours, candle timing, MT5 timeframe mapping |
| `src/config/symbols.ts` | 26 forex pairs and timeframes |
| `src/config/kelly.ts` | Kelly parameters (win probability, fraction, caps) |
| `src/mt5/` | Typed MT5 client |
| `scripts/mt5-bridge.py` | Thin Python RPC bridge to the official `MetaTrader5` package |

### Kelly Stake Sizing

Forex risk/reward is mapped into stake-math’s binary-market inputs:

- `bankroll` — account balance  
- `probability` — estimated win rate (`KELLY_WIN_PROBABILITY` in `src/config/kelly.ts`)  
- `allInPrice` — risk share of total move: `|entry − sl| / (|entry − sl| + |tp − entry|)`  
- `kellyFraction` — fractional Kelly (default half-Kelly at `0.5`)

The returned USD stake is converted to lots using symbol tick size/value. The original “double lot when closer to average line” rule is preserved.

## Prerequisites

- **Node.js 18+**
- **MetaTrader 5** terminal ([download](https://www.metatrader5.com/en/download))
- **Python 3** with the official package: `pip install MetaTrader5`

## Running (TypeScript)

```bash
npm install
npm run build
npm start
```

Development (no build step):

```bash
npm install
npm run dev
```

You will be prompted for MT5 account number, password, and server name. Track orders in the MetaTrader 5 terminal. Use a **demo account** for testing.

## Disclaimer

This strategy is not guaranteed to be profitable. Exhaustive backtesting is required before live use. Intended as a sample of algorithmic trading work — use on demo accounts only.
