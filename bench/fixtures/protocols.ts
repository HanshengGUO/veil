/**
 * Calibration backtester for bench tasks.
 *
 * This exists to answer one question before any agent is involved: **does this trap actually bite?**
 * A task where an unconstrained pipeline cannot produce a flattering number measures nothing, so
 * every trap task is calibrated here first, and the observed figure becomes its
 * `naive_outcome.expected_sharpe_min`.
 *
 * It is deliberately not the real engine. Stage 2 builds that, with point-in-time views and windows
 * where future rows are absent rather than merely unused. This one only needs to be honest enough to
 * measure the size of a mistake, and it expresses each mistake as a single flag so the difference is
 * attributable.
 *
 * Determinism rule: only + - * / and sqrt.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Panel {
  dates: string[];
  tickers: string[];
  close: Float64Array;
  ret: Float64Array;
  tradable: Uint8Array;
  inUniverse: Uint8Array;
  survivor: Uint8Array;
}

export interface Protocol {
  universe: "point-in-time" | "current-members";
  direction: "long-short" | "long-only";
  /**
   * How instruments are scored.
   * - `rank`: order by the standardised signal directly. No fitting, so a purge gap changes nothing.
   * - `ols`: fit a small ridge regression of the forward label on all lookback signals, in-sample,
   *   then apply the coefficients out of sample. Fitting is what makes a purge gap matter: without
   *   one, the last in-sample labels reach into the test window and the coefficients have seen it.
   */
  model: "rank" | "ols";
  /** Per-instrument standardisation of the signal over time. */
  standardize: "expanding" | "full-sample";
  /** How position size is set. Full-sample volatility knows which periods turn out calm. */
  sizing: "equal" | "trailing-vol" | "full-sample-vol";
  execution: "next-bar" | "same-bar";
  maskUntradable: boolean;
  /** Trading days between rebalances. Smaller than labelHorizon means overlapping books. */
  rebalanceEvery: number;
  /** Holding period in trading days, and the label horizon the model is fit against. */
  labelHorizon: number;
  /** Purge plus embargo between the in-sample window and the test window. */
  gapDays: number;
  parameters: "locked-per-fold" | "chosen-on-full-sample";
  evaluate: "out-of-sample" | "full-sample";
  costBps: number;
  lookbacks: number[];
  /** Ridge penalty for `ols`. Small but non-zero so the normal equations stay solvable. */
  ridge?: number;
}

export interface Metrics {
  sharpe: number;
  annualReturn: number;
  annualVolatility: number;
  maxDrawdown: number;
  annualTurnover: number;
  tradingDays: number;
}

export interface ProtocolResult extends Metrics {
  lookbacksUsed: number[];
  foldSharpes: number[];
}

const TRADING_DAYS_PER_YEAR = 252;
const WARMUP_DAYS = 30;
const VOL_WINDOW = 60;

function parseCsv(path: string): string[][] {
  const text = readFileSync(path, "utf8").trim();
  const lines = text.split("\n");
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) rows.push(lines[i].split(","));
  return rows;
}

export function loadPanel(dataDir: string): Panel {
  const priceRows = parseCsv(join(dataDir, "prices.csv"));
  const universeRows = parseCsv(join(dataDir, "universe_history.csv"));
  const survivorRows = parseCsv(join(dataDir, "universe_current.csv"));

  const dateSet = new Set<string>();
  const tickerSet = new Set<string>();
  for (const row of priceRows) {
    dateSet.add(row[0]);
    tickerSet.add(row[1]);
  }
  const dates = [...dateSet].sort();
  const tickers = [...tickerSet].sort();
  const dateIndex = new Map(dates.map((date, i) => [date, i]));
  const tickerIndex = new Map(tickers.map((ticker, i) => [ticker, i]));
  const n = tickers.length;

  const close = new Float64Array(dates.length * n).fill(Number.NaN);
  const ret = new Float64Array(dates.length * n).fill(Number.NaN);
  const tradable = new Uint8Array(dates.length * n);
  const inUniverse = new Uint8Array(dates.length * n);
  const survivor = new Uint8Array(n);

  for (const row of priceRows) {
    const t = dateIndex.get(row[0]) as number;
    const i = tickerIndex.get(row[1]) as number;
    close[t * n + i] = Number(row[2]);
    tradable[t * n + i] = row[4] === "true" ? 1 : 0;
  }
  for (const row of universeRows) {
    const t = dateIndex.get(row[0]);
    const i = tickerIndex.get(row[1]);
    if (t !== undefined && i !== undefined) inUniverse[t * n + i] = 1;
  }
  for (const row of survivorRows) {
    const i = tickerIndex.get(row[0]);
    if (i !== undefined) survivor[i] = 1;
  }

  for (let t = 1; t < dates.length; t++) {
    for (let i = 0; i < n; i++) {
      const previous = close[(t - 1) * n + i];
      const current = close[t * n + i];
      if (Number.isFinite(previous) && Number.isFinite(current) && previous > 0) {
        ret[t * n + i] = current / previous - 1;
      }
    }
  }

  return { dates, tickers, close, ret, tradable, inUniverse, survivor };
}

