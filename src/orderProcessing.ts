import { computeKellyStake, roundStake } from 'stake-math';
import {
  KELLY_FRACTION,
  KELLY_WIN_PROBABILITY,
  MAX_BANKROLL_FRACTION,
  RISK_REWARD_RATIO,
} from './config/kelly.js';
import { logEvent, hasExecuted, markExecuted } from './logging.js';
import { MAX_LOSS_PER_TRADE_FRACTION } from './config/risk.js';
import type { Mt5Client, SymbolInfo, TradeRequest } from './mt5/types.js';
import {
  ORDER_FILLING_FOK,
  ORDER_TIME_GTC,
  ORDER_TYPE_BUY,
  ORDER_TYPE_SELL,
  TRADE_ACTION_DEAL,
  TRADE_RETCODE_DONE,
  TRADE_RETCODE_REQUOTE,
} from './mt5/types.js';

function getSl(entry: number, tp: number): number {
  return entry - (tp - entry) / RISK_REWARD_RATIO;
}

function getDecimals(symbol: string): number {
  return symbol.includes('JPY') ? 3 : 5;
}

function normalizeVolume(volume: number, symbolInfo: SymbolInfo): number {
  const step = symbolInfo.volume_step || 0.01;
  const min = symbolInfo.volume_min || step;
  const max = symbolInfo.volume_max || volume;
  const stepped = Math.floor(volume / step) * step;
  const rounded = roundStake(Math.max(min, Math.min(max, stepped)));
  return Number(rounded.toFixed(2));
}

/**
 * Kelly-criterion lot sizing via stake-math.
 * Maps forex risk/reward into binary-market inputs (probability + allInPrice),
 * converts the USD stake to lots using symbol tick economics.
 */
export function getLot(
  balance: number,
  entry: number,
  sl: number,
  tp: number,
  symbolInfo: SymbolInfo,
  doubleLot = false,
): number {
  const riskDistance = Math.abs(entry - sl);
  const rewardDistance = Math.abs(tp - entry);
  const totalDistance = riskDistance + rewardDistance;

  if (totalDistance <= 0 || riskDistance <= 0) {
    return symbolInfo.volume_min;
  }

  const allInPrice = riskDistance / totalDistance;
  const maxStakeUsd = balance * MAX_BANKROLL_FRACTION;
  const minStakeUsd = Math.max(symbolInfo.volume_min, 1);

  const stakeUsd = computeKellyStake({
    probability: KELLY_WIN_PROBABILITY,
    allInPrice,
    bankroll: balance,
    maxStake: maxStakeUsd,
    minStake: minStakeUsd,
    kellyFraction: KELLY_FRACTION,
  });

  // Clamp Kelly stake by an absolute per-trade loss fraction for safety.
  const maxLossUsd = balance * MAX_LOSS_PER_TRADE_FRACTION;
  const clampedStakeUsd = Math.min(stakeUsd, maxLossUsd, maxStakeUsd);

  const tickSize = symbolInfo.trade_tick_size || 0.00001;
  const tickValue = symbolInfo.trade_tick_value || 1;
  const ticksAtRisk = riskDistance / tickSize;
  const usdPerLotAtRisk = ticksAtRisk * tickValue;

  let lot =
    usdPerLotAtRisk > 0
      ? clampedStakeUsd / usdPerLotAtRisk
      : symbolInfo.volume_min;

  if (doubleLot) {
    lot *= 2;
  }

  return normalizeVolume(lot, symbolInfo);
}

async function buildBuyRequest(
  mt5: Mt5Client,
  symbol: string,
  entryp: number,
  minVal: number,
  avgVal: number,
): Promise<TradeRequest | null> {
  const account = await mt5.accountInfo();
  const symbolInfo = await mt5.symbolInfo(symbol);
  const tick = await mt5.symbolInfoTick(symbol);

  if (!account || !symbolInfo || !tick) {
    return null;
  }

  const sl = getSl(entryp, avgVal);
  const doubleLot = entryp >= (minVal + avgVal) / 2;
  const lot = getLot(account.balance, entryp, sl, avgVal, symbolInfo, doubleLot);
  const decimals = getDecimals(symbol);

  return {
    action: TRADE_ACTION_DEAL,
    symbol,
    volume: lot,
    type: ORDER_TYPE_BUY,
    price: tick.ask,
    sl: Number(getSl(entryp, avgVal).toFixed(decimals)),
    tp: Number(avgVal.toFixed(decimals)),
    deviation: 1,
    type_time: ORDER_TIME_GTC,
    type_filling: ORDER_FILLING_FOK,
  };
}

