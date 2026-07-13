import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { opportunityFingerprint, buildOpportunity } from '../src/arb/types.js';
import {
  checkMoneylineSpread,
  checkComplementaryPair,
  checkThreeWaySum,
} from '../src/arb/relations.js';
import {
  checkOpportunityLiquidity,
  isBookFresh,
  clampLegsToLiquidity,
} from '../src/arb/liquidity.js';
import { ArbDetector } from '../src/arb/detector.js';
import { OrderBookStore } from '../src/data/orderBook.js';
import type { ClassifiedMarket, EventGraph, Opportunity } from '../src/config/types.js';
import { loadConfig } from '../src/config/config.js';
import type { RelationContext } from '../src/arb/types.js';

function market(overrides: Partial<ClassifiedMarket> = {}): ClassifiedMarket {
  return {
    id: 'm1',
    conditionId: 'c1',
    question: 'Team A win?',
    slug: 'team-a',
    eventId: 'e1',
    eventSlug: 'event-1',
    eventTitle: 'A vs B',
    gameStartTime: null,
    type: 'moneyline',
    tokens: { yesTokenId: 'yes1', noTokenId: 'no1' },
    enableOrderBook: true,
    minimumTickSize: 0.01,
    negRisk: false,
    ...overrides,
  };
}

const ctx: RelationContext = {
  eventId: 'e1',
  eventTitle: 'A vs B',
  feeBps: 0,
  slippageBps: 0,
  minNetEdge: 0.01,
  maxLegSize: 10,
};

describe('opportunityFingerprint', () => {
  it('is stable across time for the same legs', () => {
    const legs = [
      { tokenId: 'a', side: 'BUY', outcome: 'YES' },
      { tokenId: 'b', side: 'BUY', outcome: 'NO' },
    ];
    const a = opportunityFingerprint('e1', 'complementary_pair', legs);
    const b = opportunityFingerprint('e1', 'complementary_pair', legs);
    assert.equal(a, b);
  });

  it('is order-independent for legs', () => {
    const a = opportunityFingerprint('e1', 'complementary_pair', [
      { tokenId: 'a', side: 'BUY', outcome: 'YES' },
      { tokenId: 'b', side: 'BUY', outcome: 'NO' },
    ]);
    const b = opportunityFingerprint('e1', 'complementary_pair', [
      { tokenId: 'b', side: 'BUY', outcome: 'NO' },
      { tokenId: 'a', side: 'BUY', outcome: 'YES' },
    ]);
    assert.equal(a, b);
  });

  it('buildOpportunity uses stable id (not timestamp uuid)', () => {
    const opp = buildOpportunity(ctx, {
      relation: 'complementary_pair',
      description: 'test',
      legs: [
        { tokenId: 'yes1', marketId: 'm1', side: 'BUY', price: 0.4, size: 1, outcome: 'YES' },
        { tokenId: 'no1', marketId: 'm1', side: 'BUY', price: 0.5, size: 1, outcome: 'NO' },
      ],
      grossEdge: 0.1,
      netEdge: 0.1,
    });
    assert.ok(opp.id.includes('complementary_pair'));
    assert.ok(opp.id.includes('yes1'));
    assert.equal(opp.id.includes(String(Date.now()).slice(0, 8)), false);
  });
});

