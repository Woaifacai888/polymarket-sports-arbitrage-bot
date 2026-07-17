import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config/config.js';
import type { EventGraph, FillEvent, Opportunity, OrderRecord } from '../src/config/types.js';
import { OrderBookStore } from '../src/data/orderBook.js';
import type { ExecutionEngine, PlaceOrderRequest } from '../src/exec/executor.js';
import { OrderManager } from '../src/exec/orderManager.js';
import { SimExecutor } from '../src/exec/simExecutor.js';
import { ArbTradePnlTracker } from '../src/portfolio/arbTradePnl.js';
import { computeFillCosts } from '../src/portfolio/fillCosts.js';
import { PortfolioTracker } from '../src/portfolio/positions.js';
import { settleFinishedEvent } from '../src/portfolio/settlement.js';
import { TradeHistoryStore } from '../src/portfolio/tradeHistory.js';
import { RiskManager } from '../src/risk/riskManager.js';

function graph(overrides: Partial<EventGraph> = {}): EventGraph {
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
        question: 'Will A beat B?',
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
    ...overrides,
  };
}

function opp(): Opportunity {
  return {
    id: 'e1:complementary_pair:no1:BUY:NO|yes1:BUY:YES',
    eventId: 'e1',
    eventTitle: 'A vs B',
    relation: 'complementary_pair',
    description: 'YES+NO arb',
    legs: [
      { tokenId: 'yes1', marketId: 'm1', side: 'BUY', price: 0.45, size: 100, outcome: 'YES' },
      { tokenId: 'no1', marketId: 'm1', side: 'BUY', price: 0.5, size: 100, outcome: 'NO' },
    ],
    grossEdge: 0.05,
    netEdge: 0.04,
    detectedAt: Date.now(),
    status: 'detected',
  };
}

function buyFill(tokenId: string, price: number, size: number, outcome: 'YES' | 'NO'): FillEvent {
  const costs = computeFillCosts(price, size, 'BUY', 200);
  return {
    orderId: `o-${tokenId}`,
    tokenId,
    marketId: 'm1',
    side: 'BUY',
    price,
    size,
    timestamp: Date.now(),
    mode: 'sim',
    outcome,
    opportunityId: opp().id,
    feeUsd: costs.feeUsd,
    allInCostUsd: costs.allInUsd,
  };
}

describe('end-of-day rollover', () => {
  it('TradeHistoryStore rolls to a new JSONL file when the UTC day changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-roll-'));
    let now = Date.UTC(2026, 6, 17, 23, 59, 0);
    const store = new TradeHistoryStore({ mode: 'sim', dir, clock: () => now });

    store.recordReject(opp(), 'test before midnight');
    const fileBefore = store.getFilePath();
    assert.match(fileBefore, /sim-2026-07-17\.jsonl$/);

    now = Date.UTC(2026, 6, 18, 0, 1, 0);
    store.recordReject(opp(), 'test after midnight');
    const fileAfter = store.getFilePath();
    assert.match(fileAfter, /sim-2026-07-18\.jsonl$/);

    assert.equal(fs.readFileSync(fileBefore, 'utf8').trim().split('\n').length, 1);
    assert.equal(fs.readFileSync(fileAfter, 'utf8').trim().split('\n').length, 1);
  });

  it('RiskManager.rollDailyCounters resets kill switch and daily PnL but keeps exposure', () => {
    const config = loadConfig({ dailyLossLimitUsd: 50 });
    const risk = new RiskManager(config);
    risk.resetDaily(10_000);
    risk.recordRealizedPnl(-60);
    assert.equal(risk.isKillSwitchActive(), true);

    const g = graph();
    risk.markExecuted(opp(), g);
    const exposureBefore = risk.getEventExposure('e1');
    assert.ok(exposureBefore > 0);

    risk.rollDailyCounters();
    assert.equal(risk.isKillSwitchActive(), false);
    assert.equal(risk.getDailyRealizedPnl(), 0);
    assert.equal(risk.getEventExposure('e1'), exposureBefore);
  });
});

