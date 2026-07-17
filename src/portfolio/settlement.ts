import type { EventGraph, Position } from '../config/types.js';
import type { OrderBookStore } from '../data/orderBook.js';
import type { ArbTradePnlTracker, TradePnlSnapshot } from './arbTradePnl.js';
import type { PortfolioTracker } from './positions.js';
import { add, sum } from '../util/math.js';

export interface EventSettlementDeps {
  portfolio: PortfolioTracker;
  store: OrderBookStore;
  arbTradePnl?: ArbTradePnlTracker;
}

export interface EventSettlementOptions {
  /**
   * When true, settle even if the winner cannot be inferred from prices
   * (last chance before the event is dropped from tracking).
   */
  force?: boolean;
}

export interface EventSettlementResult {
  settledMarkets: number;
  /** Markets with positions we could not settle yet (no winner inference). */
  skippedMarkets: number;
  realizedPnlUsd: number;
  /** Cash returned to the balance by settlement payouts. */
  proceedsUsd: number;
  winnerByMarket: Map<string, 'YES' | 'NO'>;
  closedTrades: TradePnlSnapshot[];
}

/**
 * Settle all open positions of a finished event at $1/$0 payouts.
 *
 * The winner is inferred from the final order book (mid or last trade of the
 * YES token). When the book is gone, a matched YES+NO pair settles anyway —
 * its payout is $1 per share pair regardless of the winner. One-sided
 * positions with no price information are skipped until `force` is set.
 */
export function settleFinishedEvent(
  graph: EventGraph,
  deps: EventSettlementDeps,
  options: EventSettlementOptions = {},
): EventSettlementResult {
  const winnerByMarket = new Map<string, 'YES' | 'NO'>();
  let settledMarkets = 0;
  let skippedMarkets = 0;
  let realizedPnlUsd = 0;
  let proceedsUsd = 0;

  for (const market of graph.markets) {
    const positions = deps.portfolio.positionsForMarket(market.id);
    if (positions.length === 0) continue;

    const winner = inferWinner(
      deps.store.midPrice(market.tokens.yesTokenId),
      positions,
      options.force ?? false,
    );
    if (!winner) {
      skippedMarkets += 1;
      continue;
    }

    const costBasis = sum(positions.map((p) => p.costBasis));
    const delta = deps.portfolio.settleMarket(market.id, winner, deps.store);
    realizedPnlUsd = add(realizedPnlUsd, delta);
    proceedsUsd = add(proceedsUsd, add(costBasis, delta));
    winnerByMarket.set(market.id, winner);
    settledMarkets += 1;
  }

  // Only close per-trade records once every held market settled; otherwise
  // realized PnL would be computed from an incomplete winner map.
  const closedTrades =
    skippedMarkets === 0
      ? (deps.arbTradePnl?.closeTradesForEvent(graph.eventId, winnerByMarket) ?? [])
      : [];

  return {
    settledMarkets,
    skippedMarkets,
    realizedPnlUsd,
    proceedsUsd,
    winnerByMarket,
    closedTrades,
  };
}

function inferWinner(
  yesPrice: number | null,
  positions: Position[],
  force: boolean,
): 'YES' | 'NO' | null {
  if (yesPrice != null) {
    return yesPrice >= 0.5 ? 'YES' : 'NO';
  }

  const yesSize = sum(positions.filter((p) => p.outcome === 'YES').map((p) => p.size));
  const noSize = sum(positions.filter((p) => p.outcome === 'NO').map((p) => p.size));

  // Matched pair: payout is $1 per share pair whichever side wins, so the
  // choice of winner does not change realized PnL.
  if (yesSize > 0 && noSize > 0 && Math.abs(yesSize - noSize) < 1e-6) {
    return 'YES';
  }

  if (force) {
    // Last resort with no price data: settle toward the larger holding.
    // This can be optimistic, but leaving the position open forever is worse.
    return yesSize >= noSize ? 'YES' : 'NO';
  }

  return null;
}
