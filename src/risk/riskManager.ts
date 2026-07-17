import type { Config, EventGraph, FillEvent, Opportunity } from '../config/types.js';
import type { OrderBookStore } from '../data/orderBook.js';
import { checkOpportunityLiquidity, isBookFresh } from '../arb/liquidity.js';
import { legNotional } from '../exec/executor.js';
import { bpsToDecimal } from '../util/math.js';

export class RiskManager {
  private readonly seenOpportunities = new Map<string, number>();
  private readonly executedOpportunities = new Map<string, number>();
  private dailyRealizedPnl = 0;
  private killSwitch = false;
  private eventExposure = new Map<string, number>();
  private openOrderCount = 0;

  constructor(private readonly config: Config) {}

  resetDaily(_startBalance: number): void {
    this.dailyRealizedPnl = 0;
    this.killSwitch = false;
    this.eventExposure.clear();
    this.seenOpportunities.clear();
    this.executedOpportunities.clear();
    this.openOrderCount = 0;
  }

  /**
   * Midnight rollover for a 24/7 process: reset the daily loss counter and
   * kill switch, drop stale cooldown entries, but KEEP event exposure —
   * positions opened yesterday are still at risk today.
   */
  rollDailyCounters(): void {
    this.dailyRealizedPnl = 0;
    this.killSwitch = false;
    this.seenOpportunities.clear();
    this.executedOpportunities.clear();
  }

  recordRealizedPnl(delta: number): void {
    this.dailyRealizedPnl += delta;
    if (this.dailyRealizedPnl <= -this.config.dailyLossLimitUsd) {
      this.killSwitch = true;
    }
  }

  getDailyRealizedPnl(): number {
    return this.dailyRealizedPnl;
  }

  isKillSwitchActive(): boolean {
    return this.killSwitch;
  }

  activateKillSwitch(): void {
    this.killSwitch = true;
  }

  setOpenOrderCount(count: number): void {
    this.openOrderCount = count;
  }

  getEventExposure(eventId: string): number {
    return this.eventExposure.get(eventId) ?? 0;
  }

  releaseEventExposure(eventId: string, notional: number): void {
    const current = this.eventExposure.get(eventId) ?? 0;
    const next = Math.max(0, current - notional);
    if (next <= 0) this.eventExposure.delete(eventId);
    else this.eventExposure.set(eventId, next);
  }

  approve(
    opportunity: Opportunity,
    graph: EventGraph,
    balance: number,
    store?: OrderBookStore,
  ): {
    approved: boolean;
    reason?: string;
  } {
    if (this.killSwitch) {
      return { approved: false, reason: 'Daily loss kill-switch active' };
    }

    if (opportunity.netEdge < bpsToDecimal(this.config.minNetEdgeBps)) {
      return { approved: false, reason: 'Net edge below threshold' };
    }

    const cooldownMs = this.config.opportunityCooldownMs;
    const lastSeen = this.seenOpportunities.get(opportunity.id);
    if (lastSeen && Date.now() - lastSeen < cooldownMs) {
      return { approved: false, reason: 'Duplicate opportunity cooldown' };
    }

    // A just-executed package re-firing usually means our own fills haven't
    // propagated (or a phantom edge). Block re-entry for a longer window.
    const lastExecuted = this.executedOpportunities.get(opportunity.id);
    if (lastExecuted && Date.now() - lastExecuted < this.config.executedCooldownMs) {
      return { approved: false, reason: 'Recently executed (executed cooldown)' };
    }

    if (this.openOrderCount >= this.config.maxOpenOrders) {
      return { approved: false, reason: 'Max open orders reached' };
    }

    const notional = opportunity.legs.reduce((acc, leg) => acc + legNotional(leg), 0);
    if (notional > this.config.maxPositionUsd) {
      return { approved: false, reason: 'Position size exceeds max' };
    }
    if (notional > balance) {
      return { approved: false, reason: 'Insufficient balance' };
    }

    const eventExp = this.eventExposure.get(graph.eventId) ?? 0;
    if (eventExp + notional > this.config.maxEventExposureUsd) {
      return { approved: false, reason: 'Event exposure cap exceeded' };
    }

    if (store) {
      const freshness = isBookFresh(store, opportunity.legs, this.config.maxBookAgeMs);
      if (!freshness.fresh) {
        return { approved: false, reason: freshness.reason ?? 'Stale order book' };
      }

      const liquidity = checkOpportunityLiquidity(opportunity, store);
      if (!liquidity.ok) {
        return { approved: false, reason: liquidity.reason ?? 'Insufficient liquidity' };
      }
    }

    // Reject packages with missing/zero-priced legs (edge case)
    if (opportunity.legs.some((l) => !(l.price > 0) || !(l.size > 0))) {
      return { approved: false, reason: 'Invalid leg price or size' };
    }

    return { approved: true };
  }

  markExecuted(opportunity: Opportunity, graph: EventGraph): void {
    this.seenOpportunities.set(opportunity.id, Date.now());
    this.executedOpportunities.set(opportunity.id, Date.now());
    const notional = opportunity.legs.reduce((acc, leg) => acc + legNotional(leg), 0);
    this.eventExposure.set(graph.eventId, (this.eventExposure.get(graph.eventId) ?? 0) + notional);
  }

  onFill(fill: FillEvent): void {
    // Fills are attributed in portfolio; exposure is reserved at markExecuted.
    void fill;
  }
}
