import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { createInitialSymbols, type SymbolConfig } from './config/symbols.js';
import { indicator, atrAt } from './dataProcessing.js';
import { mt5 } from './mt5/bridgeClient.js';
import { executeBuyOrder, executeSellOrder } from './orderProcessing.js';
import { logEvent } from './logging.js';
import {
  CONFIRMATION_CANDLES,
  MIN_ATR,
  MIN_BODY_TO_RANGE,
} from './config/risk.js';
import {
  candleRetrievedFlag,
  getMt5Interval,
  marketIsOpen,
  newCandleUpdate,
} from './timeProcessing.js';

async function promptCredentials(): Promise<{ account: number; password: string; server: string }> {
  const rl = createInterface({ input, output });

  while (true) {
    try {
      const accountRaw = await rl.question('Enter MT5 account number: ');
      const password = await rl.question('Enter MT5 password: ');
      const server = await rl.question('Enter server name: ');
      const account = Number.parseInt(accountRaw, 10);

      if (!Number.isFinite(account) || !password || !server) {
        throw new Error('Invalid input');
      }

      rl.close();
      return { account, password, server };
    } catch {
      console.log('Invalid input. Please try again.');
    }
  }
}

async function connectToMt5(): Promise<void> {
  const { account, password, server } = await promptCredentials();

  if (!(await mt5.initialize(account, password, server))) {
    const [code] = await mt5.lastError();
    console.log(`initialize() failed, error code=${code}`);
    process.exit(1);
  }

  if (!(await mt5.login(account, password, server))) {
    const [code] = await mt5.lastError();
    console.log(`Failed to connect to account #${account}, error code=${code}`);
    await mt5.shutdown();
    process.exit(1);
  }
}

async function runTradingLoop(symbols: SymbolConfig[]): Promise<void> {
  const pendingSignals = new Map<string, { type: 'buy' | 'sell'; entry: number; minVal?: number; maxVal?: number; avgVal: number; candlesWaited: number; createdAt: number }>();
  while (true) {
    const terminal = await mt5.terminalInfo();
    if (!terminal?.connected) {
      continue;
    }

    for (const symbolConfig of symbols) {
      const timeframe = getMt5Interval(symbolConfig.timeframe);
      if (timeframe === null) {
        continue;
      }

      const shouldAnalyze = newCandleUpdate(symbolConfig.timeframe, symbolConfig.candlesRetrieved);
      if (!shouldAnalyze) {
        continue;
      }

      if (!(await mt5.symbolSelect(symbolConfig.symbol))) {
        const [code] = await mt5.lastError();
        console.log(
          `Failed to select ${symbolConfig.symbol} on Market Watch, error code=${code}\nShutting down the program...`,
        );
        await mt5.shutdown();
        process.exit(1);
      }

      const positions = await mt5.positionsGet(symbolConfig.symbol);
      if (positions.length >= 1) {
        continue;
      }

      const rates = await mt5.copyRatesFromPos(symbolConfig.symbol, timeframe, 0, 550);
      if (!rates || rates.length < 3) {
        console.log(
          `Failed to retrieve rates for ${symbolConfig.symbol} from MT5 terminal. Trying again...`,
        );
        break;
      }

      const currOpen = rates[rates.length - 1].open;
      const prvHigh = rates[rates.length - 2].high;
      const prvLow = rates[rates.length - 2].low;

      const { maximum, minimum, average } = indicator(rates);

      const buyCondition = prvLow <= minimum && currOpen < average;
      const sellCondition = prvHigh >= maximum && currOpen > average;

      // Trend-quality filter: require minimum ATR and momentum (body-to-range)
      const atr = atrAt(rates, 18);
      const prevBar = rates[rates.length - 2];
      const body = Math.abs(prevBar.open - prevBar.close);
      const range = prevBar.high - prevBar.low || 1;
      const bodyRatio = body / range;

      const passesTrendFilter = atr >= MIN_ATR && bodyRatio >= MIN_BODY_TO_RANGE;

      const pending = pendingSignals.get(symbolConfig.symbol);

      if (pending) {
        // Awaiting confirmation candle(s)
        pending.candlesWaited += 1;
        if ((pending.type === 'buy' && buyCondition) || (pending.type === 'sell' && sellCondition)) {
          if (pending.candlesWaited >= CONFIRMATION_CANDLES) {
            logEvent('signal_confirmed', { symbol: symbolConfig.symbol, pending });
            if (pending.type === 'buy') {
              await executeBuyOrder(mt5, symbolConfig.symbol, pending.entry, pending.minVal ?? 0, pending.avgVal);
            } else {
              await executeSellOrder(mt5, symbolConfig.symbol, pending.entry, pending.maxVal ?? 0, pending.avgVal);
            }
            pendingSignals.delete(symbolConfig.symbol);
          }
        } else {
          logEvent('signal_cancelled', { symbol: symbolConfig.symbol, pending });
          pendingSignals.delete(symbolConfig.symbol);
        }
      } else {
        if (passesTrendFilter) {
          if (buyCondition) {
            // Create a pending buy signal requiring confirmation
            pendingSignals.set(symbolConfig.symbol, {
              type: 'buy',
              entry: currOpen,
              minVal: minimum,
              avgVal: average,
              candlesWaited: 0,
              createdAt: Date.now(),
            });
            logEvent('signal_generated', { symbol: symbolConfig.symbol, type: 'buy', entry: currOpen, minimum, average });
          } else if (sellCondition) {
            pendingSignals.set(symbolConfig.symbol, {
              type: 'sell',
              entry: currOpen,
              maxVal: maximum,
              avgVal: average,
              candlesWaited: 0,
              createdAt: Date.now(),
            });
            logEvent('signal_generated', { symbol: symbolConfig.symbol, type: 'sell', entry: currOpen, maximum, average });
          }
        } else {
          // Trend filter failed: ignore potential signals
          if (buyCondition || sellCondition) {
            logEvent('signal_filtered_out', { symbol: symbolConfig.symbol, atr, bodyRatio, buyCondition, sellCondition });
          }
        }
      }

      const latest = await mt5.copyRatesFromPos(symbolConfig.symbol, timeframe, 0, 1);
      if (latest && latest.length > 0) {
        symbolConfig.candlesRetrieved = candleRetrievedFlag(latest[0].time);
      }
    }

    if (!marketIsOpen()) {
      console.log('\nMARKET CLOSING SOON.\nSleeping till Sunday 09:59:00 PM...');
      await sleep(172_800_000);
      break;
    }
  }
}

async function main(): Promise<void> {
  const symbols = createInitialSymbols();

  while (true) {
    if (!marketIsOpen()) {
      for (const symbolConfig of symbols) {
        symbolConfig.candlesRetrieved = false;
      }
      await connectToMt5();
    } else {
      continue;
    }

    await runTradingLoop(symbols);
  }
}

main().catch(async (error: unknown) => {
  console.error(error);
  await mt5.shutdown();
  process.exit(1);
});
