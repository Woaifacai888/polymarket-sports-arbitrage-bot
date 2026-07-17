import { z } from 'zod';
import dotenv from 'dotenv';
import { DEFAULT_SPORT_FOCUS, parseSportFocus, type SportId } from '../model/sportsRegistry.js';

dotenv.config();

const ModeSchema = z.enum(['sim', 'live']);

export const ConfigSchema = z.object({
  mode: ModeSchema.default('sim'),
  privateKey: z.string().optional(),
  clobApiKey: z.string().optional(),
  clobApiSecret: z.string().optional(),
  clobApiPassphrase: z.string().optional(),
  builderCode: z.string().optional(),
  chain: z.string().default('polygon'),
  tagIds: z.array(z.number()).default([]),
  eventSlugs: z.array(z.string()).default([]),
  sportFocus: z.array(z.enum(['nba', 'world_cup'])).default([...DEFAULT_SPORT_FOCUS]),
  maxPositionUsd: z.number().positive().default(500),
  maxEventExposureUsd: z.number().positive().default(200),
  minNetEdgeBps: z.number().nonnegative().default(50),
  dailyLossLimitUsd: z.number().positive().default(100),
  /**
   * Default taker fee RATE in bps for Polymarket's fee curve
   * fee = shares × rate × p × (1 − p). Sports = 500 (rate 0.05).
   * Used when a market's Gamma metadata carries no feeSchedule.
   * NOTE: this is NOT a flat percent of notional.
   */
  feeBps: z.number().nonnegative().default(500),
  slippageBps: z.number().nonnegative().default(10),
  simInitialBalance: z.number().positive().default(10_000),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  logFile: z.string().default('logs/bot.log'),
  gammaBaseUrl: z.string().url().default('https://gamma-api.polymarket.com'),
  clobBaseUrl: z.string().url().default('https://clob.polymarket.com'),
  marketWsUrl: z.string().default('wss://ws-subscriptions-clob.polymarket.com/ws/market'),
  userWsUrl: z.string().default('wss://ws-subscriptions-clob.polymarket.com/ws/user'),
  tickIntervalMs: z.number().positive().default(500),
  discoveryRefreshMs: z.number().positive().default(60_000),
  maxDiscoveryEvents: z.number().positive().default(80),
  kellyFraction: z.number().positive().max(1).default(0.5),
  /** Target package notional per opportunity (USD). Locked arbs size to this. */
  minStakeUsd: z.number().nonnegative().default(100),
  confirmLive: z.boolean().default(false),
  maxOpenOrders: z.number().positive().default(20),
  maxBookAgeMs: z.number().positive().default(15_000),
  orderPlaceRetries: z.number().int().nonnegative().default(2),
  opportunityCooldownMs: z.number().positive().default(5_000),
  /** After executing an opportunity, block re-entry for this long. */
  executedCooldownMs: z.number().positive().default(120_000),
  tradeHistoryDir: z.string().default('data/trades'),
  /** When true, only pre-game (upcoming) matches are tradable; live is also excluded. */
  trackUpcomingOnly: z.boolean().default(false),
  /** Ignore games scheduled further ahead than this (lines aren't stable yet). */
  maxLookaheadHours: z.number().positive().default(24 * 14),
  /** Keep events when gameStartTime can't be resolved (fail-open vs fail-closed). */
  allowUnknownPhase: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;

function parseCsvNumbers(value: string | undefined): number[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

function parseCsvStrings(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const raw = {
    mode: process.env.MODE ?? overrides.mode,
    privateKey: process.env.PRIVATE_KEY || overrides.privateKey,
    clobApiKey: process.env.CLOB_API_KEY || overrides.clobApiKey,
    clobApiSecret: process.env.CLOB_API_SECRET || overrides.clobApiSecret,
    clobApiPassphrase: process.env.CLOB_API_PASSPHRASE || overrides.clobApiPassphrase,
    builderCode: process.env.BUILDER_CODE || overrides.builderCode,
    chain: process.env.CHAIN ?? overrides.chain,
    tagIds: overrides.tagIds ?? parseCsvNumbers(process.env.TAG_IDS),
    eventSlugs: overrides.eventSlugs ?? parseCsvStrings(process.env.EVENT_SLUGS),
    sportFocus:
      overrides.sportFocus ??
      parseSportFocus(process.env.SPORT_FOCUS ?? process.env.SPORTS_FOCUS),
    maxPositionUsd: process.env.MAX_POSITION_USD
      ? Number(process.env.MAX_POSITION_USD)
      : overrides.maxPositionUsd,
    maxEventExposureUsd: process.env.MAX_EVENT_EXPOSURE_USD
      ? Number(process.env.MAX_EVENT_EXPOSURE_USD)
      : overrides.maxEventExposureUsd,
    minNetEdgeBps: process.env.MIN_NET_EDGE_BPS
      ? Number(process.env.MIN_NET_EDGE_BPS)
      : overrides.minNetEdgeBps,
    dailyLossLimitUsd: process.env.DAILY_LOSS_LIMIT_USD
      ? Number(process.env.DAILY_LOSS_LIMIT_USD)
      : overrides.dailyLossLimitUsd,
    feeBps: process.env.FEE_BPS ? Number(process.env.FEE_BPS) : overrides.feeBps,
    slippageBps: process.env.SLIPPAGE_BPS
      ? Number(process.env.SLIPPAGE_BPS)
      : overrides.slippageBps,
    simInitialBalance: process.env.SIM_INITIAL_BALANCE
      ? Number(process.env.SIM_INITIAL_BALANCE)
      : overrides.simInitialBalance,
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) ?? overrides.logLevel,
    logFile: process.env.LOG_FILE ?? overrides.logFile,
    maxDiscoveryEvents: process.env.MAX_DISCOVERY_EVENTS
      ? Number(process.env.MAX_DISCOVERY_EVENTS)
      : overrides.maxDiscoveryEvents,
    kellyFraction: process.env.KELLY_FRACTION
      ? Number(process.env.KELLY_FRACTION)
      : overrides.kellyFraction,
    minStakeUsd: process.env.MIN_STAKE_USD
      ? Number(process.env.MIN_STAKE_USD)
      : overrides.minStakeUsd,
    confirmLive: overrides.confirmLive ?? process.env.CONFIRM_LIVE === 'true',
    maxOpenOrders: process.env.MAX_OPEN_ORDERS
      ? Number(process.env.MAX_OPEN_ORDERS)
      : overrides.maxOpenOrders,
    maxBookAgeMs: process.env.MAX_BOOK_AGE_MS
      ? Number(process.env.MAX_BOOK_AGE_MS)
      : overrides.maxBookAgeMs,
    orderPlaceRetries: process.env.ORDER_PLACE_RETRIES
      ? Number(process.env.ORDER_PLACE_RETRIES)
      : overrides.orderPlaceRetries,
    opportunityCooldownMs: process.env.OPPORTUNITY_COOLDOWN_MS
      ? Number(process.env.OPPORTUNITY_COOLDOWN_MS)
      : overrides.opportunityCooldownMs,
    executedCooldownMs: process.env.EXECUTED_COOLDOWN_MS
      ? Number(process.env.EXECUTED_COOLDOWN_MS)
      : overrides.executedCooldownMs,
    tradeHistoryDir: process.env.TRADE_HISTORY_DIR ?? overrides.tradeHistoryDir,
    trackUpcomingOnly:
      overrides.trackUpcomingOnly ??
      (process.env.TRACK_UPCOMING_ONLY != null
        ? process.env.TRACK_UPCOMING_ONLY === 'true'
        : undefined),
    maxLookaheadHours: process.env.MAX_LOOKAHEAD_HOURS
      ? Number(process.env.MAX_LOOKAHEAD_HOURS)
      : overrides.maxLookaheadHours,
    allowUnknownPhase:
      overrides.allowUnknownPhase ??
      (process.env.ALLOW_UNKNOWN_PHASE != null
        ? process.env.ALLOW_UNKNOWN_PHASE === 'true'
        : undefined),
    ...overrides,
  };

  const config = ConfigSchema.parse(raw);

  if (config.mode === 'live') {
    if (!config.privateKey) {
      throw new Error('PRIVATE_KEY is required for live mode');
    }
    if (!config.clobApiKey || !config.clobApiSecret || !config.clobApiPassphrase) {
      throw new Error('CLOB API credentials are required for live mode');
    }
    if (!config.confirmLive) {
      throw new Error(
        'Live mode requires explicit confirmation. Pass --confirm-live or set CONFIRM_LIVE=true',
      );
    }
  }

  return config;
}

export type Side = 'BUY' | 'SELL';
export type { SportId } from '../model/sportsRegistry.js';

export interface TokenRef {
  yesTokenId: string;
  noTokenId: string;
}

export interface ClassifiedMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  gameStartTime: Date | null;
  type: MarketType;
  team?: string;
  line?: number;
  side?: 'home' | 'away' | 'draw' | 'over' | 'under' | 'yes' | 'no';
  tokens: TokenRef;
  enableOrderBook: boolean;
  minimumTickSize: number;
  negRisk: boolean;
  /**
   * Taker fee rate in bps from this market's Gamma fee metadata (500 =
   * sports_fees_v2's 0.05 rate; 0 = explicitly fee-free). Undefined when the
   * API returned no fee info — consumers fall back to config.feeBps.
   */
  takerFeeRateBps?: number;
}

export type MarketType =
  | 'moneyline'
  | 'spread'
  | 'total'
  | 'draw'
  | 'btts'
  | 'other';

export interface EventGraph {
  eventId: string;
  slug: string;
  title: string;
  sportId: SportId | null;
  gameStartTime: Date | null;
  markets: ClassifiedMarket[];
  tokenIds: string[];
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  lastTradePrice?: number;
  updatedAt: number;
}

export interface Leg {
  tokenId: string;
  marketId: string;
  side: Side;
  price: number;
  size: number;
  outcome: 'YES' | 'NO';
}

export type RelationType =
  | 'complementary_pair'
  | 'totals_ladder'
  | 'spread_ladder'
  | 'moneyline_spread'
  | 'three_way_sum';

export interface Opportunity {
  id: string;
  eventId: string;
  eventTitle: string;
  relation: RelationType;
  description: string;
  legs: Leg[];
  grossEdge: number;
  netEdge: number;
  detectedAt: number;
  status: 'detected' | 'placing' | 'partial' | 'filled' | 'expired' | 'rejected';
}

export interface FillEvent {
  orderId: string;
  tokenId: string;
  marketId: string;
  side: Side;
  price: number;
  size: number;
  timestamp: number;
  mode: 'sim' | 'live';
  outcome?: 'YES' | 'NO';
  opportunityId?: string;
  /** Trading fee charged on this fill (USD). */
  feeUsd?: number;
  /** Gross notional plus fees on BUY, or net proceeds after fees on SELL. */
  allInCostUsd?: number;
}

export interface OrderRecord {
  id: string;
  tokenId: string;
  marketId: string;
  side: Side;
  price: number;
  size: number;
  filledSize: number;
  status: 'open' | 'partial' | 'filled' | 'cancelled';
  createdAt: number;
  opportunityId?: string;
  outcome?: 'YES' | 'NO';
}

export interface Position {
  tokenId: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  size: number;
  avgPrice: number;
  costBasis: number;
}

export interface PortfolioSnapshot {
  balance: number;
  positions: Position[];
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  exposure: number;
  pnlHistory: Array<{ t: number; pnl: number }>;
}

export interface EngineStatus {
  mode: 'sim' | 'live';
  paused: boolean;
  killSwitch: boolean;
  uptimeMs: number;
  wsConnected: boolean;
  userWsConnected: boolean;
  trackedEvents: number;
  trackedMarkets: number;
  trackedTokens: number;
  openOrders: number;
  opportunities: Opportunity[];
  /** Live scan + recently seen/executed (for Opportunities panel). */
  displayOpportunities: Opportunity[];
  recentFills: FillEvent[];
  tradeHistory: import('../portfolio/tradeHistory.js').TradeHistoryRecord[];
  tradeHistoryPath: string;
  alerts: string[];
  portfolio: PortfolioSnapshot;
  marketRows: MarketRow[];
  exposureLimitUsd: number;
  dailyRealizedPnl: number;
  dailyLossLimitUsd: number;
  targetOrderUsd: number;
}

export interface MarketRow {
  sport: string;
  eventTitle: string;
  marketType: MarketType;
  question: string;
  bestBid: number | null;
  bestAsk: number | null;
  impliedProb: number | null;
  /** Game lifecycle derived from gameStartTime (see model/eventPhase.ts). */
  phase: 'upcoming' | 'live' | 'finished' | 'unknown';
  /** Epoch ms of scheduled game start, if known. */
  gameStartTime: number | null;
}
