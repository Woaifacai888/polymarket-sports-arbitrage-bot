import fs from 'node:fs';
import path from 'node:path';
import type { FillEvent, Opportunity } from '../config/types.js';
import type { TradePnlSnapshot } from './arbTradePnl.js';

export type TradeHistoryKind = 'placement' | 'fill' | 'reject' | 'trade_pnl';

export interface TradeHistoryRecord {
  id: string;
  ts: number;
  mode: 'sim' | 'live';
  kind: TradeHistoryKind;
  opportunityId?: string;
  relation?: string;
  eventId?: string;
  eventTitle?: string;
  description?: string;
  status?: Opportunity['status'];
  netEdge?: number;
  grossEdge?: number;
  notionalUsd?: number;
  fill?: FillEvent;
  reason?: string;
  /** Per-arbitrage-package PnL snapshot (fee-inclusive). */
  tradePnl?: TradePnlSnapshot;
}

export interface TradeHistoryOptions {
  mode: 'sim' | 'live';
  /** Directory for JSONL files (default: data/trades) */
  dir?: string;
  /** Max in-memory records for UI (default: 200) */
  memoryLimit?: number;
  /** Time source, injectable for tests (default: Date.now) */
  clock?: () => number;
}

/**
 * Append-only trade history for sim and live sessions.
 * Persists to `data/trades/{mode}-YYYY-MM-DD.jsonl` and keeps a memory ring for the UI.
 */
export class TradeHistoryStore {
  private readonly dir: string;
  private readonly clock: () => number;
  private filePath: string;
  private currentDay: string;
  private readonly memoryLimit: number;
  private readonly records: TradeHistoryRecord[] = [];
  private seq = 0;

  constructor(private readonly options: TradeHistoryOptions) {
    this.dir = options.dir ?? path.join(process.cwd(), 'data', 'trades');
    this.clock = options.clock ?? Date.now;
    fs.mkdirSync(this.dir, { recursive: true });
    this.currentDay = this.today();
    this.filePath = this.pathForDay(this.currentDay);
    this.memoryLimit = options.memoryLimit ?? 200;
    this.loadTail();
  }

  getFilePath(): string {
    this.rollFileIfNeeded();
    return this.filePath;
  }

  private today(): string {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  private pathForDay(day: string): string {
    return path.join(this.dir, `${this.options.mode}-${day}.jsonl`);
  }

  /** 24/7 processes must not keep appending to yesterday's file after midnight UTC. */
  private rollFileIfNeeded(): void {
    const day = this.today();
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.filePath = this.pathForDay(day);
    }
  }

  getRecent(limit = 50): TradeHistoryRecord[] {
    return this.records.slice(0, limit);
  }

  recordPlacement(opportunity: Opportunity, notionalUsd: number): TradeHistoryRecord {
    return this.append({
      kind: 'placement',
      opportunityId: opportunity.id,
      relation: opportunity.relation,
      eventId: opportunity.eventId,
      eventTitle: opportunity.eventTitle,
      description: opportunity.description,
      status: opportunity.status,
      netEdge: opportunity.netEdge,
      grossEdge: opportunity.grossEdge,
      notionalUsd,
    });
  }

  recordReject(opportunity: Opportunity, reason: string): TradeHistoryRecord {
    return this.append({
      kind: 'reject',
      opportunityId: opportunity.id,
      relation: opportunity.relation,
      eventId: opportunity.eventId,
      eventTitle: opportunity.eventTitle,
      description: opportunity.description,
      status: 'rejected',
      netEdge: opportunity.netEdge,
      grossEdge: opportunity.grossEdge,
      reason,
    });
  }

  recordFill(fill: FillEvent, opportunityId?: string): TradeHistoryRecord {
    const notional = fill.allInCostUsd ?? fill.price * fill.size;
    return this.append({
      kind: 'fill',
      opportunityId: opportunityId ?? fill.opportunityId,
      fill,
      notionalUsd: notional,
      status: 'filled',
    });
  }

  recordTradePnl(snapshot: TradePnlSnapshot): TradeHistoryRecord {
    return this.append({
      kind: 'trade_pnl',
      opportunityId: snapshot.opportunityId,
      relation: snapshot.relation,
      eventId: snapshot.eventId,
      eventTitle: snapshot.eventTitle,
      description: snapshot.description,
      netEdge: snapshot.netEdge,
      grossEdge: snapshot.grossEdge,
      notionalUsd: snapshot.allInEntryUsd,
      status: snapshot.status === 'closed' ? 'filled' : snapshot.status === 'open' ? 'filled' : 'partial',
      tradePnl: snapshot,
    });
  }

  private append(
    partial: Omit<TradeHistoryRecord, 'id' | 'ts' | 'mode'>,
  ): TradeHistoryRecord {
    this.rollFileIfNeeded();
    this.seq += 1;
    const now = this.clock();
    const record: TradeHistoryRecord = {
      id: `${this.options.mode}-${now}-${this.seq}`,
      ts: now,
      mode: this.options.mode,
      ...partial,
    };
    this.records.unshift(record);
    if (this.records.length > this.memoryLimit) this.records.pop();
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  private loadTail(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const lines = fs.readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean);
      const tail = lines.slice(-this.memoryLimit);
      for (const line of tail.reverse()) {
        try {
          this.records.push(JSON.parse(line) as TradeHistoryRecord);
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      // ignore read errors on startup
    }
  }
}
