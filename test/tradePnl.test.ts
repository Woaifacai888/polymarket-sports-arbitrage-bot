import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { computeTradePnl } from '../src/portfolio/arbTradePnl.js';
import { computeFillCosts, enrichFill } from '../src/portfolio/fillCosts.js';
import { PortfolioTracker } from '../src/portfolio/positions.js';
import { TradeHistoryStore } from '../src/portfolio/tradeHistory.js';
import type { FillEvent, Opportunity } from '../src/config/types.js';
import { OrderBookStore } from '../src/data/orderBook.js';

function sampleOpp(): Opportunity {
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

function buyFill(
  tokenId: string,
  price: number,
  size: number,
  feeBps: number,
  outcome: 'YES' | 'NO',
): FillEvent {
  const costs = computeFillCosts(price, size, 'BUY', feeBps);
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
    opportunityId: sampleOpp().id,
    feeUsd: costs.feeUsd,
    allInCostUsd: costs.allInUsd,
  };
}

describe('fillCosts', () => {
  it('adds fee to BUY all-in cost using the p(1-p) fee curve', () => {
    // fee = 100 shares x 0.02 x 0.5 x (1 - 0.5) = 0.5
    const costs = computeFillCosts(0.5, 100, 'BUY', 200);
    assert.equal(costs.grossUsd, 50);
    assert.equal(costs.feeUsd, 0.5);
    assert.equal(costs.allInUsd, 50.5);
  });

  it('subtracts fee from SELL proceeds using the p(1-p) fee curve', () => {
    // fee = 50 shares x 0.02 x 0.6 x (1 - 0.6) = 0.24
    const costs = computeFillCosts(0.6, 50, 'SELL', 200);
    assert.equal(costs.grossUsd, 30);
    assert.equal(costs.feeUsd, 0.24);
    assert.equal(costs.allInUsd, 29.76);
  });

  it('charges more fee at mid prices than near-certain prices (same notional)', () => {
    const mid = computeFillCosts(0.5, 100, 'BUY', 500);
    const extreme = computeFillCosts(0.95, 100, 'BUY', 500);
    assert.ok(mid.feeUsd > extreme.feeUsd);
  });
});

describe('computeTradePnl', () => {
  it('computes locked profit for a complete complementary_pair package', () => {
    const opp = sampleOpp();
    const fills = [
      buyFill('yes1', 0.45, 100, 200, 'YES'),
      buyFill('no1', 0.5, 100, 200, 'NO'),
    ];
    const snapshot = computeTradePnl(opp, fills, null, true);
    assert.ok(snapshot);
    assert.equal(snapshot.status, 'open');
    assert.equal(snapshot.sharesPerLeg, 100);
    assert.equal(snapshot.grossEntryUsd, 95);
    // p(1-p) fees: 100 x 0.02 x 0.45 x 0.55 + 100 x 0.02 x 0.5 x 0.5 = 0.995
    assert.equal(snapshot.feeUsd, 0.995);
    assert.equal(snapshot.allInEntryUsd, 95.995);
    assert.equal(snapshot.lockedPayoutUsd, 100);
    assert.equal(snapshot.lockedProfitUsd, 4.005);
    assert.equal(snapshot.expectedProfitUsd, 4);
    assert.equal(snapshot.totalPnlUsd, 4.005);
  });

  it('marks partial packages without locked profit', () => {
    const opp = sampleOpp();
    const fills = [buyFill('yes1', 0.45, 100, 200, 'YES')];
    const snapshot = computeTradePnl(opp, fills, null, false);
    assert.ok(snapshot);
    assert.equal(snapshot.status, 'partial');
    assert.equal(snapshot.lockedProfitUsd, undefined);
  });
});

describe('PortfolioTracker fee-inclusive PnL', () => {
  it('uses fee-inclusive cost basis for unrealized PnL', () => {
    const store = new OrderBookStore();
    store.setSnapshot('yes1', [{ price: 0.46, size: 1000 }], [{ price: 0.47, size: 1000 }]);
    const portfolio = new PortfolioTracker(10_000, 200);
    const fill = enrichFill(
      {
        orderId: 'o1',
        tokenId: 'yes1',
        marketId: 'm1',
        side: 'BUY',
        price: 0.45,
        size: 100,
        timestamp: Date.now(),
        mode: 'sim',
        outcome: 'YES',
      },
      200,
    );
    portfolio.applyFill(fill);
    const snap = portfolio.snapshot(store);
    // all-in = 45 + 100 x 0.02 x 0.45 x 0.55 = 45.495
    assert.equal(snap.exposure, 45.495);
    // mark = mid(0.46, 0.47) = 0.465 → unrealized = 46.5 - 45.495 = 1.005
    assert.equal(snap.unrealizedPnl, 1.005);
  });
});

describe('TradeHistoryStore trade_pnl', () => {
  it('persists per-arbitrage PnL snapshots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-pnl-'));
    const store = new TradeHistoryStore({ mode: 'sim', dir, memoryLimit: 50 });
    const opp = sampleOpp();
    const fills = [
      buyFill('yes1', 0.45, 100, 200, 'YES'),
      buyFill('no1', 0.5, 100, 200, 'NO'),
    ];
    const snapshot = computeTradePnl(opp, fills, null, true)!;
    store.recordTradePnl(snapshot);

    const lines = fs.readFileSync(store.getFilePath(), 'utf8').trim().split('\n');
    const record = JSON.parse(lines[0]) as { kind: string; tradePnl?: { lockedProfitUsd: number } };
    assert.equal(record.kind, 'trade_pnl');
    assert.equal(record.tradePnl?.lockedProfitUsd, 4.005);
  });
});
