# Polymarket Sports Cross-Line Arbitrage Bot

> A polymarket trading bot that detects temporary pricing inefficiencies across connected Polymarket sports markets.

<p align="center">
 <img width="800" height="418" alt="whoami" src="https://github.com/user-attachments/assets/f5c8ac93-fb22-4be7-b2a0-93486fcb52a5" />
</p>

**Who-am-i on Polymarket** -> [sold-my-car-to-bet](https://polymarket.com/@sold-my-car-to-bet)

## How profitable this bot?

https://github.com/user-attachments/assets/df6a93c2-c9b8-4b50-8ff4-bb863e60443b

### Connect

📧 hacki13128@gmail.com

📞 https://t.me/hackonmon

---

## Features

- ⚡ Real-time Polymarket CLOB streaming
- 🧠 Cross-line arbitrage detection on sports market
- 📈 Kelly Criterion stake sizing
- 💰 Paper trading & Live trading
- 🛡 Risk management engine
- 📊 Beautiful terminal dashboard
- 🧩 Modular architecture
- 📝 Structured logging
- 🚀 Production-oriented TypeScript codebase

---

## Strategy

Sports markets inside a single event should satisfy several no-arbitrage relationships.

Whenever one market reprices faster than another after new information arrives, temporary inefficiencies can appear.

The bot continuously:

```
Gamma API
      │
      ▼
Discover connected markets
      │
      ▼
Stream live CLOB orderbooks
      │
      ▼
Detect pricing violations
      │
      ▼
Risk evaluation
      │
      ▼
Kelly stake sizing
      │
      ▼
Submit limit orders
      │
      ▼
Track positions & PnL
```

Current arbitrage checks include:

- Complementary YES/NO pairs
- Totals ladder relationships
- Spread ladder relationships
- Moneyline vs Spread
- Three-way market sums
- BTTS relationships

---

## Quick Start

```bash
git clone https://github.com/Poly-Sports/polymarket-sports-arbitrage-bot.git

cd polymarket-sports-arbitrage-bot

cp .env.example .env

npm install

npm run start:sim
```

---

### CLI

```bash
npm start -- --mode sim
```

```bash
npm start -- --mode live --confirm-live
```

```bash
npm start -- --event nba-lal-bos-2026-01-15
```

```bash
npm start -- --tag 100381
```

---

### CLI Options

| Flag | Description |
|------|-------------|
| `--mode sim` | Simulation mode |
| `--mode live` | Live trading |
| `--event` | Watch specific event |
| `--tag` | Filter Gamma tags |
| `--confirm-live` | Required safety confirmation |

---

## Terminal Dashboard

```
┌───────────────────────────────────────────────────────────────┐
│ Header                                                       │
│ Mode • WS Status • Balance • PnL • Uptime                    │
├───────────────────────────────────────────────────────────────┤
│ Tracked Markets            │ Opportunities                   │
├────────────────────────────┴──────────────────────────────────┤
│ PnL Chart                                           Exposure  │
├───────────────────────────────────────────────────────────────┤
│ Orders / Fills             │ Alerts                          │
└───────────────────────────────────────────────────────────────┘

[p] Pause

[f] Flatten

[q] Quit
```

Logs are written separately using **Pino** so they never corrupt the dashboard.

---

## Configuration

See `.env.example`.

Important variables:

| Variable | Default | Description |
|------------|------------|-----------------------------|
| MODE | sim | sim or live |
| MIN_NET_EDGE_BPS | 50 | Minimum edge |
| MAX_POSITION_USD | 500 | Max Kelly stake |
| KELLY_FRACTION | 0.5 | Half Kelly |
| MIN_STAKE_USD | 5 | Minimum trade |
| MAX_EVENT_EXPOSURE_USD | 200 | Event exposure cap |
| DAILY_LOSS_LIMIT_USD | 100 | Kill switch |
| SIM_INITIAL_BALANCE | 10000 | Paper balance |

---

## Architecture

```
                Gamma REST
                     │
                     ▼
               Event Graph
                     │
                     ▼
              Market Classifier
                     │
                     ▼
           CLOB REST / WebSocket
                     │
                     ▼
             OrderBook Store
                     │
                     ▼
            Arbitrage Detector
                     │
                     ▼
              Risk Management
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
 Sim Executor              Live Executor
        │                         │
        └────────────┬────────────┘
                     ▼
            Portfolio + Dashboard
```

---

## Live Trading

Live mode requires:

```
PRIVATE_KEY

CLOB_API_KEY

CLOB_API_SECRET

CLOB_API_PASSPHRASE
```

and either

```
--confirm-live
```

or

```
CONFIRM_LIVE=true
```

Execution uses

```
@polymarket/clob-client-v2
```

against production endpoints.

---

## Project Structure

```
src/

├── arb/
│   └── Arbitrage detection

├── config/
│   └── Zod configuration

├── core/
│   └── Engine

├── data/
│   ├── Gamma
│   ├── CLOB REST
│   └── WebSocket

├── exec/
│   ├── Simulation
│   ├── Live
│   └── Order Manager

├── model/
│   ├── Event Graph
│   └── Classifier

├── portfolio/
│   └── PnL

├── risk/
│   └── Exposure controls

├── ui/
│   └── blessed-contrib dashboard

└── util/
    ├── Logging
    ├── Math
    └── Rate limiting
```

---

## Contributing

Contributions are welcome.

Whether you're interested in:

- quantitative trading
- prediction markets
- TypeScript
- market microstructure
- performance optimization

feel free to open an Issue or Pull Request.

---

<p align="center">

### Built with ❤️ for the Polymarket developer community.

If this repository helped you learn something new, consider giving it a ⭐.

</p>
