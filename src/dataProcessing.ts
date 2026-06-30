import type { RateBar } from '../mt5/types.js';

export interface IndicatorResult {
  maximum: number;
  minimum: number;
  average: number;
}

function nz(x: number | null | undefined, y: number | null = null): number {
  if (x === null || x === undefined || Number.isNaN(x)) {
    if (y !== null && y !== undefined && !Number.isNaN(y)) {
      return y;
    }
    return 0;
  }
  return x;
}

function cross(series1: number[], series2: number[]): boolean {
  if (series1.length < 2 || series2.length < 2) {
    return false;
  }
  const prev1 = series1[series1.length - 2];
  const curr1 = series1[series1.length - 1];
  const prev2 = series2[series2.length - 2];
  const curr2 = series2[series2.length - 1];
  return (
    (prev1 <= prev2 && curr1 > curr2) ||
    (prev1 >= prev2 && curr1 < curr2)
  );
}

function wilderAtr(bars: RateBar[], period: number): number[] {
  const tr: number[] = [];

  for (let i = 0; i < bars.length; i += 1) {
    if (i === 0) {
      tr.push(bars[i].high - bars[i].low);
      continue;
    }
    tr.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close),
      ),
    );
  }

  const atr: number[] = [];
  let sum = 0;

  for (let i = 0; i < tr.length; i += 1) {
    if (i < period) {
      sum += tr[i];
      if (i === period - 1) {
        atr.push(sum / period);
      }
      continue;
    }

    const prev = atr[atr.length - 1];
    atr.push((prev * (period - 1) + tr[i]) / period);
  }

  return atr;
}

export function atrAt(bars: RateBar[], period: number): number {
  const values = wilderAtr(bars, period);
  return values[values.length - 1] ?? 0;
}

/**
 * SuperTrend-style indicator ported from the original Python implementation.
 * Processes up to the next-to-last candle only.
 */
export function indicator(rates: RateBar[]): IndicatorResult {
  const upperLst: number[] = [Number.NaN];
  const lowerLst: number[] = [Number.NaN];
  const sptLst: number[] = [Number.NaN];
  const osLst: number[] = [Number.NaN];
  const maxLst: number[] = [Number.NaN];
  const minLst: number[] = [Number.NaN];

  let maxVal = 0;
  let minVal = 0;
  let avgVal = 0;

  for (let i = -500; i < 0; i += 1) {
    const end = rates.length + i;
    if (end <= 0) {
      continue;
    }

    const df = rates.slice(0, end);
    const src = df[df.length - 1].close;
    const currentAtr18 = atrAt(df, 18);
    const atr = currentAtr18 * 5;
    const lastBar = df[df.length - 1];
    const mid = (lastBar.high + lastBar.low) / 2;
    const up = mid + atr;
    const dn = mid - atr;

    const upper =
      df[df.length - 2].close < upperLst[upperLst.length - 1]
        ? Math.min(up, upperLst[upperLst.length - 1])
        : up;

    const lower =
      df[df.length - 2].close > lowerLst[lowerLst.length - 1]
        ? Math.max(dn, lowerLst[lowerLst.length - 1])
        : dn;

    let os: number;
    if (src > upper) {
      os = 1;
    } else if (src < lower) {
      os = 0;
    } else {
      os = osLst[osLst.length - 1];
    }

    const spt = os === 1 ? lower : upper;
    const closeSeries = df.map((bar) => bar.close);

    if (cross(closeSeries, sptLst)) {
      maxVal = nz(Math.max(maxLst[maxLst.length - 1], src), src);
      minVal = nz(Math.min(minLst[minLst.length - 1], src), src);
    } else if (os === 0) {
      maxVal = Math.min(spt, maxLst[maxLst.length - 1]);
      minVal = Math.min(src, minLst[minLst.length - 1]);
    } else {
      maxVal = Math.max(src, maxLst[maxLst.length - 1]);
      minVal = Math.max(spt, minLst[minLst.length - 1]);
    }

    avgVal = (maxVal + minVal) / 2;

    upperLst.push(upper);
    lowerLst.push(lower);
    osLst.push(os);
    sptLst.push(spt);
    maxLst.push(maxVal);
    minLst.push(minVal);
  }

  return { maximum: maxVal, minimum: minVal, average: avgVal };
}
