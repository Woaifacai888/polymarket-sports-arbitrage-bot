import type { Config, EngineStatus, EventGraph, FillEvent, MarketRow, Opportunity } from '../config/types.js';
import { ArbDetector } from '../arb/detector.js';
import { clampLegsToLiquidity } from '../arb/liquidity.js';
import { ClobRestClient } from '../data/clobRest.js';
import { GammaClient } from '../data/gammaClient.js';
import { MarketSocket } from '../data/marketSocket.js';
import { OrderBookStore } from '../data/orderBook.js';
import { UserSocket } from '../data/userSocket.js';
import { buildEventGraphs, flattenTokenIds } from '../model/eventGraph.js';
import { filterTrackableGraphs, getEventPhase } from '../model/eventPhase.js';
import { SPORT_PROFILES } from '../model/sportsRegistry.js';
import { OpportunityHistory } from '../portfolio/opportunityHistory.js';
import { PortfolioTracker } from '../portfolio/positions.js';
import { TradeHistoryStore } from '../portfolio/tradeHistory.js';
import { RiskManager } from '../risk/riskManager.js';
import { StakeSizer, totalLegNotional } from '../risk/stakeSizer.js';
import type { ExecutionEngine } from '../exec/executor.js';
import { LiveExecutor, createLiveClobClient } from '../exec/liveExecutor.js';
import { OrderManager } from '../exec/orderManager.js';
import { SimExecutor } from '../exec/simExecutor.js';
import { Dashboard } from '../ui/dashboard.js';
import { getLogger, initLogger } from '../util/logger.js';

export class Engine {
  private readonly store = new OrderBookStore();
  private readonly gamma: GammaClient;
  private readonly rest: ClobRestClient;
  private readonly detector: ArbDetector;
  private readonly risk: RiskManager;
  private readonly stakeSizer: StakeSizer;
  private readonly portfolio: PortfolioTracker;
  private readonly tradeHistory: TradeHistoryStore;
  private readonly opportunityHistory = new OpportunityHistory(40);
  private readonly executor: ExecutionEngine;
  private readonly orderManager: OrderManager;
  private simExecutor: SimExecutor | null = null;
  private liveExecutor: LiveExecutor | null = null;
  private marketSocket: MarketSocket | null = null;
  private userSocket: UserSocket | null = null;
  private dashboard: Dashboard | null = null;

  private graphs: EventGraph[] = [];
  private opportunities: Opportunity[] = [];
  private recentFills: FillEvent[] = [];
  private alerts: string[] = [];
  private paused = false;
  private running = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private readonly startTime = Date.now();

  constructor(private readonly config: Config) {
    initLogger(config);
    this.gamma = new GammaClient(config);
    this.rest = new ClobRestClient(config, this.store);
    this.detector = new ArbDetector(config);
    this.risk = new RiskManager(config);
    this.stakeSizer = new StakeSizer(config);
    this.portfolio = new PortfolioTracker(config.simInitialBalance);
    this.tradeHistory = new TradeHistoryStore({
      mode: config.mode,
      dir: config.tradeHistoryDir,
    });

    if (config.mode === 'live') {
      this.liveExecutor = new LiveExecutor({
        createClient: () => createLiveClobClient(config),
      });
      this.executor = this.liveExecutor;
    } else {
      this.simExecutor = new SimExecutor(config, this.store);
      this.executor = this.simExecutor;
    }

    this.orderManager = new OrderManager(this.executor, {
      placeRetries: config.orderPlaceRetries,
      rollbackOnFailure: true,
    });
    this.risk.resetDaily(
      config.mode === 'sim' ? config.simInitialBalance : this.executor.getBalance(),
    );
  }

