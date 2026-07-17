import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkTotalsLadder, checkSpreadLadder, checkMoneylineSpread } from '../src/arb/relations.js';
import type { RelationContext } from '../src/arb/types.js';
import { marketSubjectKey } from '../src/model/marketClassifier.js';
import { OrderBookStore } from '../src/data/orderBook.js';
import { SimExecutor } from '../src/exec/simExecutor.js';
import { RiskManager } from '../src/risk/riskManager.js';
import { loadConfig } from '../src/config/config.js';
import type { ClassifiedMarket, EventGraph, FillEvent, Opportunity } from '../src/config/types.js';

function market(overrides: Partial<ClassifiedMarket> = {}): ClassifiedMarket {
  return {
    id: 'm1',
    conditionId: 'c1',
    question: 'Will there be over 2.5 goals?',
    slug: 's',
    eventId: 'e1',
    eventSlug: 'e',
    eventTitle: 'England vs Argentina',
    gameStartTime: null,
    type: 'total',
    side: 'over',
    tokens: { yesTokenId: 'y1', noTokenId: 'n1' },
    enableOrderBook: true,
    minimumTickSize: 0.01,
    negRisk: false,
    ...overrides,
  };
}

const ctx: RelationContext = {
  eventId: 'e1',
  eventTitle: 'England vs Argentina',
  feeBps: 0,
  slippageBps: 0,
  minNetEdge: 0.01,
  maxLegSize: 10,
};

describe('marketSubjectKey', () => {
  it('groups questions that differ only by line', () => {
    assert.equal(
      marketSubjectKey('Will there be over 2.5 goals?'),
      marketSubjectKey('Will there be over 3.5 goals?'),
    );
  });

  it('separates different subjects with the same line', () => {
    assert.notEqual(
      marketSubjectKey('Will England have over 3.5 corners?'),
      marketSubjectKey('Will Argentina have over 3.5 corners?'),
    );
  });
});

