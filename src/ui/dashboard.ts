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

/** A scrollable/focusable panel: `el` owns the border+label, `focusEl` is what actually receives key/focus events. */
interface FocusablePanel {
  el: any;
  focusEl: any;
  name: string;
}

const FOCUS_BORDER_FG = 'yellow';
const DEFAULT_BORDER_FG = 'cyan';

/** Relative column widths (fractions summing to ~1) for Tracked Markets. */
const MARKET_COLUMN_RATIOS = [0.05, 0.15, 0.08, 0.35, 0.07, 0.07, 0.07, 0.16];
const MARKET_COLUMN_SPACING = 3;
const MARKET_GRID_FRACTION = 8 / 12;

/** Relative column widths (fractions summing to ~1) for Opportunities. */
const OPP_COLUMN_RATIOS = [0.2, 0.32, 0.13, 0.13, 0.22];
const OPP_COLUMN_SPACING = 2;
const OPP_GRID_FRACTION = 4 / 12;

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
  private readonly panels: FocusablePanel[] = [];
  private focusIndex = 0;

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

    // Tracked Markets gets the most screen real estate (wider + taller) so
    // Sport/Event/Type/Question/Status are readable without heavy truncation.
    this.marketsTable = this.grid.set(1, 0, 5, 8, contrib.table, {
      keys: true,
      vi: true,
      mouse: true,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      label: ' Tracked Markets ',
      columnSpacing: MARKET_COLUMN_SPACING,
      // Placeholder widths; recomputed to fill the real panel width on every render.
      columnWidth: [6, 20, 9, 34, 7, 7, 7, 12],
    });

    this.oppsTable = this.grid.set(1, 8, 5, 4, contrib.table, {
      keys: true,
      vi: true,
      mouse: true,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'green',
      label: ' Opportunities (live + recent) ',
      columnSpacing: OPP_COLUMN_SPACING,
      columnWidth: [12, 15, 6, 6, 10],
    });

    this.pnlLine = this.grid.set(6, 0, 2, 8, contrib.line, {
      label: ' Total PnL (realized + MTM) ',
      style: { line: 'yellow', text: 'green', baseline: 'black' },
      wholeNumbersOnly: false,
      showLegend: true,
      legend: { width: 12 },
    });

    this.exposureGauge = this.grid.set(6, 8, 2, 4, contrib.gauge, {
      label: ' Exposure ',
      stroke: 'green',
      fill: 'white',
    });

    this.orderLog = this.grid.set(8, 0, 3, 6, contrib.log, {
      fg: 'green',
      selectedFg: 'green',
      label: ' Orders / Fills / History ',
      keys: true,
      vi: true,
      mouse: true,
    });

    this.alertLog = this.grid.set(8, 6, 3, 6, contrib.log, {
      fg: 'yellow',
      selectedFg: 'yellow',
      label: ' Alerts ',
      keys: true,
      vi: true,
      mouse: true,
    });

    this.grid.set(11, 0, 1, 12, blessed.box, {
      tags: true,
      content:
        ' {bold}[p]{/bold} pause  {bold}[f]{/bold} flatten  {bold}[q]{/bold} quit  |  ' +
        '{bold}[1-4/Tab]{/bold} focus panel  {bold}[↑/↓/wheel/PgUp/PgDn]{/bold} scroll  |  ' +
        'Depth + tick-rounded limits  |  Multi-leg rollback on fail ',
      style: { fg: 'cyan' },
    });

    this.registerPanel(this.marketsTable, this.marketsTable.rows, 'Tracked Markets');
    this.registerPanel(this.oppsTable, this.oppsTable.rows, 'Opportunities');
    this.registerPanel(this.orderLog, this.orderLog, 'Orders / Fills / History');
    this.registerPanel(this.alertLog, this.alertLog, 'Alerts');

    this.bindKeys();
    this.focusPanel(0);
  }

  /**
   * Registers a panel as focusable/scrollable. `el` owns the border and label
   * (used for the focus-highlight color); `focusEl` is the element that
   * actually receives keypress/mouse-wheel events (for tables this is the
   * internal `.rows` list, since blessed only routes keys to `screen.focused`).
   *
   * IMPORTANT: these handlers must NOT call `screen.render()`. blessed-contrib's
   * `Table.render()` unconditionally re-invokes `.rows.focus()` on every render
   * pass whenever that row list is already focused, which re-emits 'focus'/
   * 'blur' even though nothing changed. If the handler triggered another
   * `screen.render()`, that would recurse infinitely (Table.render() ->
   * focus() -> 'focus' event -> screen.render() -> Table.render() -> ...)
   * and blow the call stack. Style mutations here are picked up on whatever
   * render pass is already in flight or the next one.
   */
  private registerPanel(el: any, focusEl: any, name: string): void {
    this.panels.push({ el, focusEl, name });
    focusEl.on('focus', () => {
      el.style.border.fg = FOCUS_BORDER_FG;
    });
    focusEl.on('blur', () => {
      el.style.border.fg = DEFAULT_BORDER_FG;
    });
  }

  private focusPanel(index: number): void {
    if (!this.panels.length) return;
    this.focusIndex = ((index % this.panels.length) + this.panels.length) % this.panels.length;
    this.panels[this.focusIndex].focusEl.focus();
    this.screen.render();
  }

  /** Scrolls the currently focused panel by a full page (PgUp/PgDn). */
  private scrollFocusedPanel(direction: 1 | -1): void {
    const panel = this.panels[this.focusIndex];
    if (!panel) return;
    const el = panel.focusEl;
    const page = Math.max(1, (el.height ?? 10) - (el.iheight ?? 2));
    el.move(direction * page);
    this.screen.render();
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

    this.screen.key(['tab'], () => this.focusPanel(this.focusIndex + 1));
    this.screen.key(['S-tab'], () => this.focusPanel(this.focusIndex - 1));
    this.panels.forEach((_, i) => {
      this.screen.key([String(i + 1)], () => this.focusPanel(i));
    });

    this.screen.key(['pageup'], () => this.scrollFocusedPanel(-1));
    this.screen.key(['pagedown'], () => this.scrollFocusedPanel(1));
  }

  render(status: EngineStatus): void {
    this.renderHeader(status);
    this.renderMarketsTable(status.marketRows);
    this.renderOppsTable(status.displayOpportunities?.length ? status.displayOpportunities : status.opportunities);
    this.renderPnlChart(status);
    this.renderExposureGauge(status);
    this.oppsTable.setLabel(
      ` Opportunities live:${status.opportunities.length} shown:${(status.displayOpportunities ?? status.opportunities).length} `,
    );
    this.screen.render();
  }

  logOrder(message: string): void {
    this.appendLog(this.orderLog, message);
  }

  logAlert(message: string): void {
    this.appendLog(this.alertLog, message);
  }

  logFill(fill: FillEvent): void {
    const outcome = fill.outcome ? ` ${fill.outcome}` : '';
    this.appendLog(
      this.orderLog,
      `${fill.mode.toUpperCase()} ${fill.side}${outcome} ${fill.size}@${fill.price.toFixed(3)} ` +
        `mkt=${fill.marketId.slice(0, 8)}`,
    );
  }

  /**
   * Appends a line to a contrib.log widget without yanking the user's scroll
   * position: if they've scrolled up to review history, new lines still
   * accumulate in the buffer but the viewport stays put. Auto-follows
   * (tail -f style) only while already at the bottom.
   */
  private appendLog(el: any, message: string): void {
    const wasAtBottom = this.isScrolledToBottom(el);
    const prevScroll = el.getScroll();
    el.log(message);
    if (!wasAtBottom) {
      el.scrollTo(prevScroll);
    }
    this.screen.render();
  }

  private isScrolledToBottom(el: any): boolean {
    const innerHeight = (el.height ?? 0) - (el.iheight ?? 0);
    if (el.getScrollHeight() <= innerHeight) return true;
    return el.getScrollPerc() >= 99;
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
        `Order~${formatUsd(status.targetOrderUsd)}  Cash ${formatUsd(status.portfolio.balance)}  ` +
        `PnL ${pnlColor}${formatUsd(status.portfolio.totalPnl)}{/} ` +
        `(R ${formatUsd(status.portfolio.realizedPnl)} / U ${formatUsd(status.portfolio.unrealizedPnl)})  |  ` +
        `Day ${dailyColor}${formatUsd(status.dailyRealizedPnl)}{/}/${formatUsd(-status.dailyLossLimitUsd)}  ` +
        `${runState}  ${uptimeSec}s`,
    );
  }

  /**
   * Recomputes column widths from the table's real rendered width so columns
   * fill the panel (no dead space) and stay clearly separated by
   * `columnSpacing`, regardless of terminal size.
   */
  private computeColumnWidths(
    table: any,
    gridFraction: number,
    ratios: number[],
    spacing: number,
  ): number[] {
    const screenWidth = typeof this.screen.width === 'number' && this.screen.width > 0
      ? this.screen.width
      : 120;
    const raw = typeof table.width === 'number' && table.width > 0
      ? table.width
      : Math.floor(screenWidth * gridFraction);
    // Account for table border/padding (~4 cols) so text never clips the frame.
    const innerWidth = Math.max(30, raw - 4);
    const usable = Math.max(20, innerWidth - spacing * (ratios.length - 1));
    return ratios.map((r) => Math.max(4, Math.floor(usable * r)));
  }

  private renderMarketsTable(rows: MarketRow[]): void {
    const widths = this.computeColumnWidths(
      this.marketsTable,
      MARKET_GRID_FRACTION,
      MARKET_COLUMN_RATIOS,
      MARKET_COLUMN_SPACING,
    );
    const headers = ['Sport', 'Event', 'Type', 'Question', 'Bid', 'Ask', 'Prob', 'Status'];

    const data = [
      headers.map((h, i) => truncate(h, widths[i])),
      ...rows.slice(0, 80).map((r) => [
        truncate(r.sport, widths[0]),
        truncate(r.eventTitle, widths[1]),
        truncate(r.marketType, widths[2]),
        truncate(r.question, widths[3]),
        truncate(r.bestBid != null ? r.bestBid.toFixed(3) : '-', widths[4]),
        truncate(r.bestAsk != null ? r.bestAsk.toFixed(3) : '-', widths[5]),
        truncate(r.impliedProb != null ? formatPct(r.impliedProb, 1) : '-', widths[6]),
        truncate(formatMarketStatus(r.phase, r.gameStartTime), widths[7]),
      ]),
    ];

    this.marketsTable.options.columnWidth = widths;
    this.marketsTable.options.columnSpacing = MARKET_COLUMN_SPACING;
    this.marketsTable.setData({ headers: data[0], data: data.slice(1) });
    this.marketsTable.setLabel(` Tracked Markets (${rows.length}) `);
  }

  private renderOppsTable(opps: Opportunity[]): void {
    const widths = this.computeColumnWidths(
      this.oppsTable,
      OPP_GRID_FRACTION,
      OPP_COLUMN_RATIOS,
      OPP_COLUMN_SPACING,
    );
    const headers = ['Relation', 'Description', 'Gross', 'Net', 'Status'];

    const data = [
      headers.map((h, i) => truncate(h, widths[i])),
      ...opps.slice(0, 20).map((o) => [
        truncate(o.relation, widths[0]),
        truncate(o.description, widths[1]),
        truncate(formatPct(o.grossEdge, 1), widths[2]),
        truncate(formatPct(o.netEdge, 1), widths[3]),
        truncate(o.status, widths[4]),
      ]),
    ];

    this.oppsTable.options.columnWidth = widths;
    this.oppsTable.options.columnSpacing = OPP_COLUMN_SPACING;
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

/** Human-readable game status for the Tracked Markets Status column. */
function formatMarketStatus(phase: MarketRow['phase'], gameStartTime: number | null): string {
  if (phase === 'finished') return 'FINISHED';
  if (phase === 'unknown' || gameStartTime == null) return '-';

  const diffMs = Math.abs(Date.now() - gameStartTime);
  const duration = formatDuration(diffMs);
  return phase === 'live' ? `LIVE ${duration}` : `in ${duration}`;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}
