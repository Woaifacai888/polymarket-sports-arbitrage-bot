import type { FillEvent, Side } from '../config/types.js';
import { add, bpsToDecimal, mul, sub } from '../util/math.js';

export interface FillCostBreakdown {
  grossUsd: number;
  feeUsd: number;
  allInUsd: number;
}

export function computeFillCosts(
  price: number,
  size: number,
  side: Side,
  feeBps: number,
): FillCostBreakdown {
  const grossUsd = mul(price, size);
  const feeUsd = mul(grossUsd, bpsToDecimal(feeBps));
  const allInUsd = side === 'BUY' ? add(grossUsd, feeUsd) : sub(grossUsd, feeUsd);
  return { grossUsd, feeUsd, allInUsd };
}

export function enrichFill(fill: FillEvent, feeBps: number, opportunityId?: string): FillEvent {
  const costs = computeFillCosts(fill.price, fill.size, fill.side, feeBps);
  return {
    ...fill,
    opportunityId: fill.opportunityId ?? opportunityId,
    feeUsd: fill.feeUsd ?? costs.feeUsd,
    allInCostUsd: fill.allInCostUsd ?? costs.allInUsd,
  };
}
