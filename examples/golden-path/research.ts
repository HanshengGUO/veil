/**
 * The golden path, done by hand.
 *
 * One factor (cross-sectional price momentum) evaluated under several protocols. The honest
 * protocol is what Veil will enforce at promotion time; each leaky protocol flips exactly one
 * switch, so the difference in Sharpe is attributable to that switch alone.
 *
 * Nothing here is Veil code — that is the point. This is the reference a researcher produces with
 * their own hands, and it is the target Stage 3 asks an agent to reproduce.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOLD_DAYS = 5;
export const LOOKBACKS = [3, 5, 10, 20] as const;
export const WARMUP_DAYS = 25;
export const OOS_BLOCK_DAYS = 252;
export const FOLD_COUNT = 6;
export const COST_BPS = 10;
/** Purge covers the 5-day label horizon; the extra week of embargo is deliberately conservative. */
export const PURGE_DAYS = HOLD_DAYS;
export const EMBARGO_DAYS = 5;
export const QUANTILE = 0.2;
const TRADING_DAYS_PER_YEAR = 252;

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
  standardize: "expanding" | "full-sample";
  execution: "next-bar" | "same-bar";
  maskUntradable: boolean;
  gapDays: number;
  parameters: "locked-per-fold" | "chosen-on-full-sample";
  evaluate: "out-of-sample" | "full-sample";
  costBps: number;
}

export interface Metrics {
  annualReturn: number;
  annualVolatility: number;
  sharpe: number;
  maxDrawdown: number;
  annualTurnover: number;
  tradingDays: number;
}

export interface ProtocolResult extends Metrics {
  lookbacksUsed: number[];
  /** Out-of-sample Sharpe per fold; empty for protocols scored on the full sample. */
  foldSharpes: number[];
}

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

  const cells = dates.length * tickers.length;
  const close = new Float64Array(cells).fill(Number.NaN);
  const ret = new Float64Array(cells).fill(Number.NaN);
  const tradable = new Uint8Array(cells);
  const inUniverse = new Uint8Array(cells);
  const survivor = new Uint8Array(tickers.length);

  for (const row of priceRows) {
    const t = dateIndex.get(row[0]) as number;
    const i = tickerIndex.get(row[1]) as number;
    const cell = t * tickers.length + i;
    close[cell] = Number(row[2]);
    tradable[cell] = row[4] === "true" ? 1 : 0;
  }
  for (const row of universeRows) {
    const t = dateIndex.get(row[0]);
    const i = tickerIndex.get(row[1]);
    if (t === undefined || i === undefined) continue;
    inUniverse[t * tickers.length + i] = 1;
  }
  for (const row of survivorRows) {
    const i = tickerIndex.get(row[0]);
    if (i !== undefined) survivor[i] = 1;
  }

  for (let t = 1; t < dates.length; t++) {
    for (let i = 0; i < tickers.length; i++) {
      const cell = t * tickers.length + i;
      const previous = close[cell - tickers.length];
      const current = close[cell];
      if (Number.isFinite(previous) && Number.isFinite(current) && previous > 0) {
        ret[cell] = current / previous - 1;
      }
    }
  }

  return { dates, tickers, close, ret, tradable, inUniverse, survivor };
}

interface StandardizedSignal {
  raw: Float64Array;
  expandingMean: Float64Array;
  expandingStd: Float64Array;
  fullMean: Float64Array;
  fullStd: Float64Array;
}

/**
 * Per-ticker standardization of the momentum signal, computed two ways: expanding (only data up to
 * t, which is what a decision at t may use) and full-sample (which quietly imports the future).
 */