describe('totals ladder edge cases (sim-2026-07-15 regression)', () => {
  it('does NOT fire on two markets with the same line (Over 3.5 vs Over 3.5)', () => {
    // Reproduces the phantom arb: England corners vs Argentina corners,
    // both line 3.5, asks 0.55 vs 0.68 — previously traded as an "inversion".
    const store = new OrderBookStore();
    const englandCorners = market({
      id: '2891747',
      line: 3.5,
      question: 'Will England have over 3.5 corners?',
      tokens: { yesTokenId: 'engY', noTokenId: 'engN' },
    });
    const argentinaCorners = market({
      id: '2891753',
      line: 3.5,
      question: 'Will Argentina have over 3.5 corners?',
      tokens: { yesTokenId: 'argY', noTokenId: 'argN' },
    });

    store.setSnapshot('engY', [], [{ price: 0.55, size: 200 }]);
    store.setSnapshot('engN', [], [{ price: 0.47, size: 200 }]);
    store.setSnapshot('argY', [], [{ price: 0.68, size: 200 }]);
    store.setSnapshot('argN', [], [{ price: 0.33, size: 200 }]);

    const violation = checkTotalsLadder(store, [englandCorners, argentinaCorners], ctx);
    assert.equal(violation, null);
  });

  it('does NOT fire on same-line markets even with identical subjects', () => {
    const store = new OrderBookStore();
    const a = market({
      id: 'a',
      line: 3.5,
      tokens: { yesTokenId: 'aY', noTokenId: 'aN' },
      question: 'Will there be over 3.5 corners?',
    });
    const b = market({
      id: 'b',
      line: 3.5,
      tokens: { yesTokenId: 'bY', noTokenId: 'bN' },
      question: 'Will there be over 3.5 corners?',
    });
    store.setSnapshot('aY', [], [{ price: 0.55, size: 100 }]);
    store.setSnapshot('bY', [], [{ price: 0.68, size: 100 }]);
    store.setSnapshot('bN', [], [{ price: 0.33, size: 100 }]);

    assert.equal(checkTotalsLadder(store, [a, b], ctx), null);
  });

  it('does NOT compare different subjects even with different lines', () => {
    const store = new OrderBookStore();
    const englandCorners = market({
      id: 'a',
      line: 2.5,
      question: 'Will England have over 2.5 corners?',
      tokens: { yesTokenId: 'aY', noTokenId: 'aN' },
    });
    const argentinaCorners = market({
      id: 'b',
      line: 3.5,
      question: 'Will Argentina have over 3.5 corners?',
      tokens: { yesTokenId: 'bY', noTokenId: 'bN' },
    });
    store.setSnapshot('aY', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('bY', [], [{ price: 0.6, size: 100 }]);
    store.setSnapshot('bN', [], [{ price: 0.35, size: 100 }]);

    assert.equal(checkTotalsLadder(store, [englandCorners, argentinaCorners], ctx), null);
  });

  it('still fires on a genuine same-subject ladder inversion', () => {
    const store = new OrderBookStore();
    const over25 = market({
      id: 'a',
      line: 2.5,
      question: 'Will there be over 2.5 goals?',
      tokens: { yesTokenId: 'aY', noTokenId: 'aN' },
    });
    const over35 = market({
      id: 'b',
      line: 3.5,
      question: 'Will there be over 3.5 goals?',
      tokens: { yesTokenId: 'bY', noTokenId: 'bN' },
    });
    store.setSnapshot('aY', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('bY', [], [{ price: 0.55, size: 100 }]);
    store.setSnapshot('bN', [], [{ price: 0.4, size: 100 }]);

    const violation = checkTotalsLadder(store, [over25, over35], ctx);
    assert.ok(violation);
    assert.equal(violation.relation, 'totals_ladder');
    // Raw cost 0.4 + 0.4 = 0.8 → gross edge 0.2 (no double-counted slippage)
    assert.ok(Math.abs(violation.grossEdge - 0.2) < 1e-9);
  });

  it('excludes Under-side markets from the Over ladder', () => {
    const store = new OrderBookStore();
    const over = market({
      id: 'a',
      line: 2.5,
      side: 'over',
      question: 'Will there be over 2.5 goals?',
      tokens: { yesTokenId: 'aY', noTokenId: 'aN' },
    });
    const under = market({
      id: 'b',
      line: 3.5,
      side: 'under',
      question: 'Will there be under 3.5 goals?',
      tokens: { yesTokenId: 'bY', noTokenId: 'bN' },
    });
    store.setSnapshot('aY', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('bY', [], [{ price: 0.6, size: 100 }]);
    store.setSnapshot('bN', [], [{ price: 0.35, size: 100 }]);

    assert.equal(checkTotalsLadder(store, [over, under], ctx), null);
  });
});

describe('spread ladder edge cases', () => {
  it('does NOT fire on equal spread lines', () => {
    const store = new OrderBookStore();
    const a = market({
      id: 'a',
      type: 'spread',
      line: -3.5,
      question: 'Team A (-3.5)?',
      tokens: { yesTokenId: 'aY', noTokenId: 'aN' },
    });
    const b = market({
      id: 'b',
      type: 'spread',
      line: -3.5,
      question: 'Team A (-3.5)?',
      tokens: { yesTokenId: 'bY', noTokenId: 'bN' },
    });
    store.setSnapshot('aY', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('bY', [], [{ price: 0.6, size: 100 }]);
    store.setSnapshot('aN', [], [{ price: 0.35, size: 100 }]);

    assert.equal(checkSpreadLadder(store, [a, b], ctx), null);
  });
});

describe('moneyline vs spread edge cases', () => {
  it('does NOT fire when no zero-line spread exists', () => {
    const store = new OrderBookStore();
    const ml = market({
      id: 'ml',
      type: 'moneyline',
      side: 'home',
      line: undefined,
      question: 'Will Team A win?',
      tokens: { yesTokenId: 'mlY', noTokenId: 'mlN' },
    });
    const sp = market({
      id: 'sp',
      type: 'spread',
      line: -7.5,
      question: 'Team A (-7.5)?',
      tokens: { yesTokenId: 'spY', noTokenId: 'spN' },
    });
    store.setSnapshot('mlY', [], [{ price: 0.55, size: 100 }]);
    store.setSnapshot('mlN', [], [{ price: 0.42, size: 100 }]);
    store.setSnapshot('spY', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('spN', [], [{ price: 0.58, size: 100 }]);

    assert.equal(checkMoneylineSpread(store, [ml], [sp], ctx), null);
  });
});

describe('SimExecutor book depletion (repeat-trade regression)', () => {
  function makeExecutor(store: OrderBookStore) {
    const config = loadConfig({ simInitialBalance: 10_000 });
    return new SimExecutor(config, store);
  }

  it('consumes ask depth so the same liquidity cannot be bought twice', async () => {
    const store = new OrderBookStore();
    store.setSnapshot('tok', [], [{ price: 0.55, size: 113 }]);
    const exec = makeExecutor(store);

    const first = await exec.placeOrder({
      leg: { tokenId: 'tok', marketId: 'm', side: 'BUY', price: 0.56, size: 113, outcome: 'YES' },
      tickSize: 0.01,
      negRisk: false,
    });
    assert.equal(first.status, 'filled');
    assert.equal(store.bestAsk('tok'), null);

    // Second identical order finds an empty book → rests unfilled.
    const second = await exec.placeOrder({
      leg: { tokenId: 'tok', marketId: 'm', side: 'BUY', price: 0.56, size: 113, outcome: 'YES' },
      tickSize: 0.01,
      negRisk: false,
    });
    assert.equal(second.status, 'open');
    assert.equal(second.filledSize, 0);
  });

  it('partially fills when depth is thinner than order size', async () => {
    const store = new OrderBookStore();
    store.setSnapshot('tok', [], [{ price: 0.5, size: 40 }]);
    const exec = makeExecutor(store);

    const order = await exec.placeOrder({
      leg: { tokenId: 'tok', marketId: 'm', side: 'BUY', price: 0.5, size: 100, outcome: 'YES' },
      tickSize: 0.01,
      negRisk: false,
    });
    assert.equal(order.status, 'partial');
    assert.equal(order.filledSize, 40);
  });

  it('fills at VWAP across levels within the limit price', async () => {
    const store = new OrderBookStore();
    store.setSnapshot('tok', [], [
      { price: 0.5, size: 50 },
      { price: 0.6, size: 100 },
      { price: 0.9, size: 100 },
    ]);
    const exec = makeExecutor(store);
    const fills: FillEvent[] = [];
    exec.onFill((f) => fills.push(f));

    const order = await exec.placeOrder({
      leg: { tokenId: 'tok', marketId: 'm', side: 'BUY', price: 0.62, size: 100, outcome: 'YES' },
      tickSize: 0.01,
      negRisk: false,
    });
    assert.equal(order.status, 'filled');
    assert.equal(fills.length, 1);
    // VWAP = (50*0.5 + 50*0.6) / 100 = 0.55; 0.9 level untouched (above limit)
    assert.ok(Math.abs(fills[0].price - 0.55) < 1e-9);
    assert.equal(store.bestAsk('tok'), 0.6);
  });
});

describe('RiskManager executed cooldown (repeat-trade regression)', () => {
  function graph(): EventGraph {
    return {
      eventId: 'e1',
      slug: 'e',
      title: 'England vs Argentina',
      sportId: 'world_cup',
      gameStartTime: null,
      markets: [],
      tokenIds: [],
    };
  }

  function opp(): Opportunity {
    return {
      id: 'e1:totals_ladder:x:BUY:NO|y:BUY:YES',
      eventId: 'e1',
      eventTitle: 'England vs Argentina',
      relation: 'totals_ladder',
      description: 'test',
      legs: [
        { tokenId: 'y', marketId: 'm1', side: 'BUY', price: 0.55, size: 10, outcome: 'YES' },
        { tokenId: 'x', marketId: 'm2', side: 'BUY', price: 0.33, size: 10, outcome: 'NO' },
      ],
      grossEdge: 0.12,
      netEdge: 0.11,
      detectedAt: Date.now(),
      status: 'detected',
    };
  }

  it('blocks re-execution after the duplicate cooldown expires', async () => {
    const config = loadConfig({
      minNetEdgeBps: 10,
      opportunityCooldownMs: 1, // duplicate cooldown effectively disabled
      executedCooldownMs: 120_000,
    });
    const risk = new RiskManager(config);
    risk.markExecuted(opp(), graph());

    await new Promise((r) => setTimeout(r, 5));

    const decision = risk.approve(opp(), graph(), 10_000);
    assert.equal(decision.approved, false);
    assert.match(decision.reason ?? '', /executed/i);
  });
});