interface SignalTables {
  raw: Float64Array;
  expandingMean: Float64Array;
  expandingStd: Float64Array;
  fullMean: Float64Array;
  fullStd: Float64Array;
}

function buildSignal(panel: Panel, lookback: number): SignalTables {
  const n = panel.tickers.length;
  const days = panel.dates.length;
  const cells = days * n;
  const raw = new Float64Array(cells).fill(Number.NaN);
  const expandingMean = new Float64Array(cells).fill(Number.NaN);
  const expandingStd = new Float64Array(cells).fill(Number.NaN);
  const fullMean = new Float64Array(n).fill(Number.NaN);
  const fullStd = new Float64Array(n).fill(Number.NaN);

  const count = new Float64Array(n);
  const sum = new Float64Array(n);
  const sumSquares = new Float64Array(n);

  for (let t = lookback; t < days; t++) {
    for (let i = 0; i < n; i++) {
      const past = panel.close[(t - lookback) * n + i];
      const now = panel.close[t * n + i];
      if (!Number.isFinite(past) || !Number.isFinite(now) || past <= 0) continue;
      const value = now / past - 1;
      raw[t * n + i] = value;
      count[i] += 1;
      sum[i] += value;
      sumSquares[i] += value * value;
      if (count[i] >= 20) {
        const mean = sum[i] / count[i];
        const variance = sumSquares[i] / count[i] - mean * mean;
        expandingMean[t * n + i] = mean;
        expandingStd[t * n + i] = variance > 0 ? Math.sqrt(variance) : Number.NaN;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (count[i] < 20) continue;
    const mean = sum[i] / count[i];
    const variance = sumSquares[i] / count[i] - mean * mean;
    fullMean[i] = mean;
    fullStd[i] = variance > 0 ? Math.sqrt(variance) : Number.NaN;
  }

  return { raw, expandingMean, expandingStd, fullMean, fullStd };
}

/** Realised volatility per instrument: trailing over VOL_WINDOW, and over the whole sample. */
function buildVolatility(panel: Panel): { trailing: Float64Array; full: Float64Array } {
  const n = panel.tickers.length;
  const days = panel.dates.length;
  const trailing = new Float64Array(days * n).fill(Number.NaN);
  const full = new Float64Array(n).fill(Number.NaN);

  for (let i = 0; i < n; i++) {
    let count = 0;
    let sum = 0;
    let sumSquares = 0;
    for (let t = 0; t < days; t++) {
      const value = panel.ret[t * n + i];
      if (Number.isFinite(value)) {
        count += 1;
        sum += value;
        sumSquares += value * value;
      }
      if (t >= VOL_WINDOW) {
        let windowCount = 0;
        let windowSum = 0;
        let windowSquares = 0;
        for (let k = t - VOL_WINDOW + 1; k <= t; k++) {
          const past = panel.ret[k * n + i];
          if (!Number.isFinite(past)) continue;
          windowCount += 1;
          windowSum += past;
          windowSquares += past * past;
        }
        if (windowCount >= 20) {
          const mean = windowSum / windowCount;
          const variance = windowSquares / windowCount - mean * mean;
          if (variance > 0) trailing[t * n + i] = Math.sqrt(variance);
        }
      }
    }
    if (count >= 20) {
      const mean = sum / count;
      const variance = sumSquares / count - mean * mean;
      if (variance > 0) full[i] = Math.sqrt(variance);
    }
  }

  return { trailing, full };
}

const signalCache = new WeakMap<Panel, Map<number, SignalTables>>();
const volatilityCache = new WeakMap<Panel, { trailing: Float64Array; full: Float64Array }>();

function signalFor(panel: Panel, lookback: number): SignalTables {
  let perPanel = signalCache.get(panel);
  if (!perPanel) {
    perPanel = new Map();
    signalCache.set(panel, perPanel);
  }
  const cached = perPanel.get(lookback);
  if (cached) return cached;
  const built = buildSignal(panel, lookback);
  perPanel.set(lookback, built);
  return built;
}

function volatilityFor(panel: Panel): { trailing: Float64Array; full: Float64Array } {
  const cached = volatilityCache.get(panel);
  if (cached) return cached;
  const built = buildVolatility(panel);
  volatilityCache.set(panel, built);
  return built;
}

/** Standardised signal for one instrument at one date, or NaN when unavailable. */
function featureAt(
  panel: Panel,
  protocol: Protocol,
  lookback: number,
  t: number,
  i: number,
): number {
  const n = panel.tickers.length;
  const tables = signalFor(panel, lookback);
  const cell = t * n + i;
  const value = tables.raw[cell];
  if (!Number.isFinite(value)) return Number.NaN;
  const mean =
    protocol.standardize === "expanding" ? tables.expandingMean[cell] : tables.fullMean[i];
  const std = protocol.standardize === "expanding" ? tables.expandingStd[cell] : tables.fullStd[i];
  if (!Number.isFinite(mean) || !Number.isFinite(std) || std <= 0) return Number.NaN;
  return (value - mean) / std;
}

/**
 * Ridge fit of the forward label on all lookback signals, over `[from, to)`.
 *
 * The purge gap is not implemented here: it is already expressed by the caller shortening `to`.
 * Observations near the end carry labels that reach `labelHorizon` days further, so when the gap is
 * zero those labels fall inside the test window and the coefficients have seen it. That is the leak.
 */
function fitCoefficients(panel: Panel, protocol: Protocol, from: number, to: number): number[] {
  const n = panel.tickers.length;
  const k = protocol.lookbacks.length;
  const ridge = protocol.ridge ?? 1e-6;
  const size = k + 1;
  const xtx: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const xty = new Array<number>(size).fill(0);

  for (let t = from; t < to; t += protocol.rebalanceEvery) {
    const labelDay = t + protocol.labelHorizon;
    if (labelDay >= panel.dates.length) break;
    for (let i = 0; i < n; i++) {
      const now = panel.close[t * n + i];
      const later = panel.close[labelDay * n + i];
      if (!Number.isFinite(now) || !Number.isFinite(later) || now <= 0) continue;

      const row = new Array<number>(size);
      row[0] = 1;
      let usable = true;
      for (let j = 0; j < k; j++) {
        const feature = featureAt(panel, protocol, protocol.lookbacks[j], t, i);
        if (!Number.isFinite(feature)) {
          usable = false;
          break;
        }
        row[j + 1] = feature;
      }
      if (!usable) continue;

      const label = later / now - 1;
      for (let a = 0; a < size; a++) {
        xty[a] += row[a] * label;
        for (let b = 0; b < size; b++) xtx[a][b] += row[a] * row[b];
      }
    }
  }

  for (let a = 1; a < size; a++) xtx[a][a] += ridge;

  // Gaussian elimination with partial pivoting: arithmetic only, so it stays reproducible.
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let r = col + 1; r < size; r++) {
      if (Math.abs(xtx[r][col]) > Math.abs(xtx[pivot][col])) pivot = r;
    }
    if (Math.abs(xtx[pivot][col]) < 1e-12) return new Array<number>(size).fill(0);
    if (pivot !== col) {
      const rowSwap = xtx[pivot];
      xtx[pivot] = xtx[col];
      xtx[col] = rowSwap;
      const valueSwap = xty[pivot];
      xty[pivot] = xty[col];
      xty[col] = valueSwap;
    }
    for (let r = col + 1; r < size; r++) {
      const factor = xtx[r][col] / xtx[col][col];
      if (factor === 0) continue;
      for (let c = col; c < size; c++) xtx[r][c] -= factor * xtx[col][c];
      xty[r] -= factor * xty[col];
    }
  }

  const coefficients = new Array<number>(size).fill(0);
  for (let r = size - 1; r >= 0; r--) {
    let acc = xty[r];
    for (let c = r + 1; c < size; c++) acc -= xtx[r][c] * coefficients[c];
    coefficients[r] = acc / xtx[r][r];
  }
  return coefficients;
}

