import type { Opportunity } from '../config/types.js';

/**
 * Keeps recently seen opportunities so the Opportunities panel stays useful
 * after edges vanish from the live book (common right after a fill).
 */
export class OpportunityHistory {
  private readonly byId = new Map<string, Opportunity & { lastSeenAt: number }>();

  constructor(private readonly maxEntries = 40) {}

  /** Merge a fresh scan into history; live rows win on edges, history keeps status. */
  upsertScan(live: Opportunity[]): void {
    const now = Date.now();
    for (const opp of live) {
      const prev = this.byId.get(opp.id);
      this.byId.set(opp.id, {
        ...opp,
        status: prev && prev.status !== 'detected' ? prev.status : opp.status,
        lastSeenAt: now,
      });
    }
  }

  markStatus(id: string, status: Opportunity['status'], patch?: Partial<Opportunity>): void {
    const prev = this.byId.get(id);
    if (!prev) {
      if (!patch) return;
      this.byId.set(id, {
        ...(patch as Opportunity),
        id,
        status,
        lastSeenAt: Date.now(),
      });
      return;
    }
    this.byId.set(id, { ...prev, ...patch, status, lastSeenAt: Date.now() });
  }

  /** Live opportunities first, then recent historical ones not in the live set. */
  listForDisplay(live: Opportunity[], limit = 20): Opportunity[] {
    const liveIds = new Set(live.map((o) => o.id));
    const historical = [...this.byId.values()]
      .filter((o) => !liveIds.has(o.id))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    const merged: Opportunity[] = [
      ...live,
      ...historical.map(({ lastSeenAt: _, ...opp }) => opp),
    ];

    // Trim map
    if (this.byId.size > this.maxEntries) {
      const ordered = [...this.byId.entries()].sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);
      this.byId.clear();
      for (const [id, row] of ordered.slice(0, this.maxEntries)) {
        this.byId.set(id, row);
      }
    }

    return merged.slice(0, limit);
  }
}