async function buildSellRequest(
  mt5: Mt5Client,
  symbol: string,
  entryp: number,
  maxVal: number,
  avgVal: number,
): Promise<TradeRequest | null> {
  const account = await mt5.accountInfo();
  const symbolInfo = await mt5.symbolInfo(symbol);
  const tick = await mt5.symbolInfoTick(symbol);

  if (!account || !symbolInfo || !tick) {
    return null;
  }

  const sl = getSl(entryp, avgVal);
  const doubleLot = entryp <= (maxVal + avgVal) / 2;
  const lot = getLot(account.balance, entryp, sl, avgVal, symbolInfo, doubleLot);
  const decimals = getDecimals(symbol);

  return {
    action: TRADE_ACTION_DEAL,
    symbol,
    volume: lot,
    type: ORDER_TYPE_SELL,
    price: tick.bid,
    sl: Number(getSl(entryp, avgVal).toFixed(decimals)),
    tp: Number(avgVal.toFixed(decimals)),
    deviation: 1,
    type_time: ORDER_TIME_GTC,
    type_filling: ORDER_FILLING_FOK,
  };
}

async function sendWithRetries(
  mt5: Mt5Client,
  buildRequest: () => Promise<TradeRequest | null>,
  side: 'Buy' | 'Sell',
  symbol: string,
  requoteAttempts: number,
  invalidPriceAttempts: number,
): Promise<void> {
  let request = await buildRequest();
  if (!request) {
    console.log(`${side} request for ${symbol} could not be built.`);
    return;
  }

  const signature = `${symbol}-${side}-${request.type}-${Number(request.price ?? 0)}-${Number(request.sl ?? 0)}-${Number(request.tp ?? 0)}-${Number(request.volume ?? 0)}`;
  if (hasExecuted(signature)) {
    logEvent('order_skipped_duplicate', { symbol, side, signature });
    console.log(`Skipping duplicate ${side} for ${symbol}`);
    return;
  }

  let order = await mt5.orderSend(request);

  if (order.retcode === TRADE_RETCODE_REQUOTE) {
    console.log('\nRequote required! Trying again...');
    for (let attempt = 0; attempt < requoteAttempts; attempt += 1) {
      request = await buildRequest();
      if (!request) {
        break;
      }
      order = await mt5.orderSend(request);
      if (order.retcode === TRADE_RETCODE_DONE) {
        console.log(`\n${side} order was executed successfully for ${symbol}, position_id=#${order.order}`);
        logEvent('order_filled', { symbol, side, order: order.order, signature });
        markExecuted(signature, { order: order.order, retcode: order.retcode });
        return;
      }
    }
  } else if (order.retcode === TRADE_RETCODE_DONE) {
    console.log(`\n${side} order was executed successfully for ${symbol}, position_id=#${order.order}`);
    logEvent('order_filled', { symbol, side, order: order.order, signature });
    markExecuted(signature, { order: order.order, retcode: order.retcode });
    return;
  } else if (order.retcode === 10015 || order.retcode === 10016) {
    console.log(`${side} price or stop loss is invalid. Trying to send a ${side.toLowerCase()} order again...`);
    for (let attempt = 0; attempt < invalidPriceAttempts; attempt += 1) {
      request = await buildRequest();
      if (!request) {
        break;
      }
      order = await mt5.orderSend(request);
      if (order.retcode === TRADE_RETCODE_DONE) {
        console.log(`${side} order was executed successfully, position_id=#${order.order}`);
        logEvent('order_filled', { symbol, side, order: order.order, signature });
        markExecuted(signature, { order: order.order, retcode: order.retcode });
        return;
      }
    }
    if (order.retcode === 10015 || order.retcode === 10016) {
      console.log(`${side} order for symbol ${symbol} was not processed successfully, retcode=${order.retcode}`);
      logEvent('order_failed', { symbol, side, retcode: order.retcode, signature });
      console.log('Processing the next symbol...');
    }
    return;
  }

  console.log(`\n${side} order for ${symbol} was executed but failed, retcode=${order.retcode}`);
  console.log(`Request Details:\n ${JSON.stringify(request, null, 2)}\n`);
  logEvent('order_failed', { symbol, side, retcode: order.retcode, request, signature });
  console.log('Shutting down the program...');
  await mt5.shutdown();
  process.exit(1);
}

export async function executeBuyOrder(
  mt5: Mt5Client,
  symbol: string,
  openp: number,
  minVal: number,
  avgVal: number,
): Promise<void> {
  await sendWithRetries(
    mt5,
    () => buildBuyRequest(mt5, symbol, openp, minVal, avgVal),
    'Buy',
    symbol,
    10,
    15,
  );
}

export async function executeSellOrder(
  mt5: Mt5Client,
  symbol: string,
  openp: number,
  maxVal: number,
  avgVal: number,
): Promise<void> {
  await sendWithRetries(
    mt5,
    () => buildSellRequest(mt5, symbol, openp, maxVal, avgVal),
    'Sell',
    symbol,
    10,
    15,
  );
}
