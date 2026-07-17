import type { FillEvent, Opportunity } from '../config/types.js';
import type { OrderBookStore } from '../data/orderBook.js';
import { LOCKED_ARB_RELATIONS } from '../risk/stakeSizer.js';
import { add, mul, sub, sum } from '../util/math.js';

export interface TradeLegPnl {
  tokenId: string;
  marketId: string;
  side: FillEvent['side'];
  outcome?: FillEvent['outcome'];
  price: number;
  size: number;
  grossUsd: number;
  feeUsd: number;
  allInUsd: number;
}

export interface TradePnlSnapshot {
  opportunityId: string;
  relation: Opportunity['relation'];
  eventId: string;
  eventTitle: string;
  description: string;
  netEdge: number;
  grossEdge: number;
  legFills: TradeLegPnl[];
  grossEntryUsd: number;
  feeUsd: number;
  allInEntryUsd: number;
  sharesPerLeg: number;
  lockedPayoutUsd?: number;
  lockedProfitUsd?: number;
  expectedProfitUsd?: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  totalPnlUsd: number;
  status: 'partial' | 'open' | 'closed';
}

interface PendingTrade {
  opportunity: Opportunity;
  fills: FillEvent[];
}

export class ArbTradePnlTracker {
  private readonly pending = new Map<string, PendingTrade>();

  registerPlacement(opportunity: Opportunity): void {
    this.pending.set(opportunity.id, { opportunity, fills: [] });
  }

  onFill(fill: FillEvent, store: OrderBookStore): TradePnlSnapshot | null {
    const oppId = fill.opportunityId;
    if (!oppId) return null;

    const pending = this.pending.get(oppId);
    if (!pending) return null;

    pending.fills.push(fill);
    const complete = isPackageComplete(pending.opportunity, pending.fills);
    return computeTradePnl(pending.opportunity, pending.fills, store, complete);
  }

  closeTrade(opportunityId: string, realizedPnlUsd: number): TradePnlSnapshot | null {
    const pending = this.pending.get(opportunityId);
    if (!pending || pending.fills.length === 0) return null;

    const snapshot = computeTradePnl(pending.opportunity, pending.fills, null, true);
    if (!snapshot) return null;

    snapshot.status = 'closed';
    snapshot.realizedPnlUsd = realizedPnlUsd;
    snapshot.unrealizedPnlUsd = 0;
    snapshot.totalPnlUsd = realizedPnlUsd;
    this.pending.delete(opportunityId);
    return snapshot;
  }

  /**
   * Close and remove all pending trades for a settled event. Realized PnL per
   * trade is computed from its fills against the settlement winners:
   * winning shares pay $1, losing shares pay $0, entry cost is fee-inclusive.
   * Zero-fill placements are dropped without producing a snapshot.
   */
  closeTradesForEvent(
    eventId: string,
    winnerByMarket: Map<string, 'YES' | 'NO'>,
  ): TradePnlSnapshot[] {
    const closed: TradePnlSnapshot[] = [];

    for (const [oppId, pending] of [...this.pending.entries()]) {
      if (pending.opportunity.eventId !== eventId) continue;

      if (pending.fills.length === 0) {
        this.pending.delete(oppId);
        continue;
      }

      let realized = 0;
      for (const fill of pending.fills) {
        if (fill.side !== 'BUY') continue; // SELL PnL realized at sale time
        const winner = winnerByMarket.get(fill.marketId);
        if (!winner) continue;
        const payout = fill.outcome === winner ? fill.size : 0;
        const allIn = fill.allInCostUsd ?? mul(fill.price, fill.size);
        realized = add(realized, sub(payout, allIn));
      }

      const snapshot = this.closeTrade(oppId, realized);
      if (snapshot) closed.push(snapshot);
    }

    return closed;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

function isPackageComplete(opportunity: Opportunity, fills: FillEvent[]): boolean {
  const filledByToken = aggregateFillsByToken(fills);
  return opportunity.legs.every((leg) => {
    const filled = filledByToken.get(leg.tokenId) ?? 0;
    return filled >= leg.size - 1e-6;
  });
}

function aggregateFillsByToken(fills: FillEvent[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const fill of fills) {
    map.set(fill.tokenId, add(map.get(fill.tokenId) ?? 0, fill.size));
  }
  return map;
}

export function computeTradePnl(
  opportunity: Opportunity,
  fills: FillEvent[],
  store: OrderBookStore | null,
  complete: boolean,
): TradePnlSnapshot | null {
  if (fills.length === 0) return null;

  const legFills: TradeLegPnl[] = fills.map((fill) => {
    const grossUsd = mul(fill.price, fill.size);
    const feeUsd = fill.feeUsd ?? 0;
    const allInUsd = fill.allInCostUsd ?? grossUsd;
    return {
      tokenId: fill.tokenId,
      marketId: fill.marketId,
      side: fill.side,
      outcome: fill.outcome,
      price: fill.price,
      size: fill.size,
      grossUsd,
      feeUsd,
      allInUsd,
    };
  });

  const grossEntryUsd = sum(legFills.map((leg) => leg.grossUsd));
  const feeUsd = sum(legFills.map((leg) => leg.feeUsd));
  const allInEntryUsd = sum(legFills.map((leg) => leg.allInUsd));

  const filledByToken = aggregateFillsByToken(fills);
  const filledSizes = opportunity.legs
    .filter((leg) => (filledByToken.get(leg.tokenId) ?? 0) > 0)
    .map((leg) => filledByToken.get(leg.tokenId) ?? 0);
  const sharesPerLeg = filledSizes.length > 0 ? Math.min(...filledSizes) : 0;

  let unrealizedPnlUsd = 0;
  if (store) {
    for (const fill of fills) {
      const mark = store.midPrice(fill.tokenId) ?? fill.price;
      const allIn = fill.allInCostUsd ?? mul(fill.price, fill.size);
      if (fill.side === 'BUY') {
        unrealizedPnlUsd = add(unrealizedPnlUsd, sub(mul(fill.size, mark), allIn));
      } else {
        unrealizedPnlUsd = add(unrealizedPnlUsd, sub(allIn, mul(fill.size, mark)));
      }
    }
  }

  let lockedPayoutUsd: number | undefined;
  let lockedProfitUsd: number | undefined;
  let expectedProfitUsd: number | undefined;

  if (LOCKED_ARB_RELATIONS.includes(opportunity.relation) && complete && sharesPerLeg > 0) {
    lockedPayoutUsd = sharesPerLeg;
    lockedProfitUsd = sub(lockedPayoutUsd, allInEntryUsd);
    expectedProfitUsd = mul(opportunity.netEdge, sharesPerLeg);
  }

  const status: TradePnlSnapshot['status'] = complete ? 'open' : 'partial';
  const totalPnlUsd =
    complete && lockedProfitUsd != null ? lockedProfitUsd : unrealizedPnlUsd;

  return {
    opportunityId: opportunity.id,
    relation: opportunity.relation,
    eventId: opportunity.eventId,
    eventTitle: opportunity.eventTitle,
    description: opportunity.description,
    netEdge: opportunity.netEdge,
    grossEdge: opportunity.grossEdge,
    legFills,
    grossEntryUsd,
    feeUsd,
    allInEntryUsd,
    sharesPerLeg,
    lockedPayoutUsd,
    lockedProfitUsd,
    expectedProfitUsd,
    unrealizedPnlUsd,
    realizedPnlUsd: 0,
    totalPnlUsd,
    status,
  };
}
