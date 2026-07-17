import type { Config } from '../config/types.js';
import type { FillEvent, OrderRecord } from '../config/types.js';
import type { OrderBookStore } from '../data/orderBook.js';
import { computeFillCosts } from '../portfolio/fillCosts.js';
import { getLogger } from '../util/logger.js';
import { add, mul, uuid } from '../util/math.js';
import type { ExecutionEngine, PlaceOrderRequest } from './executor.js';

const log = () => getLogger();

export class SimExecutor implements ExecutionEngine {
  readonly mode = 'sim' as const;
  private balance: number;
  private readonly orders = new Map<string, OrderRecord>();
  private fillCallbacks: Array<(fill: FillEvent) => void> = [];
  private readonly feeBps: number;

  constructor(config: Config, private readonly store: OrderBookStore) {
    this.balance = config.simInitialBalance;
    this.feeBps = config.feeBps;
  }

  onFill(callback: (fill: FillEvent) => void): void {
    this.fillCallbacks.push(callback);
  }

  getBalance(): number {
    return this.balance;
  }

  /** Add settlement payouts (or other external cash) to the sim balance. */
  credit(amountUsd: number): void {
    this.balance = add(this.balance, amountUsd);
  }

  getOpenOrders(): OrderRecord[] {
    return [...this.orders.values()].filter((o) => o.status === 'open' || o.status === 'partial');
  }

  getOrder(orderId: string): OrderRecord | undefined {
    return this.orders.get(orderId);
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderRecord> {
    const { leg } = request;
    const order: OrderRecord = {
      id: uuid(),
      tokenId: leg.tokenId,
      marketId: leg.marketId,
      side: leg.side,
      price: leg.price,
      size: leg.size,
      filledSize: 0,
      status: 'open',
      createdAt: Date.now(),
      opportunityId: request.opportunityId,
      outcome: leg.outcome,
    };

    this.orders.set(order.id, order);
    this.tryFill(order);
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (order && (order.status === 'open' || order.status === 'partial')) {
      order.status = 'cancelled';
    }
  }

  async cancelAll(): Promise<void> {
    for (const order of this.orders.values()) {
      if (order.status === 'open' || order.status === 'partial') {
        order.status = 'cancelled';
      }
    }
  }

  processRestingOrders(): void {
    for (const order of this.getOpenOrders()) {
      this.tryFill(order);
    }
  }

  private tryFill(order: OrderRecord): void {
    if (order.side !== 'BUY') return;

    const book = this.store.get(order.tokenId);
    if (!book || book.asks.length === 0) return;

    const remaining = order.size - order.filledSize;
    if (remaining <= 0) return;

    // Walk the book like a real exchange: fill only against levels at or
    // below the limit price, up to available depth (partial fills allowed).
    let cost = 0;
    let filled = 0;
    for (const level of book.asks) {
      if (level.price > order.price + 1e-9) break;
      const take = Math.min(remaining - filled, level.size);
      cost = add(cost, mul(take, level.price));
      filled += take;
      if (filled >= remaining) break;
    }
    if (filled <= 0) return;

    const vwap = cost / filled;
    const { feeUsd, allInUsd } = computeFillCosts(vwap, filled, order.side, this.feeBps);
    if (allInUsd > this.balance) {
      log().warn({ orderId: order.id, allInUsd, balance: this.balance }, 'Sim insufficient balance');
      order.status = 'cancelled';
      return;
    }

    // Deplete the book so the same liquidity can't be bought twice.
    this.store.consumeAsks(order.tokenId, filled);

    this.balance = add(this.balance, -allInUsd);
    order.filledSize += filled;
    order.status = order.filledSize >= order.size ? 'filled' : 'partial';

    const fill: FillEvent = {
      orderId: order.id,
      tokenId: order.tokenId,
      marketId: order.marketId,
      side: order.side,
      price: vwap,
      size: filled,
      timestamp: Date.now(),
      mode: 'sim',
      outcome: order.outcome,
      opportunityId: order.opportunityId,
      feeUsd,
      allInCostUsd: allInUsd,
    };

    for (const cb of this.fillCallbacks) cb(fill);
    log().info({ fill, balance: this.balance }, 'Sim fill');
  }
}
