# Polymarket Sports Cross-Line Arbitrage Bot

> A polymarket trading bot that detects temporary pricing inefficiencies across connected Polymarket sports markets.

<p align="center">
 <img width="800" height="418" alt="image" src="https://github.com/user-attachments/assets/78ca4d97-f674-4330-8b79-4f23cd24f12f" />
</p>

**Polymarket Profile** → https://polymarket.com/@woaifacai

### Connect

📞 https://t.me/woaifacai888

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
