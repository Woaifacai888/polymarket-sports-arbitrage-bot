import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config/config.js';
import type { EventGraph, FillEvent, Opportunity, OrderRecord } from '../src/config/types.js';
import { OrderBookStore } from '../src/data/orderBook.js';
import { RiskManager } from '../src/risk/riskManager.js';
import { PortfolioTracker } from '../src/portfolio/positions.js';
import { OrderManager } from '../src/exec/orderManager.js';
import type { ExecutionEngine, PlaceOrderRequest } from '../src/exec/executor.js';
import { roundToTick } from '../src/util/math.js';

function graph(): EventGraph {
  return {
    eventId: 'e1',
    slug: 'e',
    title: 'A vs B',
    sportId: 'nba',
    gameStartTime: null,
    markets: [
      {
        id: 'm1',
        conditionId: 'c1',
        question: 'q',
        slug: 's',
        eventId: 'e1',
        eventSlug: 'e',
        eventTitle: 'A vs B',
        gameStartTime: null,
        type: 'moneyline',
        tokens: { yesTokenId: 'yes1', noTokenId: 'no1' },
        enableOrderBook: true,
        minimumTickSize: 0.01,
        negRisk: false,
      },
    ],
    tokenIds: ['yes1', 'no1'],
  };
}

function opp(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'e1:complementary_pair:no1:BUY:NO|yes1:BUY:YES',
    eventId: 'e1',
    eventTitle: 'A vs B',
    relation: 'complementary_pair',
    description: 'test',
    legs: [
      { tokenId: 'yes1', marketId: 'm1', side: 'BUY', price: 0.4, size: 10, outcome: 'YES' },
      { tokenId: 'no1', marketId: 'm1', side: 'BUY', price: 0.5, size: 10, outcome: 'NO' },
    ],
    grossEdge: 0.1,
    netEdge: 0.08,
    detectedAt: Date.now(),
    status: 'detected',
    ...overrides,
  };
}

describe('RiskManager', () => {
  it('activates kill switch when daily realized loss exceeds limit', () => {
    const config = loadConfig({ dailyLossLimitUsd: 50, minNetEdgeBps: 10 });
    const risk = new RiskManager(config);
    risk.resetDaily(10_000);
    risk.recordRealizedPnl(-30);
    assert.equal(risk.isKillSwitchActive(), false);
    risk.recordRealizedPnl(-25);
    assert.equal(risk.isKillSwitchActive(), true);

    const decision = risk.approve(opp(), graph(), 10_000);
    assert.equal(decision.approved, false);
    assert.match(decision.reason ?? '', /kill-switch/i);
  });

  it('enforces opportunity cooldown with stable ids', () => {
    const config = loadConfig({
      opportunityCooldownMs: 60_000,
      minNetEdgeBps: 10,
      maxBookAgeMs: 60_000,
    });
    const risk = new RiskManager(config);
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('no1', [], [{ price: 0.5, size: 100 }]);

    const first = risk.approve(opp(), graph(), 10_000, store);
    assert.equal(first.approved, true);
    risk.markExecuted(opp(), graph());

    const second = risk.approve(opp(), graph(), 10_000, store);
    assert.equal(second.approved, false);
    assert.match(second.reason ?? '', /cooldown/i);
  });

  it('rejects stale books and thin liquidity', () => {
    const config = loadConfig({
      minNetEdgeBps: 10,
      maxBookAgeMs: 1_000,
      opportunityCooldownMs: 1,
    });
    const risk = new RiskManager(config);
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [], [{ price: 0.4, size: 1 }]);
    store.setSnapshot('no1', [], [{ price: 0.5, size: 1 }]);
    const book = store.get('yes1')!;
    book.updatedAt = Date.now() - 10_000;

    const stale = risk.approve(opp({ legs: opp().legs.map((l) => ({ ...l, size: 1 })) }), graph(), 10_000, store);
    assert.equal(stale.approved, false);
    assert.match(stale.reason ?? '', /stale/i);

    store.setSnapshot('yes1', [], [{ price: 0.4, size: 1 }]);
    store.setSnapshot('no1', [], [{ price: 0.5, size: 1 }]);
    const thin = risk.approve(opp(), graph(), 10_000, store);
    assert.equal(thin.approved, false);
    assert.match(thin.reason ?? '', /depth|Insufficient/i);
  });

  it('rejects when max open orders reached', () => {
    const config = loadConfig({ maxOpenOrders: 2, minNetEdgeBps: 10, maxBookAgeMs: 60_000 });
    const risk = new RiskManager(config);
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('no1', [], [{ price: 0.5, size: 100 }]);
    risk.setOpenOrderCount(2);
    const decision = risk.approve(opp(), graph(), 10_000, store);
    assert.equal(decision.approved, false);
    assert.match(decision.reason ?? '', /open orders/i);
  });

  it('releases event exposure', () => {
    const config = loadConfig({ maxEventExposureUsd: 100, minNetEdgeBps: 10, maxBookAgeMs: 60_000 });
    const risk = new RiskManager(config);
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [], [{ price: 0.4, size: 100 }]);
    store.setSnapshot('no1', [], [{ price: 0.5, size: 100 }]);
    risk.markExecuted(opp(), graph());
    assert.ok(risk.getEventExposure('e1') > 0);
    risk.releaseEventExposure('e1', risk.getEventExposure('e1'));
    assert.equal(risk.getEventExposure('e1'), 0);
  });
});