  async start(): Promise<void> {
    this.running = true;
    const log = getLogger();

    if (this.liveExecutor) {
      await this.liveExecutor.init();
    }

    this.dashboard = new Dashboard({
      onPauseToggle: () => {
        this.paused = !this.paused;
      },
      onFlatten: () => {
        void this.executor.cancelAll();
        this.addAlert('All orders cancelled (flatten)');
      },
      onQuit: () => {
        void this.stop();
      },
    });

    this.executor.onFill((fill) => this.handleFill(fill));

    await this.refreshDiscovery();
    await this.startMarketData();

    if (this.config.mode === 'live' && this.liveExecutor && this.config.clobApiKey) {
      this.userSocket = new UserSocket(
        this.config,
        {
          apiKey: this.config.clobApiKey,
          secret: this.config.clobApiSecret!,
          passphrase: this.config.clobApiPassphrase!,
        },
        {
          onConnect: () => this.addAlert('User WS connected'),
          onDisconnect: () => this.addAlert('User WS disconnected'),
          onFill: (fill) => this.liveExecutor?.handleExternalFill(fill),
          onAlert: (msg) => this.addAlert(msg),
        },
      );
      const conditionIds = [...new Set(this.graphs.flatMap((g) => g.markets.map((m) => m.conditionId)))];
      await this.userSocket.start(conditionIds);
    }

    this.tickTimer = setInterval(() => {
      void this.tick();
    }, this.config.tickIntervalMs);

    this.discoveryTimer = setInterval(() => {
      void this.refreshDiscovery();
    }, this.config.discoveryRefreshMs);

    log.info({ mode: this.config.mode }, 'Engine started');
    this.addAlert(`Engine started in ${this.config.mode.toUpperCase()} mode`);
    this.addAlert(`Target order size $${this.config.minStakeUsd}`);
    this.addAlert(`Trade history → ${this.tradeHistory.getFilePath()}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.marketSocket?.stop();
    this.userSocket?.stop();
    await this.executor.cancelAll();
    this.dashboard?.destroy();
    getLogger().info('Engine stopped');
  }

  private async refreshDiscovery(): Promise<void> {
    try {
      const events = await this.gamma.discoverEvents();
      const rawGraphs = buildEventGraphs(events, this.config.sportFocus);
      if (rawGraphs.length === 0) {
        getLogger().warn('Discovery returned no tradable sports events; keeping previous graph');
        this.addAlert(
          this.graphs.length > 0
            ? `Discovery refresh: no new events (keeping ${this.graphs.length})`
            : 'Discovery refresh: 0 events — check network or TAG_IDS',
        );
        return;
      }

      const { kept, skipped } = filterTrackableGraphs(rawGraphs, {
        trackUpcomingOnly: this.config.trackUpcomingOnly,
        maxLookaheadMs: this.config.maxLookaheadHours * 60 * 60 * 1000,
        allowUnknownPhase: this.config.allowUnknownPhase,
      });

      if (kept.length === 0 && skipped.length > 0) {
        getLogger().warn(
          { skipped: skipped.length },
          'All discovered events filtered out as live/finished/too-far-ahead; keeping previous graph',
        );
        this.addAlert(
          `Discovery refresh: ${skipped.length} events found but none upcoming (live/finished/out-of-window)`,
        );
        return;
      }

      this.graphs = kept;
      const tokenIds = flattenTokenIds(this.graphs);

      if (tokenIds.length > 0) {
        await this.rest.fetchBooks(tokenIds);
        await this.marketSocket?.resubscribe(tokenIds);
      }

      this.addAlert(
        `Discovery refresh: ${this.graphs.length} upcoming events, ${tokenIds.length} tokens ` +
          `(${formatSportCounts(this.graphs)})` +
          (skipped.length > 0 ? ` — skipped ${skipped.length} live/finished` : ''),
      );

      for (const s of skipped.slice(0, 5)) {
        getLogger().info({ event: s.graph.slug, phase: s.phase, reason: s.reason }, 'Skipped non-upcoming event');
      }
    } catch (error) {
      getLogger().error({ error }, 'Discovery refresh failed');
      this.addAlert('Discovery refresh failed');
    }
  }

  private async startMarketData(): Promise<void> {
    const tokenIds = flattenTokenIds(this.graphs);
    await this.rest.fetchBooks(tokenIds);

    this.marketSocket = new MarketSocket(this.config, this.store, {
      onConnect: () => this.addAlert('Market WS connected'),
      onDisconnect: () => this.addAlert('Market WS disconnected'),
      onAlert: (msg) => this.addAlert(msg),
    });

    await this.marketSocket.start(tokenIds);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    this.simExecutor?.processRestingOrders();
    this.risk.setOpenOrderCount(this.executor.getOpenOrders().length);

    for (const graph of this.graphs) {
      await this.orderManager.cancelAllAtGameStart(graph);
    }

    // Defensive real-time check: a game can go live between discovery
    // refreshes (up to discoveryRefreshMs stale). Never scan for arbs on
    // matches that have started or finished, even if still in this.graphs.
    const scanGraphs = this.config.trackUpcomingOnly
      ? this.graphs.filter((g) => getEventPhase(g) === 'upcoming' || getEventPhase(g) === 'unknown')
      : this.graphs;

    this.opportunities = this.detector.scan(scanGraphs, this.store);
    this.opportunityHistory.upsertScan(this.opportunities);

    if (!this.paused && !this.risk.isKillSwitchActive()) {
      for (const opp of this.opportunities.slice(0, 3)) {
        const graph = scanGraphs.find((g) => g.eventId === opp.eventId);
        if (!graph) continue;

        const bankroll = Math.max(this.portfolio.getBalance(), this.executor.getBalance());
        let sized = this.stakeSizer.apply(opp, bankroll);
        // Prefer $100 target, but never request more size than visible ask depth.
        sized = clampLegsToLiquidity(sized, this.store);
        const notional = totalLegNotional(sized.legs);
        // Skip dust after depth clamp; prefer full $target when book allows.
        if (notional < 10) {
          continue;
        }

        const decision = this.risk.approve(sized, graph, bankroll, this.store);
        if (!decision.approved) {
          if (decision.reason && !decision.reason.includes('cooldown')) {
            this.opportunityHistory.markStatus(sized.id, 'rejected', sized);
          }
          continue;
        }
        if (this.orderManager.isInFlight(sized.id)) continue;

        const metaByMarket = new Map(
          graph.markets.map((m) => [m.id, { tickSize: m.minimumTickSize, negRisk: m.negRisk }]),
        );

        const ok = await this.orderManager.executeOpportunity(sized, metaByMarket);
        if (ok) {
          this.risk.markExecuted(sized, graph);
          this.opportunityHistory.markStatus(sized.id, sized.status, sized);
          this.tradeHistory.recordPlacement(sized, totalLegNotional(sized.legs));
          this.dashboard?.logOrder(
            `Placed ${sized.relation} $${totalLegNotional(sized.legs).toFixed(0)}: ${sized.description}`,
          );
        } else {
          this.opportunityHistory.markStatus(sized.id, 'rejected', sized);
          this.tradeHistory.recordReject(sized, 'placement failed');
          this.dashboard?.logOrder(`Rejected ${sized.relation}: placement failed`);
        }
      }
    }

    if (this.risk.isKillSwitchActive()) {
      this.addAlert('KILL SWITCH: daily loss limit hit');
    }

    const status = this.buildStatus();
    this.dashboard?.render(status);
  }

  private handleFill(fill: FillEvent): void {
    const realizedBefore = this.portfolio.getRealizedPnl();
    this.portfolio.applyFill(fill);
    const realizedDelta = this.portfolio.getRealizedPnl() - realizedBefore;
    if (realizedDelta !== 0) {
      this.risk.recordRealizedPnl(realizedDelta);
    }
    if (this.simExecutor) {
      this.portfolio.setBalance(this.executor.getBalance());
    }
    this.risk.onFill(fill);
    this.tradeHistory.recordFill(fill);
    this.recentFills.unshift(fill);
    if (this.recentFills.length > 50) this.recentFills.pop();
    this.dashboard?.logFill(fill);
  }

  private buildStatus(): EngineStatus {
    const portfolio = this.portfolio.snapshot(this.store);
    const displayOpportunities = this.opportunityHistory.listForDisplay(this.opportunities, 20);
    return {
      mode: this.config.mode,
      paused: this.paused,
      killSwitch: this.risk.isKillSwitchActive(),
      uptimeMs: Date.now() - this.startTime,
      wsConnected: this.marketSocket?.connected ?? false,
      userWsConnected: this.userSocket?.connected ?? false,
      trackedEvents: this.graphs.length,
      trackedMarkets: this.graphs.reduce((n, g) => n + g.markets.length, 0),
      trackedTokens: flattenTokenIds(this.graphs).length,
      openOrders: this.executor.getOpenOrders().length,
      opportunities: this.opportunities,
      displayOpportunities,
      recentFills: this.recentFills,
      tradeHistory: this.tradeHistory.getRecent(30),
      tradeHistoryPath: this.tradeHistory.getFilePath(),
      alerts: this.alerts.slice(-20),
      portfolio,
      marketRows: this.buildMarketRows(),
      exposureLimitUsd: this.config.maxEventExposureUsd,
      dailyRealizedPnl: this.risk.getDailyRealizedPnl(),
      dailyLossLimitUsd: this.config.dailyLossLimitUsd,
      targetOrderUsd: this.config.minStakeUsd,
    };
  }

  private buildMarketRows(): MarketRow[] {
    const rows: MarketRow[] = [];
    for (const graph of this.graphs) {
      for (const market of graph.markets) {
        const yesBid = this.store.bestBid(market.tokens.yesTokenId);
        const yesAsk = this.store.bestAsk(market.tokens.yesTokenId);
        rows.push({
          sport: graph.sportId ? SPORT_PROFILES[graph.sportId].label : '-',
          eventTitle: graph.title,
          marketType: market.type,
          question: market.question,
          bestBid: yesBid,
          bestAsk: yesAsk,
          impliedProb: this.store.impliedProb(market.tokens.yesTokenId),
        });
      }
    }
    return rows;
  }

  private addAlert(message: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    this.alerts.push(`[${ts}] ${message}`);
    if (this.alerts.length > 100) this.alerts.shift();
    this.dashboard?.logAlert(message);
  }
}

export function parseCliArgs(argv: string[]): {
  mode?: 'sim' | 'live';
  tagIds?: number[];
  eventSlugs?: string[];
  confirmLive?: boolean;
} {
  const result: ReturnType<typeof parseCliArgs> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode' && argv[i + 1]) {
      result.mode = argv[++i] as 'sim' | 'live';
    } else if (arg === '--tag' && argv[i + 1]) {
      result.tagIds = result.tagIds ?? [];
      result.tagIds.push(Number(argv[++i]));
    } else if (arg === '--event' && argv[i + 1]) {
      result.eventSlugs = result.eventSlugs ?? [];
      result.eventSlugs.push(argv[++i]);
    } else if (arg === '--confirm-live') {
      result.confirmLive = true;
    }
  }

  return result;
}

function formatSportCounts(graphs: EventGraph[]): string {
  const counts = new Map<string, number>();
  for (const graph of graphs) {
    const label = graph.sportId ? SPORT_PROFILES[graph.sportId].label : 'Other';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => `${label}:${n}`).join(', ');
}
