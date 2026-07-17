export function add(a: number, b: number): number {
  return round(a + b);
}

export function sub(a: number, b: number): number {
  return round(a - b);
}

export function mul(a: number, b: number): number {
  return round(a * b);
}

export function div(a: number, b: number): number {
  return round(a / b);
}

function round(n: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) return price;
  return Math.round(price / tickSize) * tickSize;
}

export function bpsToDecimal(bps: number): number {
  return bps / 10_000;
}

/**
 * Polymarket taker fee in USDC: fee = shares × feeRate × p × (1 − p).
 * Takers only — makers are never charged. `feeRateBps` is the category fee
 * rate in basis points (sports = 500 → rate 0.05, per sports_fees_v2).
 * The fee peaks at p = 0.50 and falls toward zero at the extremes, so a flat
 * percent-of-notional approximation badly underestimates fees exactly where
 * complementary-pair arbs occur (mid-range prices).
 */
export function takerFeeUsd(price: number, size: number, feeRateBps: number): number {
  return mul(mul(size, bpsToDecimal(feeRateBps)), mul(price, 1 - price));
}

export function applySlippage(price: number, slippageBps: number, side: 'BUY' | 'SELL'): number {
  const factor = bpsToDecimal(slippageBps);
  return side === 'BUY' ? mul(price, 1 + factor) : mul(price, 1 - factor);
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => add(acc, v), 0);
}

export function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatUsd(value: number, digits = 2): string {
  return `$${value.toFixed(digits)}`;
}

export function formatPct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatBps(value: number): string {
  return `${(value * 10_000).toFixed(1)} bps`;
}
