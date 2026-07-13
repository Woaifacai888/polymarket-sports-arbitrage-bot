/* eslint-disable @typescript-eslint/no-explicit-any */
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { EngineStatus, FillEvent, MarketRow, Opportunity } from '../config/types.js';
import { formatPct, formatUsd } from '../util/math.js';

export interface DashboardOptions {
  onPauseToggle?: () => void;
  onFlatten?: () => void;
  onQuit?: () => void;
}

export class Dashboard {
  private readonly screen: any;
  private readonly grid: any;
  private readonly headerBox: any;
  private readonly marketsTable: any;
  private readonly oppsTable: any;
  private readonly pnlLine: any;
  private readonly exposureGauge: any;
  private readonly orderLog: any;
  private readonly alertLog: any;

  constructor(private readonly options: DashboardOptions = {}) {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Polymarket Cross-Line Arb Bot',
      fullUnicode: true,
    });

    this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });

    this.headerBox = this.grid.set(0, 0, 1, 12, blessed.box, {
      tags: true,
      style: { fg: 'white', bg: 'black' },
    });

    this.marketsTable = this.grid.set(1, 0, 4, 6, contrib.table, {
      keys: true,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      label: ' Tracked Markets ',
      columnSpacing: 2,
      columnWidth: [8, 16, 8, 24, 8, 8, 8],
    });

    this.oppsTable = this.grid.set(1, 6, 4, 6, contrib.table, {
      keys: true,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'green',
      label: ' Opportunities ',
      columnSpacing: 2,
      columnWidth: [14, 22, 8, 8, 10],
    });

    this.pnlLine = this.grid.set(5, 0, 3, 8, contrib.line, {
      label: ' Total PnL (realized + MTM) ',
      style: { line: 'yellow', text: 'green', baseline: 'black' },
      wholeNumbersOnly: false,
      showLegend: true,
      legend: { width: 12 },
    });

    this.exposureGauge = this.grid.set(5, 8, 3, 4, contrib.gauge, {
      label: ' Exposure ',
      stroke: 'green',
      fill: 'white',
    });

    this.orderLog = this.grid.set(8, 0, 3, 6, contrib.log, {
      fg: 'green',
      selectedFg: 'green',
      label: ' Orders / Fills ',
    });

    this.alertLog = this.grid.set(8, 6, 3, 6, contrib.log, {
      fg: 'yellow',
      selectedFg: 'yellow',
      label: ' Alerts ',
    });

    this.grid.set(11, 0, 1, 12, blessed.box, {
      tags: true,
      content:
        ' {bold}[p]{/bold} pause  {bold}[f]{/bold} flatten  {bold}[q]{/bold} quit  |  ' +
        'Depth + tick-rounded limits  |  Multi-leg rollback on fail ',
      style: { fg: 'cyan' },
    });

    this.bindKeys();
  }

  private bindKeys(): void {
    this.screen.key(['p', 'P'], () => {
      this.options.onPauseToggle?.();
      this.logAlert('Pause toggled');
    });

    this.screen.key(['f', 'F'], () => {
      this.options.onFlatten?.();
      this.logAlert('Flatten requested - cancelling all orders');
    });

    this.screen.key(['q', 'C-c'], () => {
      this.options.onQuit?.();
      this.destroy();
    });
  }

  render(status: EngineStatus): void {
    this.renderHeader(status);
    this.renderMarketsTable(status.marketRows);
    this.renderOppsTable(status.opportunities);
    this.renderPnlChart(status);
    this.renderExposureGauge(status);
    this.screen.render();
  }

  logOrder(message: string): void {
    this.orderLog.log(message);
    this.screen.render();
  }

  logAlert(message: string): void {
    this.alertLog.log(message);
    this.screen.render();
  }

  logFill(fill: FillEvent): void {
    const outcome = fill.outcome ? ` ${fill.outcome}` : '';
    this.orderLog.log(
      `${fill.mode.toUpperCase()} ${fill.side}${outcome} ${fill.size}@${fill.price.toFixed(3)} ` +
        `mkt=${fill.marketId.slice(0, 8)}`,
    );
    this.screen.render();
  }

  destroy(): void {
    this.screen.destroy();
  }

  private renderHeader(status: EngineStatus): void {
    const uptimeSec = Math.floor(status.uptimeMs / 1000);
    const modeColor = status.mode === 'live' ? '{red-fg}LIVE{/red-fg}' : '{green-fg}SIM{/green-fg}';
    const ws = status.wsConnected ? '{green-fg}UP{/green-fg}' : '{red-fg}DOWN{/red-fg}';
    const userWs =
      status.mode === 'live'
        ? status.userWsConnected
          ? '{green-fg}UP{/green-fg}'
          : '{red-fg}DOWN{/red-fg}'
        : 'n/a';
    const runState = status.killSwitch
      ? '{red-fg}KILL SWITCH{/red-fg}'
      : status.paused
        ? '{yellow-fg}PAUSED{/yellow-fg}'
        : '{green-fg}RUNNING{/green-fg}';
    const pnlColor =
      status.portfolio.totalPnl >= 0 ? '{green-fg}' : '{red-fg}';
    const dailyColor =
      status.dailyRealizedPnl >= 0 ? '{green-fg}' : '{red-fg}';

    this.headerBox.setContent(
      ` ${modeColor}  WS:${ws} User:${userWs}  ` +
        `Ev:${status.trackedEvents} Mkt:${status.trackedMarkets} Tok:${status.trackedTokens} Open:${status.openOrders}  |  ` +
        `Cash ${formatUsd(status.portfolio.balance)}  ` +
        `PnL ${pnlColor}${formatUsd(status.portfolio.totalPnl)}{/} ` +
        `(R ${formatUsd(status.portfolio.realizedPnl)} / U ${formatUsd(status.portfolio.unrealizedPnl)})  |  ` +
        `Day ${dailyColor}${formatUsd(status.dailyRealizedPnl)}{/}/${formatUsd(-status.dailyLossLimitUsd)}  ` +
        `${runState}  ${uptimeSec}s`,
    );
  }

  private renderMarketsTable(rows: MarketRow[]): void {
    const data = [
      ['Sport', 'Event', 'Type', 'Question', 'Bid', 'Ask', 'Prob'],
      ...rows.slice(0, 40).map((r) => [
        truncate(r.sport, 6),
        truncate(r.eventTitle, 14),
        r.marketType,
        truncate(r.question, 22),
        r.bestBid != null ? r.bestBid.toFixed(3) : '-',
        r.bestAsk != null ? r.bestAsk.toFixed(3) : '-',
        r.impliedProb != null ? formatPct(r.impliedProb, 1) : '-',
      ]),
    ];
    this.marketsTable.setData({ headers: data[0], data: data.slice(1) });
  }

  private renderOppsTable(opps: Opportunity[]): void {
    const data = [
      ['Relation', 'Description', 'Gross', 'Net', 'Status'],
      ...opps.slice(0, 20).map((o) => [
        o.relation,
        truncate(o.description, 20),
        formatPct(o.grossEdge, 2),
        formatPct(o.netEdge, 2),
        o.status,
      ]),
    ];
    this.oppsTable.setData({ headers: data[0], data: data.slice(1) });
  }

  private renderPnlChart(status: EngineStatus): void {
    const history = status.portfolio.pnlHistory;
    if (history.length < 2) {
      this.pnlLine.setData([
        {
          title: 'PnL',
          x: ['0', '1'],
          y: [0, status.portfolio.totalPnl],
          style: { line: 'yellow' },
        },
      ]);
      return;
    }

    const x = history.map((_, i) => String(i));
    const y = history.map((p) => p.pnl);
    this.pnlLine.setData([
      {
        title: 'PnL',
        x,
        y,
        style: { line: 'yellow' },
      },
    ]);
  }

  private renderExposureGauge(status: EngineStatus): void {
    const max = Math.max(1, status.exposureLimitUsd);
    const pct = Math.min(100, Math.round((status.portfolio.exposure / max) * 100));
    const stroke = pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'green';
    this.exposureGauge.setOptions?.({ stroke });
    this.exposureGauge.setPercent(pct);
    this.exposureGauge.setLabel(
      ` Exp ${formatUsd(status.portfolio.exposure)} / ${formatUsd(max)} `,
    );
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