export type Scoring = { kind: "rank"; lookback: number } | { kind: "ols"; coefficients: number[] };

function scoreOf(panel: Panel, protocol: Protocol, scoring: Scoring, t: number, i: number): number {
  if (scoring.kind === "rank") {
    return featureAt(panel, protocol, scoring.lookback, t, i);
  }
  let acc = scoring.coefficients[0];
  for (let j = 0; j < protocol.lookbacks.length; j++) {
    const feature = featureAt(panel, protocol, protocol.lookbacks[j], t, i);
    if (!Number.isFinite(feature)) return Number.NaN;
    acc += scoring.coefficients[j + 1] * feature;
  }
  return acc;
}

interface Book {
  weights: Map<number, number>;
  daysLeft: number;
}

/**
 * Overlapping-book simulation. A new book is opened every `rebalanceEvery` days and held for
 * `labelHorizon` days, so when the two differ the books overlap — which is exactly the situation
 * where a missing purge gap leaks and a non-overlapping simulation would show nothing.
 */
function simulate(
  panel: Panel,
  protocol: Protocol,
  scoring: Scoring,
  from: number,
  to: number,
): { dailyReturns: number[]; turnover: number } {
  const n = panel.tickers.length;
  const volatility = volatilityFor(panel);
  const slots = Math.max(1, Math.ceil(protocol.labelHorizon / protocol.rebalanceEvery));
  const dailyReturns = new Array<number>(Math.max(0, to - from)).fill(0);
  let books: Book[] = [];
  let turnover = 0;

  for (let t = from; t < to; t++) {
    if ((t - from) % protocol.rebalanceEvery === 0) {
      const scored: { index: number; score: number }[] = [];
      for (let i = 0; i < n; i++) {
        const cell = t * n + i;
        const listed =
          protocol.universe === "point-in-time"
            ? panel.inUniverse[cell] === 1
            : panel.survivor[i] === 1 && Number.isFinite(panel.close[cell]);
        if (!listed) continue;
        if (protocol.maskUntradable && panel.tradable[cell] !== 1) continue;
        const score = scoreOf(panel, protocol, scoring, t, i);
        if (!Number.isFinite(score)) continue;
        scored.push({ index: i, score });
      }

      if (scored.length >= 10) {
        scored.sort((a, b) => b.score - a.score);
        const bucket = Math.max(1, Math.floor(scored.length * 0.2));
        const raw = new Map<number, number>();
        for (let k = 0; k < bucket; k++) raw.set(scored[k].index, 1);
        if (protocol.direction === "long-short") {
          for (let k = 0; k < bucket; k++) raw.set(scored[scored.length - 1 - k].index, -1);
        }

        // Size positions, then scale so gross exposure is 1 regardless of sizing rule.
        const sized = new Map<number, number>();
        let gross = 0;
        for (const [index, sign] of raw) {
          let size = 1;
          if (protocol.sizing !== "equal") {
            const vol =
              protocol.sizing === "trailing-vol"
                ? volatility.trailing[t * n + index]
                : volatility.full[index];
            if (!Number.isFinite(vol) || vol <= 0) continue;
            size = 0.02 / vol;
          }
          sized.set(index, sign * size);
          gross += Math.abs(sign * size);
        }
        if (gross > 0) {
          const weights = new Map<number, number>();
          for (const [index, value] of sized) weights.set(index, value / gross);
          const retiring = books.length >= slots ? books[0].weights : new Map<number, number>();
          let traded = 0;
          for (const index of new Set([...weights.keys(), ...retiring.keys()])) {
            traded += Math.abs((weights.get(index) ?? 0) - (retiring.get(index) ?? 0));
          }
          turnover += traded / slots;
          dailyReturns[t - from] -= (traded / slots) * (protocol.costBps / 10000);
          books.push({ weights, daysLeft: protocol.labelHorizon });
        }
      }
    }

    const earnFrom = protocol.execution === "same-bar" ? t : t + 1;
    let pnl = 0;
    for (const book of books) {
      const day = earnFrom;
      if (day < panel.dates.length) {
        for (const [index, weight] of book.weights) {
          const dayReturn = panel.ret[day * n + index];
          if (Number.isFinite(dayReturn)) pnl += (weight * dayReturn) / slots;
        }
      }
    }
    const target = earnFrom - from;
    if (target >= 0 && target < dailyReturns.length) dailyReturns[target] += pnl;

    books = books.filter((book) => {
      book.daysLeft -= 1;
      return book.daysLeft > 0;
    });
  }

  return { dailyReturns, turnover };
}