describe('PortfolioTracker', () => {
  it('labels YES/NO outcomes correctly', () => {
    const portfolio = new PortfolioTracker(1000);
    const fillYes: FillEvent = {
      orderId: '1',
      tokenId: 'yes1',
      marketId: 'm1',
      side: 'BUY',
      price: 0.4,
      size: 10,
      timestamp: Date.now(),
      mode: 'sim',
      outcome: 'YES',
    };
    const fillNo: FillEvent = {
      orderId: '2',
      tokenId: 'no1',
      marketId: 'm1',
      side: 'BUY',
      price: 0.5,
      size: 10,
      timestamp: Date.now(),
      mode: 'sim',
      outcome: 'NO',
    };
    portfolio.applyFill(fillYes);
    portfolio.applyFill(fillNo);
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [{ price: 0.4, size: 1 }], [{ price: 0.41, size: 1 }]);
    store.setSnapshot('no1', [{ price: 0.5, size: 1 }], [{ price: 0.51, size: 1 }]);
    const snap = portfolio.snapshot(store);
    const yes = snap.positions.find((p) => p.tokenId === 'yes1');
    const no = snap.positions.find((p) => p.tokenId === 'no1');
    assert.equal(yes?.outcome, 'YES');
    assert.equal(no?.outcome, 'NO');
    assert.ok(snap.unrealizedPnl !== 0 || snap.exposure > 0);
  });

  it('settles winning and losing outcomes', () => {
    const portfolio = new PortfolioTracker(1000);
    portfolio.applyFill({
      orderId: '1',
      tokenId: 'yes1',
      marketId: 'm1',
      side: 'BUY',
      price: 0.4,
      size: 10,
      timestamp: Date.now(),
      mode: 'sim',
      outcome: 'YES',
    });
    portfolio.applyFill({
      orderId: '2',
      tokenId: 'no1',
      marketId: 'm1',
      side: 'BUY',
      price: 0.55,
      size: 10,
      timestamp: Date.now(),
      mode: 'sim',
      outcome: 'NO',
    });

    const delta = portfolio.settleMarket('m1', 'YES');
    // YES pays 10*1 - 4 = +6; NO pays 0 - 5.5 = -5.5; net +0.5
    assert.ok(Math.abs(delta - 0.5) < 1e-6);
    assert.equal(portfolio.snapshot(new OrderBookStore()).positions.length, 0);
    assert.ok(portfolio.getRealizedPnl() > 0);
  });

  it('records MTM total pnl in history', () => {
    const portfolio = new PortfolioTracker(1000);
    portfolio.applyFill({
      orderId: '1',
      tokenId: 'yes1',
      marketId: 'm1',
      side: 'BUY',
      price: 0.4,
      size: 10,
      timestamp: Date.now(),
      mode: 'sim',
      outcome: 'YES',
    });
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [{ price: 0.6, size: 1 }], [{ price: 0.62, size: 1 }]);
    const snap = portfolio.snapshot(store);
    assert.ok(snap.unrealizedPnl > 0);
    assert.ok(snap.pnlHistory.length >= 1);
    assert.ok(snap.pnlHistory[snap.pnlHistory.length - 1].pnl > 0);
  });
});

describe('OrderManager placement quality', () => {
  it('rolls back earlier legs when a later leg fails', async () => {
    const cancelled: string[] = [];
    let placeCount = 0;
    const engine: ExecutionEngine = {
      mode: 'sim',
      async placeOrder(request: PlaceOrderRequest): Promise<OrderRecord> {
        placeCount += 1;
        if (placeCount === 2) throw new Error('CLOB reject');
        return {
          id: `ord-${placeCount}`,
          tokenId: request.leg.tokenId,
          marketId: request.leg.marketId,
          side: request.leg.side,
          price: request.leg.price,
          size: request.leg.size,
          filledSize: 0,
          status: 'open',
          createdAt: Date.now(),
          opportunityId: request.opportunityId,
          outcome: request.leg.outcome,
        };
      },
      async cancelOrder(orderId: string): Promise<void> {
        cancelled.push(orderId);
      },
      async cancelAll(): Promise<void> {},
      getOpenOrders: () => [],
      onFill: () => {},
      getBalance: () => 10_000,
    };

    const mgr = new OrderManager(engine, { placeRetries: 0, rollbackOnFailure: true });
    const meta = new Map([['m1', { tickSize: 0.01, negRisk: false }]]);
    const ok = await mgr.executeOpportunity(opp(), meta);
    assert.equal(ok, false);
    assert.deepEqual(cancelled, ['ord-1']);
  });

  it('rejects when market meta is missing (no silent skip)', async () => {
    const engine: ExecutionEngine = {
      mode: 'sim',
      async placeOrder(): Promise<OrderRecord> {
        throw new Error('should not place');
      },
      async cancelOrder(): Promise<void> {},
      async cancelAll(): Promise<void> {},
      getOpenOrders: () => [],
      onFill: () => {},
      getBalance: () => 10_000,
    };
    const mgr = new OrderManager(engine, { placeRetries: 0 });
    const ok = await mgr.executeOpportunity(opp(), new Map());
    assert.equal(ok, false);
  });

  it('rounds prices to tick size', () => {
    assert.equal(roundToTick(0.453, 0.01), 0.45);
    assert.equal(roundToTick(0.456, 0.01), 0.46);
  });
});
