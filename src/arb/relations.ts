import type { ClassifiedMarket, Leg } from '../config/types.js';
import type { OrderBookStore } from '../data/orderBook.js';
import { marketSubjectKey } from '../model/marketClassifier.js';
import { add, applySlippage, bpsToDecimal, clamp, sub, sum, takerFeeUsd } from '../util/math.js';
import type { RelationContext, RelationViolation } from './types.js';

const LINE_EPSILON = 1e-9;

/** Ladder rungs must measure the same quantity; group by line-stripped question. */
function groupBySubject(markets: ClassifiedMarket[]): ClassifiedMarket[][] {
  const groups = new Map<string, ClassifiedMarket[]>();
  for (const market of markets) {
    const key = marketSubjectKey(market.question);
    const group = groups.get(key);
    if (group) group.push(market);
    else groups.set(key, [market]);
  }
  return [...groups.values()];
}

function buyLeg(
  market: ClassifiedMarket,
  outcome: 'YES' | 'NO',
  price: number,
  size: number,
): Leg {
  const tokenId = outcome === 'YES' ? market.tokens.yesTokenId : market.tokens.noTokenId;
  return {
    tokenId,
    marketId: market.id,
    side: 'BUY',
    price,
    size,
    outcome,
  };
}

function getAsk(store: OrderBookStore, market: ClassifiedMarket, outcome: 'YES' | 'NO'): number | null {
  const tokenId = outcome === 'YES' ? market.tokens.yesTokenId : market.tokens.noTokenId;
  return store.bestAsk(tokenId);
}

interface PricedLeg {
  market: ClassifiedMarket;
  price: number;
}

/**
 * Net edge per share-package after Polymarket taker fees and slippage.
 *
 * Fees use the real fee curve fee = rate × p × (1 − p) per leg (taker-only,
 * per official fee policy: sports rate 0.05). The rate comes from each
 * market's Gamma feeSchedule when present, else ctx.feeBps. This replaces the
 * old flat percent-of-notional model, which underestimated fees ~5x at
 * mid-range prices — e.g. YES 0.48 + NO 0.51 costs ~2.5c/pair in real fees,
 * so a 1c gross edge is a guaranteed loss the flat model would have traded.
 */
function netEdgeForLegs(legs: PricedLeg[], payout: number, ctx: RelationContext): number {
  const slippageMultiplier = 1 + bpsToDecimal(ctx.slippageBps);
  const cost = sum(legs.map((l) => l.price)) * slippageMultiplier;
  const fees = sum(
    legs.map((l) => takerFeeUsd(l.price, 1, l.market.takerFeeRateBps ?? ctx.feeBps)),
  );
  return sub(payout, add(cost, fees));
}

export function checkComplementaryPair(
  store: OrderBookStore,
  market: ClassifiedMarket,
  ctx: RelationContext,
): RelationViolation | null {
  const yesAsk = getAsk(store, market, 'YES');
  const noAsk = getAsk(store, market, 'NO');
  if (yesAsk == null || noAsk == null) return null;

  const totalCost = yesAsk + noAsk;
  const grossEdge = sub(1, totalCost);
  const netEdge = netEdgeForLegs(
    [
      { market, price: yesAsk },
      { market, price: noAsk },
    ],
    1,
    ctx,
  );
  if (netEdge < ctx.minNetEdge) return null;

  const size = clamp(ctx.maxLegSize, 1, 100);
  return {
    relation: 'complementary_pair',
    description: `YES+NO ask sum ${totalCost.toFixed(3)} < 1 on ${market.question.slice(0, 40)}`,
    legs: [
      buyLeg(market, 'YES', yesAsk, size),
      buyLeg(market, 'NO', noAsk, size),
    ],
    grossEdge,
    netEdge,
  };
}