function metricsOf(dailyReturns: number[], turnover: number): Metrics {
  const days = dailyReturns.length;
  if (days === 0) {
    return {
      sharpe: 0,
      annualReturn: 0,
      annualVolatility: 0,
      maxDrawdown: 0,
      annualTurnover: 0,
      tradingDays: 0,
    };
  }
  let sum = 0;
  for (const value of dailyReturns) sum += value;
  const mean = sum / days;
  let variance = 0;
  for (const value of dailyReturns) variance += (value - mean) * (value - mean);
  variance = days > 1 ? variance / (days - 1) : 0;
  const dailyVol = Math.sqrt(variance);

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of dailyReturns) {
    equity *= 1 + value;
    if (equity > peak) peak = equity;
    const drawdown = equity / peak - 1;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
  }

  const annualVolatility = dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const annualReturn = mean * TRADING_DAYS_PER_YEAR;
  return {
    sharpe: annualVolatility > 0 ? annualReturn / annualVolatility : 0,
    annualReturn,
    annualVolatility,
    maxDrawdown,
    annualTurnover: (turnover * TRADING_DAYS_PER_YEAR) / days,
    tradingDays: days,
  };
}

export function runProtocol(panel: Panel, protocol: Protocol, folds = 4): ProtocolResult {
  const days = panel.dates.length;

  /** Best lookback by in-sample Sharpe, for rank mode. */
  const pickLookback = (from: number, to: number): number => {
    let best = protocol.lookbacks[0];
    let bestSharpe = Number.NEGATIVE_INFINITY;
    for (const lookback of protocol.lookbacks) {
      const run = simulate(panel, protocol, { kind: "rank", lookback }, from, to);
      const sharpe = metricsOf(run.dailyReturns, run.turnover).sharpe;
      if (sharpe > bestSharpe) {
        bestSharpe = sharpe;
        best = lookback;
      }
    }
    return best;
  };

  const scoringFor = (fitFrom: number, fitTo: number): { scoring: Scoring; label: number } => {
    if (protocol.model === "ols") {
      return {
        scoring: { kind: "ols", coefficients: fitCoefficients(panel, protocol, fitFrom, fitTo) },
        label: 0,
      };
    }
    const lookback = pickLookback(fitFrom, fitTo);
    return { scoring: { kind: "rank", lookback }, label: lookback };
  };

  if (protocol.evaluate === "full-sample") {
    const { scoring, label } = scoringFor(WARMUP_DAYS, days);
    const run = simulate(panel, protocol, scoring, WARMUP_DAYS, days);
    return {
      ...metricsOf(run.dailyReturns, run.turnover),
      lookbacksUsed: [label],
      foldSharpes: [],
    };
  }

  const block = Math.floor((days - WARMUP_DAYS) / (folds + 1));
  const stitched: number[] = [];
  const lookbacksUsed: number[] = [];
  const foldSharpes: number[] = [];
  let turnover = 0;

  for (let fold = 0; fold < folds; fold++) {
    const oosStart = days - (folds - fold) * block;
    // The purge gap lives here: shortening the fitting window is what keeps labels out of the test
    // period. With gapDays = 0 the last labels reach across the boundary.
    const inSampleEnd = oosStart - protocol.gapDays;
    const { scoring, label } =
      protocol.parameters === "locked-per-fold"
        ? scoringFor(WARMUP_DAYS, inSampleEnd)
        : scoringFor(WARMUP_DAYS, days);
    lookbacksUsed.push(label);
    const run = simulate(panel, protocol, scoring, oosStart, oosStart + block);
    foldSharpes.push(metricsOf(run.dailyReturns, run.turnover).sharpe);
    stitched.push(...run.dailyReturns);
    turnover += run.turnover;
  }

  return { ...metricsOf(stitched, turnover), lookbacksUsed, foldSharpes };
}

/** The protocol a careful researcher would use. Traps are expressed as one-flag departures from it. */
export const HONEST: Protocol = {
  universe: "point-in-time",
  direction: "long-short",
  model: "rank",
  standardize: "expanding",
  sizing: "equal",
  execution: "next-bar",
  maskUntradable: true,
  rebalanceEvery: 5,
  labelHorizon: 5,
  gapDays: 10,
  parameters: "locked-per-fold",
  evaluate: "out-of-sample",
  costBps: 10,
  lookbacks: [3, 5, 10, 20],
};
