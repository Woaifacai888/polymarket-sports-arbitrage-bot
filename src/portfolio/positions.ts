import type { FillEvent, PortfolioSnapshot, Position } from '../config/types.js';
import type { OrderBookStore } from '../data/orderBook.js';
import { add, mul, sub } from '../util/math.js';

export interface PortfolioAttribution {
  byMarket: Map<string, { realized: number; costBasis: number; size: number }>;
  positionCount: number;
  winningShares: number;
  losingShares: number;
}

export class PortfolioTracker {
  private balance: number;
  private readonly positions = new Map<string, Position>();
  private realizedPnl = 0;
  private readonly pnlHistory: Array<{ t: number; pnl: number }> = [];
  private lastRealizedDelta = 0;
  private readonly realizedByMarket = new Map<string, number>();

  constructor(initialBalance: number) {
    this.balance = initialBalance;
    this.pnlHistory.push({ t: Date.now(), pnl: 0 });
  }

  setBalance(balance: number): void {
    this.balance = balance;
  }

  getBalance(): number {
    return this.balance;
  }

  getRealizedPnl(): number {
    return this.realizedPnl;
  }

  /** Delta from the most recent fill that changed realized PnL (for risk kill-switch). */
  consumeLastRealizedDelta(): number {
    const d = this.lastRealizedDelta;
    this.lastRealizedDelta = 0;
    return d;
  }

  applyFill(fill: FillEvent): void {
    const key = fill.tokenId;
    const existing = this.positions.get(key);
    const cost = mul(fill.price, fill.size);
    const outcome = fill.outcome ?? existing?.outcome ?? 'YES';

    if (fill.side === 'BUY') {
      this.balance = sub(this.balance, cost);
      if (existing) {
        const newSize = add(existing.size, fill.size);
        const newCost = add(existing.costBasis, cost);
        existing.size = newSize;
        existing.costBasis = newCost;
        existing.avgPrice = newCost / newSize;
        existing.outcome = outcome;
      } else {
        this.positions.set(key, {
          tokenId: fill.tokenId,
          marketId: fill.marketId,
          outcome,
          size: fill.size,
          avgPrice: fill.price,
          costBasis: cost,
        });
      }
    } else {
      this.balance = add(this.balance, cost);
      if (existing) {
        const sellSize = Math.min(fill.size, existing.size);
        const pnl = sub(mul(sellSize, fill.price), mul(sellSize, existing.avgPrice));
        this.realizedPnl = add(this.realizedPnl, pnl);
        this.lastRealizedDelta = add(this.lastRealizedDelta, pnl);
        this.realizedByMarket.set(
          fill.marketId,
          add(this.realizedByMarket.get(fill.marketId) ?? 0, pnl),
        );
        existing.size = sub(existing.size, sellSize);
        existing.costBasis = mul(existing.size, existing.avgPrice);
        if (existing.size <= 0) this.positions.delete(key);
      }
    }

    this.recordPnlPoint(undefined);
  }

  /**
   * Resolve a market at settlement: winning outcome pays $1, losing pays $0.
   * Returns realized PnL delta from the settlement.
   */
  settleMarket(
    marketId: string,
    winningOutcome: 'YES' | 'NO',
    store?: OrderBookStore,
  ): number {
    let delta = 0;
    for (const [tokenId, pos] of [...this.positions.entries()]) {
      if (pos.marketId !== marketId) continue;
      const payout = pos.outcome === winningOutcome ? 1 : 0;
      const proceeds = mul(pos.size, payout);
      const pnl = sub(proceeds, pos.costBasis);
      this.balance = add(this.balance, proceeds);
      this.realizedPnl = add(this.realizedPnl, pnl);
      this.lastRealizedDelta = add(this.lastRealizedDelta, pnl);
      this.realizedByMarket.set(marketId, add(this.realizedByMarket.get(marketId) ?? 0, pnl));
      delta = add(delta, pnl);
      this.positions.delete(tokenId);
      void store;
    }
    this.recordPnlPoint(store);
    return delta;
  }

  attribution(): PortfolioAttribution {
    const byMarket = new Map<string, { realized: number; costBasis: number; size: number }>();
    for (const [marketId, realized] of this.realizedByMarket) {
      byMarket.set(marketId, { realized, costBasis: 0, size: 0 });
    }
    for (const pos of this.positions.values()) {
      const row = byMarket.get(pos.marketId) ?? { realized: 0, costBasis: 0, size: 0 };
      row.costBasis = add(row.costBasis, pos.costBasis);
      row.size = add(row.size, pos.size);
      byMarket.set(pos.marketId, row);
    }
    return {
      byMarket,
      positionCount: this.positions.size,
      winningShares: 0,
      losingShares: 0,
    };
  }

  snapshot(store: OrderBookStore): PortfolioSnapshot {
    let unrealized = 0;
    let exposure = 0;

    for (const pos of this.positions.values()) {
      exposure = add(exposure, pos.costBasis);
      const mark = store.midPrice(pos.tokenId) ?? pos.avgPrice;
      unrealized = add(unrealized, sub(mul(pos.size, mark), pos.costBasis));
    }

    const totalPnl = add(this.realizedPnl, unrealized);
    this.recordPnlPoint(store, totalPnl);

    return {
      balance: this.balance,
      positions: [...this.positions.values()],
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      totalPnl,
      exposure,
      pnlHistory: [...this.pnlHistory],
    };
  }

  private recordPnlPoint(store?: OrderBookStore, totalOverride?: number): void {
    let total = totalOverride;
    if (total == null) {
      let unrealized = 0;
      if (store) {
        for (const pos of this.positions.values()) {
          const mark = store.midPrice(pos.tokenId) ?? pos.avgPrice;
          unrealized = add(unrealized, sub(mul(pos.size, mark), pos.costBasis));
        }
      }
      total = add(this.realizedPnl, unrealized);
    }

    const last = this.pnlHistory[this.pnlHistory.length - 1];
    if (!last || Date.now() - last.t > 1000) {
      this.pnlHistory.push({ t: Date.now(), pnl: total });
      if (this.pnlHistory.length > 300) this.pnlHistory.shift();
    } else {
      last.pnl = total;
      last.t = Date.now();
    }
  }
}
