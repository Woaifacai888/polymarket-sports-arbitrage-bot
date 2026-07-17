import type { FillEvent, Side } from '../config/types.js';
import { add, mul, sub, takerFeeUsd } from '../util/math.js';

export interface FillCostBreakdown {
  grossUsd: number;
  feeUsd: number;
  allInUsd: number;
}

/**
 * All-in cost of a fill under Polymarket's real fee policy:
 * fee = shares × feeRate × p × (1 − p), charged to takers only.
 * `feeRateBps` is the category taker fee rate in bps (sports = 500).
 */
export function computeFillCosts(
  price: number,
  size: number,
  side: Side,
  feeRateBps: number,
): FillCostBreakdown {
  const grossUsd = mul(price, size);
  const feeUsd = takerFeeUsd(price, size, feeRateBps);
  const allInUsd = side === 'BUY' ? add(grossUsd, feeUsd) : sub(grossUsd, feeUsd);
  return { grossUsd, feeUsd, allInUsd };
}

export function enrichFill(fill: FillEvent, feeRateBps: number, opportunityId?: string): FillEvent {
  const costs = computeFillCosts(fill.price, fill.size, fill.side, feeRateBps);
  return {
    ...fill,
    opportunityId: fill.opportunityId ?? opportunityId,
    feeUsd: fill.feeUsd ?? costs.feeUsd,
    allInCostUsd: fill.allInCostUsd ?? costs.allInUsd,
  };
}
