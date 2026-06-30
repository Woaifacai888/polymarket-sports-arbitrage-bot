import blessed from 'blessed';

export class Dashboard {
  screen: blessed.Widgets.Screen;
  accountBox: blessed.Widgets.BoxElement;
  symbolBox: blessed.Widgets.BoxElement;
  metricsBox: blessed.Widgets.BoxElement;
  errorsBox: blessed.Widgets.BoxElement;
  statusBar: blessed.Widgets.BoxElement;

  constructor() {
    this.screen = blessed.screen({ smartCSR: true, title: 'Forex Bot Dashboard' });

    this.accountBox = blessed.box({
      top: 0,
      left: 0,
      width: '50%',
      height: '20%',
      label: ' Account ',
      border: 'line',
      style: { border: { fg: 'cyan' } },
      tags: true,
      content: 'N/A',
    });

    this.symbolBox = blessed.box({
      top: 0,
      left: '50%',
      width: '50%',
      height: '40%',
      label: ' Symbol ',
      border: 'line',
      style: { border: { fg: 'green' } },
      tags: true,
      content: 'N/A',
    });

    this.metricsBox = blessed.box({
      top: '20%',
      left: 0,
      width: '50%',
      height: '40%',
      label: ' Metrics ',
      border: 'line',
      style: { border: { fg: 'yellow' } },
      tags: true,
      content: 'N/A',
    });

    this.errorsBox = blessed.log({
      top: '60%',
      left: 0,
      width: '100%',
      height: '30%',
      label: ' Errors / Event Stream ',
      border: 'line',
      style: { border: { fg: 'red' } },
      tags: true,
      scrollable: true,
      keys: true,
      mouse: true,
      vi: true,
    });

    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'white', bg: 'blue' },
      tags: true,
      content: 'Status: starting...',
    });

    this.screen.append(this.accountBox);
    this.screen.append(this.symbolBox);
    this.screen.append(this.metricsBox);
    this.screen.append(this.errorsBox);
    this.screen.append(this.statusBar);

    this.screen.key(['C-c'], () => process.exit(0));
    this.screen.render();
  }

  updateAccount(account: any) {
    if (!account) return;
    const lines = [];
    lines.push(`Balance: {bold}${account.balance ?? 'N/A'}{/}`);
    lines.push(`Equity: {bold}${account.equity ?? 'N/A'}{/}`);
    lines.push(`Free Margin: {bold}${account.margin_free ?? 'N/A'}{/}`);
    lines.push(`Margin Level: {bold}${account.margin_level ?? 'N/A'}{/}`);
    this.accountBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  updateSymbol(info: { symbol: string; timeframe?: string; trend?: string; lastSignal?: string; position?: string; spread?: number; atr?: number; candleTime?: string }) {
    const lines = [];
    lines.push(`Symbol: {bold}${info.symbol}{/}`);
    if (info.timeframe) lines.push(`TF: {bold}${info.timeframe}{/}`);
    if (info.trend) lines.push(`Trend: {bold}${info.trend}{/}`);
    if (info.lastSignal) lines.push(`Last signal: {bold}${info.lastSignal}{/}`);
    if (info.position) lines.push(`Position: {bold}${info.position}{/}`);
    if (info.spread !== undefined) lines.push(`Spread: {bold}${info.spread.toFixed(5)}{/}`);
    if (info.atr !== undefined) lines.push(`ATR: {bold}${info.atr.toFixed(6)}{/}`);
    if (info.candleTime) lines.push(`Candle: {bold}${info.candleTime}{/}`);
    this.symbolBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  updateMetrics(text: string) {
    this.metricsBox.setContent(text);
    this.screen.render();
  }

  logError(msg: string) {
    this.errorsBox.log(msg);
    this.screen.render();
  }

  setStatus(text: string) {
    this.statusBar.setContent(text);
    this.screen.render();
  }
}

export default Dashboard;
