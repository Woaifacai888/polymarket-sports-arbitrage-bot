/** Maximum number of concurrently open trades (per-symbol enforcement is limited). */
export const MAX_OPEN_TRADES = 3;

/** Maximum loss per trade as a fraction of account balance. */
export const MAX_LOSS_PER_TRADE_FRACTION = 0.02;

/** Maximum allowed daily drawdown fraction (informational only). */
export const MAX_DAILY_DRAWDOWN_FRACTION = 0.1;

/** Circuit breaker: number of consecutive failures before pausing new entries. */
export const CIRCUIT_BREAKER_FAILURES = 5;

/** Circuit breaker cooldown in milliseconds. */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Minimum ATR absolute threshold (tweak per symbol/timeframe). */
export const MIN_ATR = 0.00015;

/** Minimum candle body-to-range ratio to consider momentum. */
export const MIN_BODY_TO_RANGE = 0.5;

/** Number of confirmation candles required (1 = next candle). */
export const CONFIRMATION_CANDLES = 1;
