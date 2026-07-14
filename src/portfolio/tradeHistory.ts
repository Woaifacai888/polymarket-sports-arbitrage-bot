import fs from 'node:fs';
import path from 'node:path';
import type { FillEvent, Opportunity } from '../config/types.js';

export type TradeHistoryKind = 'placement' | 'fill' | 'reject';

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
}

export interface TradeHistoryOptions {
  mode: 'sim' | 'live';
  /** Directory for JSONL files (default: data/trades) */
  dir?: string;
  /** Max in-memory records for UI (default: 200) */
  memoryLimit?: number;
}

/**
 * Append-only trade history for sim and live sessions.
 * Persists to `data/trades/{mode}-YYYY-MM-DD.jsonl` and keeps a memory ring for the UI.
 */
export class TradeHistoryStore {
  private readonly filePath: string;
  private readonly memoryLimit: number;
  private readonly records: TradeHistoryRecord[] = [];
  private seq = 0;

  constructor(private readonly options: TradeHistoryOptions) {
    const dir = options.dir ?? path.join(process.cwd(), 'data', 'trades');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.filePath = path.join(dir, `${options.mode}-${day}.jsonl`);
    this.memoryLimit = options.memoryLimit ?? 200;
    this.loadTail();
  }

  getFilePath(): string {
    return this.filePath;
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
    return this.append({
      kind: 'fill',
      opportunityId,
      fill,
      notionalUsd: fill.price * fill.size,
      status: 'filled',
    });
  }

  private append(
    partial: Omit<TradeHistoryRecord, 'id' | 'ts' | 'mode'>,
  ): TradeHistoryRecord {
    this.seq += 1;
    const record: TradeHistoryRecord = {
      id: `${this.options.mode}-${Date.now()}-${this.seq}`,
      ts: Date.now(),
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
