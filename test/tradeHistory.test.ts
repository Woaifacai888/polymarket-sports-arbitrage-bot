import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { OpportunityHistory } from '../src/portfolio/opportunityHistory.js';
import { TradeHistoryStore } from '../src/portfolio/tradeHistory.js';
import { StakeSizer } from '../src/risk/stakeSizer.js';
import { loadConfig } from '../src/config/config.js';
import type { Opportunity } from '../src/config/types.js';
import { totalLegNotional } from '../src/risk/stakeSizer.js';

function sampleOpp(): Opportunity {
  return {
    id: 'e1:complementary_pair:no1:BUY:NO|yes1:BUY:YES',
    eventId: 'e1',
    eventTitle: 'A vs B',
    relation: 'complementary_pair',
    description: 'YES+NO arb',
    legs: [
      { tokenId: 'yes1', marketId: 'm1', side: 'BUY', price: 0.45, size: 1, outcome: 'YES' },
      { tokenId: 'no1', marketId: 'm1', side: 'BUY', price: 0.5, size: 1, outcome: 'NO' },
    ],
    grossEdge: 0.05,
    netEdge: 0.04,
    detectedAt: Date.now(),
    status: 'detected',
  };
}

describe('TradeHistoryStore', () => {
  it('persists placements and fills to JSONL for the mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-'));
    const store = new TradeHistoryStore({ mode: 'sim', dir, memoryLimit: 50 });
    const opp = sampleOpp();
    store.recordPlacement(opp, 100);
    store.recordFill({
      orderId: 'o1',
      tokenId: 'yes1',
      marketId: 'm1',
      side: 'BUY',
      price: 0.45,
      size: 100,
      timestamp: Date.now(),
      mode: 'sim',
      outcome: 'YES',
    });

    assert.ok(fs.existsSync(store.getFilePath()));
    const lines = fs.readFileSync(store.getFilePath(), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const recent = store.getRecent();
    assert.equal(recent[0].kind, 'fill');
    assert.equal(recent[1].kind, 'placement');
    assert.equal(recent[1].notionalUsd, 100);

    // reload
    const reloaded = new TradeHistoryStore({ mode: 'sim', dir, memoryLimit: 50 });
    assert.ok(reloaded.getRecent().length >= 2);
  });
});

describe('OpportunityHistory', () => {
  it('keeps recently placed opportunities after live scan goes empty', () => {
    const hist = new OpportunityHistory(20);
    const live = [sampleOpp()];
    hist.upsertScan(live);
    hist.markStatus(live[0].id, 'partial', live[0]);

    const display = hist.listForDisplay([], 20);
    assert.equal(display.length, 1);
    assert.equal(display[0].status, 'partial');
    assert.equal(display[0].relation, 'complementary_pair');
  });

  it('prefers live rows and merges historical behind them', () => {
    const hist = new OpportunityHistory(20);
    const a = sampleOpp();
    const b = { ...sampleOpp(), id: 'other', relation: 'totals_ladder' as const, description: 'totals' };
    hist.upsertScan([a]);
    hist.markStatus(a.id, 'filled', a);
    const display = hist.listForDisplay([b], 20);
    assert.equal(display[0].id, 'other');
    assert.ok(display.some((o) => o.id === a.id && o.status === 'filled'));
  });
});

describe('StakeSizer $100 target', () => {
  it('sizes locked arb packages to about $100 notional', () => {
    const config = loadConfig({
      minStakeUsd: 100,
      maxPositionUsd: 500,
      kellyFraction: 0.5,
    });
    const sizer = new StakeSizer(config);
    const sized = sizer.apply(sampleOpp(), 10_000);
    const notional = totalLegNotional(sized.legs);
    assert.ok(notional >= 90 && notional <= 110, `expected ~$100 got ${notional}`);
    assert.ok(sized.legs[0].size >= 100);
  });
});
