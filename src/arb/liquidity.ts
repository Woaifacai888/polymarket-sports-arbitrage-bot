import type { Leg, Opportunity } from '../config/types.js';
import type { OrderBookStore } from '../data/orderBook.js';

export interface LiquidityCheckResult {
  ok: boolean;
  reason?: string;
  /** VWAP-adjusted max fillable share count across all legs (min). */
  maxFillableShares: number;
}

/**
 * Depth-aware fillability: each BUY leg must have enough ask depth at or below
 * the limit price for the requested size. Caps size to book-available shares.
 */
export function checkOpportunityLiquidity(
  opportunity: Opportunity,
  store: OrderBookStore,
): LiquidityCheckResult {
  let maxFillableShares = Number.POSITIVE_INFINITY;

  for (const leg of opportunity.legs) {
    if (leg.side !== 'BUY') continue;

    const depth = depthAtOrBelow(store, leg.tokenId, leg.price);
    if (depth <= 0) {
      return {
        ok: false,
        reason: `No ask depth at/below ${leg.price.toFixed(3)} for ${leg.tokenId.slice(0, 8)}`,
        maxFillableShares: 0,
      };
    }

    maxFillableShares = Math.min(maxFillableShares, depth);

    const quote = store.costToBuy(leg.tokenId, leg.size);
    if (!quote) {
      return {
        ok: false,
        reason: `Insufficient depth to buy ${leg.size} of ${leg.tokenId.slice(0, 8)}`,
        maxFillableShares: depth,
      };
    }

    // Reject if VWAP blows through limit by more than 1 tick-ish (1%)
    if (quote.avgPrice > leg.price * 1.01) {
      return {
        ok: false,
        reason: `VWAP ${quote.avgPrice.toFixed(3)} exceeds limit ${leg.price.toFixed(3)}`,
        maxFillableShares: depth,
      };
    }
  }

  if (!Number.isFinite(maxFillableShares)) maxFillableShares = 0;

  return { ok: true, maxFillableShares };
}

export function depthAtOrBelow(store: OrderBookStore, tokenId: string, maxPrice: number): number {
  const book = store.get(tokenId);
  if (!book) return 0;
  return book.asks.filter((l) => l.price <= maxPrice + 1e-9).reduce((acc, l) => acc + l.size, 0);
}

export function isBookFresh(
  store: OrderBookStore,
  legs: Leg[],
  maxAgeMs: number,
  now = Date.now(),
): { fresh: boolean; reason?: string } {
  for (const leg of legs) {
    const book = store.get(leg.tokenId);
    if (!book) {
      return { fresh: false, reason: `Missing book for ${leg.tokenId.slice(0, 8)}` };
    }
    if (now - book.updatedAt > maxAgeMs) {
      return {
        fresh: false,
        reason: `Stale book (${now - book.updatedAt}ms) for ${leg.tokenId.slice(0, 8)}`,
      };
    }
  }
  return { fresh: true };
}

/** Clamp all leg sizes to available depth so placement is more likely to fill. */
export function clampLegsToLiquidity(
  opportunity: Opportunity,
  store: OrderBookStore,
): Opportunity {
  const check = checkOpportunityLiquidity(opportunity, store);
  if (check.maxFillableShares <= 0) return opportunity;

  const sized = Math.floor(Math.min(...opportunity.legs.map((l) => l.size), check.maxFillableShares));
  if (sized >= opportunity.legs[0]?.size) return opportunity;

  return {
    ...opportunity,
    legs: opportunity.legs.map((leg) => ({ ...leg, size: Math.max(1, sized) })),
  };
}