export function checkTotalsLadder(
  store: OrderBookStore,
  markets: ClassifiedMarket[],
  ctx: RelationContext,
): RelationViolation | null {
  // Only Over-side markets share YES monotonicity; Under is inverse and
  // cross-subject rungs (team totals vs match totals) are not comparable.
  const totals = markets.filter(
    (m) => m.type === 'total' && m.line != null && m.side !== 'under',
  );

  for (const group of groupBySubject(totals)) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

    for (let i = 0; i < sorted.length - 1; i++) {
      const lower = sorted[i];
      const higher = sorted[i + 1];
      // Equal lines = duplicate/parallel markets, not a ladder rung.
      if ((higher.line ?? 0) - (lower.line ?? 0) < LINE_EPSILON) continue;

      const lowerAsk = getAsk(store, lower, 'YES');
      const higherAsk = getAsk(store, higher, 'YES');
      if (lowerAsk == null || higherAsk == null) continue;

      // P(Over lower line) should be >= P(Over higher line)
      if (lowerAsk + 0.001 < higherAsk) {
        const higherNoAsk = getAsk(store, higher, 'NO');
        if (higherNoAsk == null) continue;

        const size = clamp(ctx.maxLegSize, 1, 100);
        // Edge from raw asks (fee+slippage applied once in netEdgeForLegs);
        // limit prices carry the slippage buffer to improve fill odds.
        const rawCost = lowerAsk + higherNoAsk;
        const grossEdge = sub(1, rawCost);
        const netEdge = netEdgeForLegs(
          [
            { market: lower, price: lowerAsk },
            { market: higher, price: higherNoAsk },
          ],
          1,
          ctx,
        );
        if (netEdge < ctx.minNetEdge) continue;

        const buyPrice = applySlippage(lowerAsk, ctx.slippageBps, 'BUY');
        const hedgePrice = applySlippage(higherNoAsk, ctx.slippageBps, 'BUY');
        return {
          relation: 'totals_ladder',
          description: `Totals inversion: Over ${lower.line} (${lowerAsk.toFixed(3)}) < Over ${higher.line} (${higherAsk.toFixed(3)})`,
          legs: [
            buyLeg(lower, 'YES', buyPrice, size),
            buyLeg(higher, 'NO', hedgePrice, size),
          ],
          grossEdge,
          netEdge,
        };
      }
    }
  }
  return null;
}

export function checkSpreadLadder(
  store: OrderBookStore,
  markets: ClassifiedMarket[],
  ctx: RelationContext,
): RelationViolation | null {
  const spreads = markets.filter((m) => m.type === 'spread' && m.line != null);

  for (const group of groupBySubject(spreads)) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

    for (let i = 0; i < sorted.length - 1; i++) {
      const easier = sorted[i];
      const harder = sorted[i + 1];
      // Equal lines = duplicate/parallel markets, not a ladder rung.
      if ((harder.line ?? 0) - (easier.line ?? 0) < LINE_EPSILON) continue;

      const easierAsk = getAsk(store, easier, 'YES');
      const harderAsk = getAsk(store, harder, 'YES');
      if (easierAsk == null || harderAsk == null) continue;

      if (easierAsk + 0.001 < harderAsk) {
        const easierNoAsk = getAsk(store, easier, 'NO');
        if (easierNoAsk == null) continue;

        const size = clamp(ctx.maxLegSize, 1, 100);
        const rawCost = harderAsk + easierNoAsk;
        const grossEdge = sub(1, rawCost);
        const netEdge = netEdgeForLegs(
          [
            { market: harder, price: harderAsk },
            { market: easier, price: easierNoAsk },
          ],
          1,
          ctx,
        );
        if (netEdge < ctx.minNetEdge) continue;

        const buyPrice = applySlippage(harderAsk, ctx.slippageBps, 'BUY');
        const hedgePrice = applySlippage(easierNoAsk, ctx.slippageBps, 'BUY');
        return {
          relation: 'spread_ladder',
          description: `Spread inversion: ${easier.line} (${easierAsk.toFixed(3)}) < ${harder.line} (${harderAsk.toFixed(3)})`,
          legs: [
            buyLeg(harder, 'YES', buyPrice, size),
            buyLeg(easier, 'NO', hedgePrice, size),
          ],
          grossEdge,
          netEdge,
        };
      }
    }
  }
  return null;
}

