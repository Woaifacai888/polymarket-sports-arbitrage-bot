import blessed from 'blessed';
import type { Mt5Client } from './mt5/types.js';
import type { SymbolConfig } from './config/symbols.js';

export function createDashboard(mt5: Mt5Client, symbols: SymbolConfig[]) {
  const screen = blessed.screen({ smartCSR: true, title: 'Forex Bot Dashboard' });

  const layout = blessed.box({ top: 0, left: 0, width: '100%', height: '100%' });

  const accountBox = blessed.box({ parent: layout, top: 0, left: 0, width: '50%', height: '30%', label: 'Account', border: 'line' });
  const symbolBox = blessed.box({ parent: layout, top: 0, left: '50%', width: '50%', height: '30%', label: 'Symbol', border: 'line' });
  const infoBox = blessed.box({ parent: layout, top: '30%', left: 0, width: '100%', height: '50%', label: 'Info', border: 'line', tags: true, scrollable: true });
  const errorBox = blessed.log({ parent: layout, top: '80%', left: 0, width: '100%', height: '20%', label: 'Errors / Events', border: 'line', tags: true, keys: true, mouse: true, scrollbar: { ch: ' ', track: { bg: 'grey' } } });

  screen.append(layout);

  screen.key(['q', 'C-c'], () => process.exit(0));

  let lastTicker = 0;

  async function refresh() {
    try {
      const account = await mt5.accountInfo();
      const terminal = await mt5.terminalInfo();

      accountBox.setContent(`Balance: ${account?.balance ?? 'N/A'}\nEquity: ${account?.equity ?? 'N/A'}\nFree: ${account?.margin_free ?? 'N/A'}\nFloating PnL: ${account?.profit ?? 'N/A'}`);

      const now = Date.now();
      if (now - lastTicker > 1000) {
        // Update symbol area with first symbol status as example
        const s = symbols[0];
        symbolBox.setContent(`Symbol: ${s.symbol}\nTimeframe: ${s.timeframe}\nConnected: ${terminal?.connected ?? false}`);
        lastTicker = now;
      }

      infoBox.setContent(`Terminal: ${terminal?.name ?? 'N/A'}\nServer Time: ${terminal?.time ?? 'N/A'}\n`);
      screen.render();
    } catch (err: unknown) {
      errorBox.log(String(err));
    }
  }

  const timer = setInterval(refresh, 2000);
  refresh().catch((e) => errorBox.log(String(e)));

  return {
    stop() {
      clearInterval(timer);
      screen.destroy();
    },
  };
}