describe('game-start order cancellation', () => {
  function makeEngine(openOrders: OrderRecord[], cancelled: string[]): ExecutionEngine {
    return {
      mode: 'sim',
      async placeOrder(_request: PlaceOrderRequest): Promise<OrderRecord> {
        throw new Error('not used');
      },
      async cancelOrder(orderId: string): Promise<void> {
        cancelled.push(orderId);
        const order = openOrders.find((o) => o.id === orderId);
        if (order) order.status = 'cancelled';
      },
      async cancelAll(): Promise<void> {},
      getOpenOrders: () => openOrders.filter((o) => o.status === 'open' || o.status === 'partial'),
      getOrder: (id) => openOrders.find((o) => o.id === id),
      onFill: () => {},
      getBalance: () => 10_000,
    };
  }

  it('cancels stale open orders even long after game start (missed 5-minute window)', async () => {
    const cancelled: string[] = [];
    const openOrders: OrderRecord[] = [
      {
        id: 'stale-1',
        tokenId: 'yes1',
        marketId: 'm1',
        side: 'BUY',
        price: 0.45,
        size: 100,
        filledSize: 0,
        status: 'open',
        createdAt: Date.now() - 60 * 60 * 1000,
      },
    ];
    const engine = makeEngine(openOrders, cancelled);
    const mgr = new OrderManager(engine, { placeRetries: 0 });

    // Game started 30 minutes ago — well outside the old 5-minute window.
    const g = graph({ gameStartTime: new Date(Date.now() - 30 * 60 * 1000) });
    await mgr.cancelAllAtGameStart(g);

    assert.deepEqual(cancelled, ['stale-1']);
  });
});

describe('event settlement at end of game', () => {
  function setupFilledArb() {
    const store = new OrderBookStore();
    const portfolio = new PortfolioTracker(10_000, 200);
    const tracker = new ArbTradePnlTracker();
    const o = opp();
    tracker.registerPlacement(o);

    const fills = [buyFill('yes1', 0.45, 100, 'YES'), buyFill('no1', 0.5, 100, 'NO')];
    for (const f of fills) {
      portfolio.applyFill(f);
      tracker.onFill(f, store);
    }
    return { store, portfolio, tracker };
  }

  it('settles a locked pair, realizes fee-inclusive profit, and closes the trade record', () => {
    const { store, portfolio, tracker } = setupFilledArb();
    // Final book: YES clearly won.
    store.setSnapshot('yes1', [{ price: 0.98, size: 100 }], [{ price: 0.99, size: 100 }]);

    const result = settleFinishedEvent(graph(), { portfolio, store, arbTradePnl: tracker });

    assert.equal(result.skippedMarkets, 0);
    assert.equal(result.settledMarkets, 1);
    assert.equal(result.winnerByMarket.get('m1'), 'YES');
    // 100 shares pay $100; all-in entry was $96.90 → +$3.10 realized.
    assert.equal(result.realizedPnlUsd, 3.1);
    assert.equal(result.proceedsUsd, 100);
    assert.equal(portfolio.getRealizedPnl(), 3.1);
    assert.equal(portfolio.snapshot(store).positions.length, 0);

    assert.equal(result.closedTrades.length, 1);
    const closed = result.closedTrades[0];
    assert.equal(closed.status, 'closed');
    assert.equal(closed.realizedPnlUsd, 3.1);
    assert.equal(closed.totalPnlUsd, 3.1);
  });

  it('settles a matched pair even when the final book is gone (payout invariant)', () => {
    const { store, portfolio, tracker } = setupFilledArb();
    // No book at all — market delisted after the game.

    const result = settleFinishedEvent(graph(), { portfolio, store, arbTradePnl: tracker });

    assert.equal(result.skippedMarkets, 0);
    assert.equal(result.realizedPnlUsd, 3.1);
    assert.equal(portfolio.snapshot(store).positions.length, 0);
  });

  it('skips a one-sided position with no price info unless forced', () => {
    const store = new OrderBookStore();
    const portfolio = new PortfolioTracker(10_000, 200);
    const tracker = new ArbTradePnlTracker();
    portfolio.applyFill(buyFill('yes1', 0.45, 100, 'YES'));

    const g = graph();
    const gentle = settleFinishedEvent(g, { portfolio, store, arbTradePnl: tracker });
    assert.equal(gentle.skippedMarkets, 1);
    assert.equal(gentle.settledMarkets, 0);
    assert.equal(portfolio.snapshot(store).positions.length, 1);

    const forced = settleFinishedEvent(g, { portfolio, store, arbTradePnl: tracker }, { force: true });
    assert.equal(forced.skippedMarkets, 0);
    assert.equal(portfolio.snapshot(store).positions.length, 0);
  });

  it('cleans up zero-fill pending trades when the event settles', () => {
    const { store, portfolio, tracker } = setupFilledArb();
    const ghost = { ...opp(), id: 'e1:ghost', legs: opp().legs };
    tracker.registerPlacement(ghost);

    store.setSnapshot('yes1', [{ price: 0.98, size: 100 }], [{ price: 0.99, size: 100 }]);
    settleFinishedEvent(graph(), { portfolio, store, arbTradePnl: tracker });

    assert.equal(tracker.pendingCount(), 0);
  });
});

describe('sim balance sync at settlement', () => {
  it('SimExecutor.credit adds settlement proceeds to the sim balance', () => {
    const config = loadConfig({ simInitialBalance: 1_000 });
    const store = new OrderBookStore();
    const sim = new SimExecutor(config, store);
    sim.credit(100);
    assert.equal(sim.getBalance(), 1_100);
  });
});