export function checkMoneylineSpread(
  store: OrderBookStore,
  moneylines: ClassifiedMarket[],
  spreads: ClassifiedMarket[],
  ctx: RelationContext,
): RelationViolation | null {
  if (moneylines.length === 0 || spreads.length === 0) return null;

  const ml = moneylines[0];
  // Only a zero-line spread is equivalent to the moneyline. A -7.5 spread is
  // a different bet — comparing it to ML is not an arbitrage.
  const sp = spreads.find((s) => s.line === 0);
  if (!sp) return null;

  const mlAsk = getAsk(store, ml, 'YES');
  const spAsk = getAsk(store, sp, 'YES');
  if (mlAsk == null || spAsk == null) return null;

  const diff = Math.abs(mlAsk - spAsk);
  if (diff <= 0.02) return null;

  const cheaper = mlAsk < spAsk ? ml : sp;
  const expensive = mlAsk < spAsk ? sp : ml;
  const cheapAsk = getAsk(store, cheaper, 'YES');
  const expensiveNoAsk = getAsk(store, expensive, 'NO');
  if (cheapAsk == null || expensiveNoAsk == null) return null;

  // Near-equivalent markets: buy cheap YES + expensive NO when package costs < $1.
  const size = clamp(ctx.maxLegSize, 1, 100);
  const buyPrice = applySlippage(cheapAsk, ctx.slippageBps, 'BUY');
  const hedgePrice = applySlippage(expensiveNoAsk, ctx.slippageBps, 'BUY');
  const totalCost = buyPrice + hedgePrice;
  const grossEdge = sub(1, totalCost);
  const netEdge = netEdgeForLegs(
    [
      { market: cheaper, price: buyPrice },
      { market: expensive, price: hedgePrice },
    ],
    1,
    ctx,
  );
  if (netEdge < ctx.minNetEdge) return null;

  return {
    relation: 'moneyline_spread',
    description: `ML/spread desync: ML ${mlAsk.toFixed(3)} vs spread ${spAsk.toFixed(3)} (YES+NO=${totalCost.toFixed(3)})`,
    legs: [
      buyLeg(cheaper, 'YES', buyPrice, size),
      buyLeg(expensive, 'NO', hedgePrice, size),
    ],
    grossEdge,
    netEdge,
  };
}

export function checkThreeWaySum(
  store: OrderBookStore,
  markets: ClassifiedMarket[],
  ctx: RelationContext,
): RelationViolation | null {
  const moneylines = markets.filter((m) => m.type === 'moneyline');
  const draw = markets.find((m) => m.type === 'draw');
  if (moneylines.length < 2 || !draw) return null;

  const pricedLegs: PricedLeg[] = [];
  const legs: Leg[] = [];
  const size = clamp(ctx.maxLegSize, 1, 100);

  for (const ml of moneylines.slice(0, 2)) {
    const ask = getAsk(store, ml, 'YES');
    if (ask == null) return null;
    pricedLegs.push({ market: ml, price: ask });
    legs.push(buyLeg(ml, 'YES', ask, size));
  }

  const drawAsk = getAsk(store, draw, 'YES');
  if (drawAsk == null) return null;
  pricedLegs.push({ market: draw, price: drawAsk });
  legs.push(buyLeg(draw, 'YES', drawAsk, size));

  const totalCost = sum(pricedLegs.map((l) => l.price));
  const grossEdge = sub(1, totalCost);
  const netEdge = netEdgeForLegs(pricedLegs, 1, ctx);
  if (netEdge < ctx.minNetEdge) return null;

  return {
    relation: 'three_way_sum',
    description: `3-way sum ${totalCost.toFixed(3)} < 1 (home+draw+away arb)`,
    legs,
    grossEdge,
    netEdge,
  };
}

export function checkBttsPair(
  store: OrderBookStore,
  market: ClassifiedMarket,
  ctx: RelationContext,
): RelationViolation | null {
  if (market.type !== 'btts') return null;
  return checkComplementaryPair(store, market, ctx);
}
