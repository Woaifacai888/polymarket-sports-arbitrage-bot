# Polymarket Sports Cross-Line Arbitrage Bot

> A polymarket trading bot that detects temporary pricing inefficiencies across connected Polymarket sports markets.

<p align="center">
 <img width="800" height="418" alt="whoami" src="https://github.com/user-attachments/assets/f5c8ac93-fb22-4be7-b2a0-93486fcb52a5" />
</p>

**Polymarket Profile** → https://polymarket.com/@sold-my-car-to-bet

### Connect

📧 hacki13128@gmail.com

📞 https://t.me/hackonmon

---

## Features

- ⚡ Real-time Polymarket CLOB streaming (market + user WS in live mode)
- 🧠 Cross-line arbitrage detection on NBA & World Cup sports markets
- 📈 Kelly / target-notional stake sizing (default **$100** per package)
- 💰 Paper trading (sim) & live trading via `@polymarket/clob-client-v2`
- 🛡 Risk engine: kill switch, exposure caps, liquidity & stale-book gates
- 📦 Multi-leg execution with tick rounding, retries, and rollback on failure
- 📜 Persistent trade history (JSONL) for sim and live sessions
- 📊 Terminal dashboard with live + recent opportunities, PnL, and exposure
- 🪟 **Windows one-click launchers** (`run-bot-sim.bat`, `run-bot-live.bat`)
- 🚀 PM2 process management with auto-restart
- 🧩 Modular TypeScript architecture + unit tests

---

## Strategy

Sports markets inside a single event should satisfy several no-arbitrage relationships. When one market reprices faster than another, temporary inefficiencies can appear.

```
Gamma API
      │
      ▼
Discover connected markets (NBA + World Cup)
      │
      ▼
Stream live CLOB order books (REST + WebSocket)
      │
      ▼
Detect pricing violations (6 relation types)
      │
      ▼
Depth / staleness / exposure / kill-switch checks
      │
      ▼
Size to target notional (~$100 package default)
      │
      ▼
Place multi-leg limit orders (tick-rounded, with retry)
      │
      ▼
Track fills, positions, PnL & append trade history
```

### Arbitrage checks

| Relation | Description |
|----------|-------------|
| `complementary_pair` | YES ask + NO ask &lt; $1 on same market |
| `btts` | BTTS YES/NO pair (same as complementary) |
| `totals_ladder` | Over(lower line) priced below Over(higher line) |
| `spread_ladder` | Easier spread YES cheaper than harder spread YES |
| `moneyline_spread` | ML vs spread-at-0 desync (real NO ask hedge) |
| `three_way_sum` | Home + draw + away YES asks sum &lt; $1 |

### Execution quality

- **Stable opportunity IDs** — cooldown and risk tracking work across scans
- **Depth-aware sizing** — rejects or clamps when ask depth is insufficient
- **Stale book filter** — skips opportunities when books are older than `MAX_BOOK_AGE_MS`
- **Multi-leg rollback** — cancels already-placed legs if a later leg fails
- **Kill switch** — halts trading when daily realized loss exceeds limit

---

## Quick Start

### Windows / macOS / Linux

```bash
git clone https://github.com/donoaccestag/polymarket-sports-trading-bot.git
cd polymarket-sports-trading-bot

cp .env.example .env

npm install
npm run build

# Simulation
npm run start:sim

# Live (requires credentials + confirmation)
npm run start:live -- --confirm-live
```

### Bat Launchers

Requires **Node.js 20+**. Double-click or run from a terminal:

```bat
run-bot-sim.bat
```

For live trading (real funds):

1. Copy `.env.example` → `.env` and fill in wallet + CLOB credentials
2. Run:

```bat
run-bot-live.bat
```

Each `.bat` file automatically:

1. Checks Node.js is installed
2. Creates `.env` from template if missing (sim only)
3. Runs `npm install`
4. Runs `npm run build`
5. Starts the bot via **PM2** (`pm2-runtime`) with the interactive dashboard

Press **Ctrl+C** in the window to stop the bot.

| File | Mode | Notes |
|------|------|-------|
| `run-bot-sim.bat` | Paper trading | Safe default; creates `.env` if needed |
| `run-bot-live.bat` | Live trading | Requires credentials; prompts `YES` to confirm |

PM2 config lives in `ecosystem.config.cjs` (`polymarket-bot-sim` / `polymarket-bot-live`).

### Development (hot reload)

```bash
npm run dev
```

### Tests

```bash
npm test
```

---

## CLI

```bash
npm start -- --mode sim
npm start -- --mode live --confirm-live
npm start -- --event nba-lal-bos-2026-01-15
npm start -- --tag 100381
```

| Flag | Description |
|------|-------------|
| `--mode sim` | Simulation / paper trading |
| `--mode live` | Live trading on Polymarket CLOB |
| `--event` | Watch a specific event slug |
| `--tag` | Filter Gamma tag IDs |
| `--confirm-live` | Required safety confirmation for live mode |

---

## Terminal Dashboard

