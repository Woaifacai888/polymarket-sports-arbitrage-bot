import type { EventGraph, Leg, Opportunity, OrderRecord } from '../config/types.js';
import { getLogger } from '../util/logger.js';
import { roundToTick, sleep } from '../util/math.js';
import { withRetry } from '../util/rateLimiter.js';
import type { ExecutionEngine } from './executor.js';

const log = () => getLogger();

export interface OrderManagerOptions {
  placeRetries?: number;
  /** After partial placement failure, cancel already-placed legs. */
  rollbackOnFailure?: boolean;
}

export class OrderManager {
  private readonly inFlight = new Set<string>();
  private readonly gameStartHandled = new Set<string>();
  private readonly placeRetries: number;
  private readonly rollbackOnFailure: boolean;

  constructor(
    private readonly engine: ExecutionEngine,
    options: OrderManagerOptions = {},
  ) {
    this.placeRetries = options.placeRetries ?? 2;
    this.rollbackOnFailure = options.rollbackOnFailure ?? true;
  }

  /**
   * Taker-only execution: every leg of the package is placed immediately at
   * its detected (ask-side) price, so the arb is captured atomically as soon
   * as it is discovered — no resting maker legs, no legging risk.
   */
  async executeOpportunity(
    opportunity: Opportunity,
    metaByMarket: Map<string, { tickSize: number; negRisk: boolean }>,
  ): Promise<boolean> {
    if (this.inFlight.has(opportunity.id)) return false;
    this.inFlight.add(opportunity.id);
    opportunity.status = 'placing';

    const placed: OrderRecord[] = [];

    try {
      for (const leg of opportunity.legs) {
        if (!metaByMarket.has(leg.marketId)) {
          throw new Error(`Missing market metadata for ${leg.marketId}`);
        }
      }

      for (const leg of opportunity.legs) {
        const order = await this.placeTakerLeg(leg, metaByMarket, opportunity.id);
        placed.push(order);
      }

      // Placed successfully — fills arrive async via WS / sim loop
      opportunity.status = placed.every((o) => o.status === 'filled') ? 'filled' : 'partial';
      return true;
    } catch (error) {
      opportunity.status = 'rejected';
      log().error(
        { error, opportunityId: opportunity.id, placed: placed.length },
        'Order execution failed',
      );

      if (this.rollbackOnFailure && placed.length > 0) {
        await this.rollback(placed);
      }
      return false;
    } finally {
      this.inFlight.delete(opportunity.id);
    }
  }

  private async placeTakerLeg(
    leg: Leg,
    metaByMarket: Map<string, { tickSize: number; negRisk: boolean }>,
    opportunityId: string,
  ): Promise<OrderRecord> {
    const meta = metaByMarket.get(leg.marketId)!;
    const tickSize = meta.tickSize > 0 ? meta.tickSize : 0.01;
    const roundedPrice = roundToTick(leg.price, tickSize);
    // Stay on the buyable side of the tick for BUY limits
    const price =
      leg.side === 'BUY' && roundedPrice < leg.price - 1e-12
        ? roundToTick(leg.price + tickSize / 2, tickSize)
        : roundedPrice;

    return withRetry(
      () =>
        this.engine.placeOrder({
          leg: { ...leg, price: Math.min(0.99, Math.max(0.01, price)) },
          tickSize,
          negRisk: meta.negRisk,
          opportunityId,
        }),
      this.placeRetries,
      250,
    );
  }

  private async rollback(placed: OrderRecord[]): Promise<void> {
    log().warn({ count: placed.length }, 'Rolling back partially placed multi-leg package');
    for (const order of placed) {
      try {
        if (order.status === 'open' || order.status === 'partial') {
          await this.engine.cancelOrder(order.id);
        }
      } catch (error) {
        log().error({ error, orderId: order.id }, 'Rollback cancel failed');
      }
      await sleep(50);
    }
  }

  async cancelAllAtGameStart(event: EventGraph): Promise<void> {
    if (!event.gameStartTime) return;
    if (this.gameStartHandled.has(event.eventId)) return;

    const now = Date.now();
    const startMs = event.gameStartTime.getTime();

    // No upper time bound: if the bot was paused/busy/restarted and missed
    // kickoff, stale resting orders must still be cancelled whenever the
    // next tick lands — not only within the first few minutes.
    if (now < startMs) return;

    // Cancel only open orders tied to this event's markets when possible
    const marketIds = new Set(event.markets.map((m) => m.id));
    const open = this.engine.getOpenOrders().filter((o) => marketIds.has(o.marketId));
    if (open.length === 0) {
      this.gameStartHandled.add(event.eventId);
      return;
    }

    for (const order of open) {
      try {
        await this.engine.cancelOrder(order.id);
      } catch (error) {
        log().error({ error, orderId: order.id }, 'Game-start cancel failed');
      }
    }
    this.gameStartHandled.add(event.eventId);
    log().warn({ event: event.slug, cancelled: open.length }, 'Cancelled event orders at game start');
  }

  isInFlight(opportunityId: string): boolean {
    return this.inFlight.has(opportunityId);
  }
}