describe('moneyline_spread pricing', () => {
  it('uses real NO ask and buys cheaper YES + expensive NO', () => {
    const store = new OrderBookStore();
    const ml = market({
      id: 'ml',
      type: 'moneyline',
      tokens: { yesTokenId: 'mlY', noTokenId: 'mlN' },
    });
    const sp = market({
      id: 'sp',
      type: 'spread',
      line: 0,
      tokens: { yesTokenId: 'spY', noTokenId: 'spN' },
    });

    // ML expensive YES 0.55, spread cheap YES 0.40; ML NO ask 0.42 → package 0.82
    store.setSnapshot('mlY', [], [{ price: 0.55, size: 100 }]);
    store.setSnapshot('mlN', [], [{ price: 0.42, size: 100 }]);
    store.setSnapshot('spY', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('spN', [], [{ price: 0.58, size: 100 }]);

    const v = checkMoneylineSpread(store, [ml], [sp], ctx);
    assert.ok(v);
    assert.equal(v.relation, 'moneyline_spread');
    assert.equal(v.legs[0].tokenId, 'spY');
    assert.equal(v.legs[1].tokenId, 'mlN');
    assert.equal(v.legs[1].price, 0.42);
    assert.ok(v.netEdge > 0.01);
  });

  it('rejects when only synthetic 1-YES would look good but real NO is expensive', () => {
    const store = new OrderBookStore();
    const ml = market({
      id: 'ml',
      tokens: { yesTokenId: 'mlY', noTokenId: 'mlN' },
    });
    const sp = market({
      id: 'sp',
      type: 'spread',
      line: 0,
      tokens: { yesTokenId: 'spY', noTokenId: 'spN' },
    });
    store.setSnapshot('mlY', [], [{ price: 0.6, size: 100 }]);
    store.setSnapshot('mlN', [], [{ price: 0.7, size: 100 }]);
    store.setSnapshot('spY', [], [{ price: 0.5, size: 100 }]);
    store.setSnapshot('spN', [], [{ price: 0.7, size: 100 }]);

    const v = checkMoneylineSpread(store, [ml], [sp], ctx);
    assert.equal(v, null);
  });
});

describe('liquidity checks', () => {
  it('rejects when depth cannot fill size', () => {
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [], [{ price: 0.45, size: 2 }]);
    store.setSnapshot('no1', [], [{ price: 0.5, size: 2 }]);

    const opp: Opportunity = {
      id: 'x',
      eventId: 'e1',
      eventTitle: 't',
      relation: 'complementary_pair',
      description: 'd',
      legs: [
        { tokenId: 'yes1', marketId: 'm1', side: 'BUY', price: 0.45, size: 50, outcome: 'YES' },
        { tokenId: 'no1', marketId: 'm1', side: 'BUY', price: 0.5, size: 50, outcome: 'NO' },
      ],
      grossEdge: 0.05,
      netEdge: 0.05,
      detectedAt: Date.now(),
      status: 'detected',
    };

    const check = checkOpportunityLiquidity(opp, store);
    assert.equal(check.ok, false);
    assert.ok((check.maxFillableShares ?? 0) <= 2);
  });

  it('clamps leg size to available depth', () => {
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [], [{ price: 0.45, size: 5 }]);
    store.setSnapshot('no1', [], [{ price: 0.5, size: 5 }]);
    const opp: Opportunity = {
      id: 'x',
      eventId: 'e1',
      eventTitle: 't',
      relation: 'complementary_pair',
      description: 'd',
      legs: [
        { tokenId: 'yes1', marketId: 'm1', side: 'BUY', price: 0.45, size: 100, outcome: 'YES' },
        { tokenId: 'no1', marketId: 'm1', side: 'BUY', price: 0.5, size: 100, outcome: 'NO' },
      ],
      grossEdge: 0.05,
      netEdge: 0.05,
      detectedAt: Date.now(),
      status: 'detected',
    };
    const clamped = clampLegsToLiquidity(opp, store);
    assert.equal(clamped.legs[0].size, 5);
    assert.equal(clamped.legs[1].size, 5);
  });

  it('detects stale books', () => {
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [], [{ price: 0.4, size: 10 }]);
    const book = store.get('yes1')!;
    book.updatedAt = Date.now() - 60_000;
    const result = isBookFresh(
      store,
      [{ tokenId: 'yes1', marketId: 'm1', side: 'BUY', price: 0.4, size: 1, outcome: 'YES' }],
      15_000,
    );
    assert.equal(result.fresh, false);
  });
});

describe('ArbDetector stable ids', () => {
  it('returns the same opportunity id on repeated scans', () => {
    const config = loadConfig({ minNetEdgeBps: 10, feeBps: 0, slippageBps: 0 });
    const detector = new ArbDetector(config);
    const store = new OrderBookStore();
    const m = market();
    store.setSnapshot('yes1', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('no1', [], [{ price: 0.5, size: 100 }]);

    const graph: EventGraph = {
      eventId: 'e1',
      slug: 'e',
      title: 'A vs B',
      sportId: 'nba',
      gameStartTime: null,
      markets: [m],
      tokenIds: ['yes1', 'no1'],
    };

    const a = detector.scan([graph], store);
    const b = detector.scan([graph], store);
    assert.ok(a.length >= 1);
    assert.equal(a[0].id, b[0].id);
  });
});

describe('three_way_sum', () => {
  it('detects home+draw+away sum < 1', () => {
    const store = new OrderBookStore();
    const home = market({
      id: 'h',
      type: 'moneyline',
      tokens: { yesTokenId: 'hY', noTokenId: 'hN' },
    });
    const away = market({
      id: 'a',
      type: 'moneyline',
      tokens: { yesTokenId: 'aY', noTokenId: 'aN' },
    });
    const draw = market({
      id: 'd',
      type: 'draw',
      tokens: { yesTokenId: 'dY', noTokenId: 'dN' },
    });
    store.setSnapshot('hY', [], [{ price: 0.3, size: 50 }]);
    store.setSnapshot('aY', [], [{ price: 0.3, size: 50 }]);
    store.setSnapshot('dY', [], [{ price: 0.3, size: 50 }]);

    const v = checkThreeWaySum(store, [home, away, draw], ctx);
    assert.ok(v);
    assert.equal(v.legs.length, 3);
    assert.ok(v.netEdge > 0);
  });
});

describe('complementary edge cases', () => {
  it('returns null when books are missing', () => {
    const store = new OrderBookStore();
    assert.equal(checkComplementaryPair(store, market(), ctx), null);
  });
});