```
┌──────────────────────────────────────────────────────────────────┐
│ SIM/LIVE • WS • Order~$100 • Cash • PnL (R/U) • Kill switch     │
├───────────────────────────────┬──────────────────────────────────┤
│ Tracked Markets               │ Opportunities (live + recent)    │
├───────────────────────────────┴──────────────────────────────────┤
│ Total PnL (realized + MTM)                         Exposure gauge │
├───────────────────────────────┬──────────────────────────────────┤
│ Orders / Fills / History      │ Alerts                           │
└───────────────────────────────┴──────────────────────────────────┘

[p] Pause   [f] Flatten (cancel all)   [q] Quit
```

- **Opportunities panel** shows the live scan **plus recently seen/placed** rows (edges disappear from the book right after a fill — history keeps them visible).
- **Header** shows target order size, realized/unrealized PnL, daily PnL vs loss limit, and kill-switch state.
- Structured logs go to `logs/bot.log` via **Pino** so they never corrupt the TUI.

---

## Trade History

Every placement, fill, and rejection is appended to a JSONL file:

```
data/trades/sim-2026-07-14.jsonl
data/trades/live-2026-07-14.jsonl
```

Each line is a JSON record with timestamp, mode, relation, notional, status, and fill details. The file path is shown in the **Alerts** panel on startup. Configure the directory with `TRADE_HISTORY_DIR` in `.env`.

---

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MODE` | `sim` | `sim` or `live` |
| `SPORT_FOCUS` | `nba,world_cup` | Sports to discover |
| `MIN_NET_EDGE_BPS` | `50` | Minimum net edge to trade |
| `MIN_STAKE_USD` | `100` | Target package notional (USD) |
| `MAX_POSITION_USD` | `500` | Max stake cap |
| `MAX_EVENT_EXPOSURE_USD` | `200` | Per-event exposure cap |
| `KELLY_FRACTION` | `0.5` | Fractional Kelly for non-locked arbs |
| `DAILY_LOSS_LIMIT_USD` | `100` | Kill-switch threshold |
| `FEE_BPS` | `200` | Fee assumption (bps) |
| `SLIPPAGE_BPS` | `10` | Slippage buffer (bps) |
| `SIM_INITIAL_BALANCE` | `10000` | Paper starting balance |
| `MAX_OPEN_ORDERS` | `20` | Open order cap |
| `MAX_BOOK_AGE_MS` | `15000` | Reject stale books |
| `ORDER_PLACE_RETRIES` | `2` | Retries per leg placement |
| `OPPORTUNITY_COOLDOWN_MS` | `5000` | Dedup cooldown per opportunity |
| `TRADE_HISTORY_DIR` | `data/trades` | Trade log directory |
| `LOG_FILE` | `logs/bot.log` | Pino log file |

Live mode also requires:

```
PRIVATE_KEY
CLOB_API_KEY
CLOB_API_SECRET
CLOB_API_PASSPHRASE
```

Plus `--confirm-live` or `CONFIRM_LIVE=true`.

---

## Architecture

```
                Gamma REST
                     │
                     ▼
               Event Graph + Classifier
                     │
                     ▼
           CLOB REST / WebSocket
                     │
                     ▼
             OrderBook Store
                     │
                     ▼
     Arb Detector + Liquidity checks
                     │
                     ▼
              Risk Manager
                     │
                     ▼
              Stake Sizer (~$100)
                     │
                     ▼
         Order Manager (retry + rollback)
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
 Sim Executor              Live Executor
        │                         │
        └────────────┬────────────┘
                     ▼
   Portfolio + Trade History + Dashboard
```

---

## Live Trading

Live mode uses `@polymarket/clob-client-v2` against production Polymarket endpoints.

1. Set credentials in `.env`
2. Run `run-bot-live.bat` (Windows) or `npm run start:live -- --confirm-live`
3. Type **YES** when prompted (bat file) or set `CONFIRM_LIVE=true`

The user WebSocket streams fill updates in live mode. PM2 auto-restarts the process on crash (`ecosystem.config.cjs`).

---

## Project Structure

```
src/
├── arb/           Arbitrage detection, relations, liquidity checks
├── config/        Zod schema + env loading
├── core/          Engine tick loop
├── data/          Gamma, CLOB REST, WebSocket, order book store
├── exec/          Sim/live executors, order manager
├── model/         Event graph, market classifier, sports registry
├── portfolio/     Positions, PnL, trade history, opportunity history
├── risk/          Risk manager, stake sizer
├── ui/            blessed-contrib terminal dashboard
└── util/          Logging, math, rate limiting

run-bot-sim.bat    Windows sim launcher (npm install + build + PM2)
run-bot-live.bat   Windows live launcher (credentials check + PM2)
ecosystem.config.cjs   PM2 app definitions
test/              Unit tests (arb, risk, portfolio, stake math)
data/trades/       Persistent trade history (gitignored)
```

---

## Contributing

Contributions are welcome — whether you're interested in quantitative trading, prediction markets, TypeScript, market microstructure, or performance optimization, feel free to open an Issue or Pull Request.

---

<p align="center">

### Built with ❤️ for the Polymarket developer community.

If this repository helped you learn something new, consider giving it a ⭐.

</p>