function standardize(panel: Panel, lookback: number): StandardizedSignal {
  const n = panel.tickers.length;
  const days = panel.dates.length;
  const raw = new Float64Array(days * n).fill(Number.NaN);
  const expandingMean = new Float64Array(days * n).fill(Number.NaN);
  const expandingStd = new Float64Array(days * n).fill(Number.NaN);
  const fullMean = new Float64Array(n).fill(Number.NaN);
  const fullStd = new Float64Array(n).fill(Number.NaN);

  const count = new Float64Array(n);
  const sum = new Float64Array(n);
  const sumSquares = new Float64Array(n);

  for (let t = lookback; t < days; t++) {
    for (let i = 0; i < n; i++) {
      const cell = t * n + i;
      const past = panel.close[(t - lookback) * n + i];
      const now = panel.close[cell];
      if (!Number.isFinite(past) || !Number.isFinite(now) || past <= 0) continue;

      const value = now / past - 1;
      raw[cell] = value;
      count[i] += 1;
      sum[i] += value;
      sumSquares[i] += value * value;
      if (count[i] >= 20) {
        const mean = sum[i] / count[i];
        const variance = sumSquares[i] / count[i] - mean * mean;
        expandingMean[cell] = mean;
        expandingStd[cell] = variance > 0 ? Math.sqrt(variance) : Number.NaN;
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

const signalCache = new WeakMap<Panel, Map<number, StandardizedSignal>>();

function signalFor(panel: Panel, lookback: number): StandardizedSignal {
  let perPanel = signalCache.get(panel);
  if (!perPanel) {
    perPanel = new Map<number, StandardizedSignal>();
    signalCache.set(panel, perPanel);
  }
  const cached = perPanel.get(lookback);
  if (cached) return cached;
  const computed = standardize(panel, lookback);
  perPanel.set(lookback, computed);
  return computed;
}

interface Simulation {
  dailyReturns: number[];
  turnover: number;
  rebalances: number;
}

/**
 * Long the top quintile, short the bottom quintile, rebalanced every HOLD_DAYS, over
 * `[from, to)` of the trading calendar.
 */
function simulate(
  panel: Panel,
  protocol: Protocol,
  lookback: number,
  from: number,
  to: number,
): Simulation {
  const n = panel.tickers.length;
  const signal = signalFor(panel, lookback);
  const dailyReturns = new Array<number>(Math.max(0, to - from)).fill(0);
  let previousWeights = new Map<number, number>();
  let turnover = 0;
  let rebalances = 0;

  for (let t = from; t < to; t += HOLD_DAYS) {
    const scored: { index: number; score: number }[] = [];
    for (let i = 0; i < n; i++) {
      const cell = t * n + i;
      const value = signal.raw[cell];
      if (!Number.isFinite(value)) continue;

      const listed =
        protocol.universe === "point-in-time"
          ? panel.inUniverse[cell] === 1
          : panel.survivor[i] === 1;
      if (!listed) continue;
      if (protocol.maskUntradable && panel.tradable[cell] !== 1) continue;

      const mean =
        protocol.standardize === "expanding" ? signal.expandingMean[cell] : signal.fullMean[i];
      const std =
        protocol.standardize === "expanding" ? signal.expandingStd[cell] : signal.fullStd[i];
      if (!Number.isFinite(mean) || !Number.isFinite(std)) continue;

      scored.push({ index: i, score: (value - mean) / std });
    }

    if (scored.length < 10) continue;
    scored.sort((a, b) => b.score - a.score);
    const bucket = Math.max(1, Math.floor(scored.length * QUANTILE));

    const weights = new Map<number, number>();
    for (let k = 0; k < bucket; k++) weights.set(scored[k].index, 0.5 / bucket);
    for (let k = 0; k < bucket; k++)
      weights.set(scored[scored.length - 1 - k].index, -0.5 / bucket);

    let traded = 0;
    const touched = new Set<number>([...weights.keys(), ...previousWeights.keys()]);
    for (const index of touched) {
      traded += Math.abs((weights.get(index) ?? 0) - (previousWeights.get(index) ?? 0));
    }
    turnover += traded;
    rebalances += 1;

    const firstHoldingDay = protocol.execution === "next-bar" ? t + 1 : t;
    for (let h = 0; h < HOLD_DAYS; h++) {
      const day = firstHoldingDay + h;
      if (day < from || day >= to) continue;
      let pnl = 0;
      for (const [index, weight] of weights) {
        const dayReturn = panel.ret[day * n + index];
        if (Number.isFinite(dayReturn)) pnl += weight * dayReturn;
      }
      if (h === 0) pnl -= (traded * protocol.costBps) / 10000;
      dailyReturns[day - from] += pnl;
    }

    previousWeights = weights;
  }

  return { dailyReturns, turnover, rebalances };
}

function metricsOf(dailyReturns: number[], turnover: number, tradingDays: number): Metrics {
  const days = dailyReturns.length;
  if (days === 0) {
    return {
      annualReturn: 0,
      annualVolatility: 0,
      sharpe: 0,
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
    annualReturn,
    annualVolatility,
    sharpe: annualVolatility > 0 ? annualReturn / annualVolatility : 0,
    maxDrawdown,
    annualTurnover: (turnover * TRADING_DAYS_PER_YEAR) / days,
    tradingDays,
  };
}

function sharpeOf(simulation: Simulation): number {
  return metricsOf(simulation.dailyReturns, simulation.turnover, simulation.dailyReturns.length)
    .sharpe;
}

/** Runs one protocol and returns its metrics plus the lookbacks it ended up using. */
export function runProtocol(panel: Panel, protocol: Protocol): ProtocolResult {
  const days = panel.dates.length;

  if (protocol.evaluate === "full-sample") {
    let best: number = LOOKBACKS[0];
    let bestSharpe = Number.NEGATIVE_INFINITY;
    for (const lookback of LOOKBACKS) {
      const candidate = sharpeOf(simulate(panel, protocol, lookback, WARMUP_DAYS, days));
      if (candidate > bestSharpe) {
        bestSharpe = candidate;
        best = lookback;
      }
    }
    const run = simulate(panel, protocol, best, WARMUP_DAYS, days);
    return {
      ...metricsOf(run.dailyReturns, run.turnover, run.dailyReturns.length),
      lookbacksUsed: [best],
      foldSharpes: [],
    };
  }

  const stitched: number[] = [];
  let turnover = 0;
  const lookbacksUsed: number[] = [];
  const foldSharpes: number[] = [];

  for (let fold = 0; fold < FOLD_COUNT; fold++) {
    const oosStart = days - (FOLD_COUNT - fold) * OOS_BLOCK_DAYS;
    const oosEnd = oosStart + OOS_BLOCK_DAYS;
    const inSampleEnd = oosStart - protocol.gapDays;

    let chosen: number = LOOKBACKS[0];
    if (protocol.parameters === "locked-per-fold") {
      let bestSharpe = Number.NEGATIVE_INFINITY;
      for (const lookback of LOOKBACKS) {
        const candidate = sharpeOf(simulate(panel, protocol, lookback, WARMUP_DAYS, inSampleEnd));
        if (candidate > bestSharpe) {
          bestSharpe = candidate;
          chosen = lookback;
        }
      }
    } else {
      let bestSharpe = Number.NEGATIVE_INFINITY;
      for (const lookback of LOOKBACKS) {
        const candidate = sharpeOf(simulate(panel, protocol, lookback, WARMUP_DAYS, days));
        if (candidate > bestSharpe) {
          bestSharpe = candidate;
          chosen = lookback;
        }
      }
    }

    lookbacksUsed.push(chosen);
    const run = simulate(panel, protocol, chosen, oosStart, oosEnd);
    foldSharpes.push(sharpeOf(run));
    stitched.push(...run.dailyReturns);
    turnover += run.turnover;
  }

  return { ...metricsOf(stitched, turnover, stitched.length), lookbacksUsed, foldSharpes };
}

export const HONEST_PROTOCOL: Protocol = {
  universe: "point-in-time",
  standardize: "expanding",
  execution: "next-bar",
  maskUntradable: true,
  gapDays: PURGE_DAYS + EMBARGO_DAYS,
  parameters: "locked-per-fold",
  evaluate: "out-of-sample",
  costBps: COST_BPS,
};

/**
 * Each entry flips one switch away from the honest protocol, except `naive_pipeline`, which is what
 * an unconstrained agent tends to write when nobody is enforcing anything.
 */
export const PROTOCOLS: { name: string; describe: string; protocol: Protocol }[] = [
  {
    name: "honest",
    describe:
      "the golden path: PIT universe, mask first, expanding stats, locked params, purged OOS",
    protocol: HONEST_PROTOCOL,
  },
  {
    name: "honest_gross",
    describe: "the same honest protocol with costs switched off, to size the cost drag",
    protocol: { ...HONEST_PROTOCOL, costBps: 0 },
  },
  {
    name: "leak_same_bar_execution",
    describe: "signal from today's close, filled at today's close (C1/C5 decision-time leak)",
    protocol: { ...HONEST_PROTOCOL, execution: "same-bar" },
  },
  {
    name: "leak_full_sample_stats",
    describe: "signal standardized with whole-sample mean and volatility (C1 look-ahead)",
    protocol: { ...HONEST_PROTOCOL, standardize: "full-sample" },
  },
  {
    name: "leak_no_purge",
    describe: "in-sample window abuts the test window despite 5-day labels (C2)",
    protocol: { ...HONEST_PROTOCOL, gapDays: 0 },
  },
  {
    name: "leak_survivorship",
    describe: "today's index members used for the whole history (C4/universe declaration)",
    protocol: { ...HONEST_PROTOCOL, universe: "current-members" },
  },
  {
    name: "leak_parameter_snooping",
    describe: "lookback chosen on the full sample, then scored on the full sample (C3)",
    protocol: {
      ...HONEST_PROTOCOL,
      parameters: "chosen-on-full-sample",
      evaluate: "full-sample",
    },
  },
  {
    name: "naive_pipeline",
    describe: "every switch flipped, no costs: the number a naive backtest reports",
    protocol: {
      universe: "current-members",
      standardize: "full-sample",
      execution: "same-bar",
      maskUntradable: false,
      gapDays: 0,
      parameters: "chosen-on-full-sample",
      evaluate: "full-sample",
      costBps: 0,
    },
  },
];
