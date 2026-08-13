/**
 * Deterministic synthetic market for the golden path.
 *
 * Two properties matter more than realism here:
 *
 * 1. **Bit-identical across platforms.** Only +, -, *, / and sqrt are used — no exp/log/pow —
 *    so macOS, Linux and Windows produce the same CSVs and the same metrics. That lets CI treat
 *    the golden path as a reproducibility check rather than a smoke test.
 * 2. **A known truth to recover.** A weak momentum effect is planted, along with the defects real
 *    data arrives with: halts, delistings, and a fundamentals feed that is only knowable weeks
 *    after the period it describes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SEED = 20260806;
export const START_DATE = "2016-01-04";
export const END_DATE = "2024-12-31";
export const SURVIVOR_COUNT = 150;
export const DELISTED_COUNT = 15;

/** Strength of the planted momentum effect, as a fraction of idiosyncratic volatility. */
export const MOMENTUM_KAPPA = 0.03;
/** Trailing window, in trading days, that the planted effect is built from. */
export const MOMENTUM_WINDOW = 5;

/** mulberry32: integer arithmetic plus one division by 2^32, so it is exactly reproducible. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Irwin-Hall approximation of a standard normal: unit variance, no transcendental functions. */
function normal(rng: () => number): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += rng();
  return sum - 6;
}

/** Business days between two ISO dates, weekends excluded. Exchange holidays are ignored. */
export function businessDays(startIso: string, endIso: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

interface Instrument {
  ticker: string;
  beta: number;
  idioVol: number;
  price: number;
  drift: number;
  /** Trading day index at which the instrument stops trading, or -1 if it survives. */
  delistIndex: number;
  trailing: number[];
  haltDaysLeft: number;
}

export interface GeneratedData {
  dates: string[];
  priceRows: number;
  fundamentalRows: number;
  universeRows: number;
}

/**
 * Writes prices, point-in-time universe membership, a survivor-only universe, and a lagged
 * fundamentals feed into `outDir`.
 */
export function generate(outDir: string, kappa: number = MOMENTUM_KAPPA): GeneratedData {
  const rng = createRng(SEED);
  const dates = businessDays(START_DATE, END_DATE);
  const total = SURVIVOR_COUNT + DELISTED_COUNT;

  const instruments: Instrument[] = [];
  for (let i = 0; i < total; i++) {
    const isDelisted = i >= SURVIVOR_COUNT;
    instruments.push({
      ticker: `SYN${String(i + 1).padStart(3, "0")}`,
      beta: 0.6 + 0.8 * rng(),
      idioVol: 0.012 + 0.016 * rng(),
      price: 10 + 90 * rng(),
      // Names that eventually delist decay on the way out: ignoring them inflates results.
      drift: isDelisted ? -0.0012 : 0.0001,
      delistIndex: isDelisted ? Math.floor(dates.length * (0.35 + 0.5 * rng())) : -1,
      trailing: [],
      haltDaysLeft: 0,
    });
  }

  const priceLines: string[] = ["date,ticker,close,volume,tradable"];
  const universeLines: string[] = ["date,ticker,in_universe"];

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];
    const marketReturn = 0.0002 + 0.009 * normal(rng);

    for (const instrument of instruments) {
      if (instrument.delistIndex >= 0 && d > instrument.delistIndex) continue;

      universeLines.push(`${date},${instrument.ticker},true`);

      if (instrument.haltDaysLeft === 0 && rng() < 0.0015) {
        instrument.haltDaysLeft = 1 + Math.floor(4 * rng());
      }

      if (instrument.haltDaysLeft > 0) {
        instrument.haltDaysLeft -= 1;
        // Halted: last price carried forward, nothing tradable, no information added.
        priceLines.push(`${date},${instrument.ticker},${instrument.price.toFixed(4)},0,false`);
        continue;
      }

      const trailing = instrument.trailing;
      let signal = 0;
      if (trailing.length === MOMENTUM_WINDOW) {
        let sum = 0;
        for (const value of trailing) sum += value;
        signal = sum / (Math.sqrt(MOMENTUM_WINDOW) * instrument.idioVol);
      }

      // Only the noise goes into the trailing window. Feeding the planted component back into
      // itself would compound predictability over time, and a stationary effect is the point.
      const noise = instrument.idioVol * normal(rng);
      const idio = noise + kappa * signal * instrument.idioVol;
      const ret = instrument.beta * marketReturn + idio + instrument.drift;

      trailing.push(noise);
      if (trailing.length > MOMENTUM_WINDOW) trailing.shift();

      instrument.price = instrument.price * (1 + ret);
      if (instrument.price < 1) instrument.price = 1;

      const volume = Math.round((100000 + 1900000 * rng()) / 100) * 100;
      priceLines.push(`${date},${instrument.ticker},${instrument.price.toFixed(4)},${volume},true`);
    }
  }

  const survivorLines: string[] = ["ticker"];
  for (const instrument of instruments) {
    if (instrument.delistIndex < 0) survivorLines.push(instrument.ticker);
  }

  // Quarterly fundamentals: knowable only weeks after the period ends, and sometimes restated.
  const fundamentalLines: string[] = ["ticker,period_end,available_time,earnings_yield"];
  const quarterEnds = ["03-31", "06-30", "09-30", "12-31"];
  const firstYear = Number(START_DATE.slice(0, 4)) - 1;
  const lastYear = Number(END_DATE.slice(0, 4));
  for (const instrument of instruments) {
    const base = 0.02 + 0.06 * rng();
    for (let year = firstYear; year <= lastYear; year++) {
      for (const quarterEnd of quarterEnds) {
        const periodEnd = `${year}-${quarterEnd}`;
        if (periodEnd > END_DATE) continue;
        const value = base + 0.01 * normal(rng);
        const lag = 45 + Math.floor(46 * rng());
        fundamentalLines.push(
          `${instrument.ticker},${periodEnd},${addDays(periodEnd, lag)},${value.toFixed(6)}`,
        );
        if (rng() < 0.12) {
          const restated = value + 0.004 * normal(rng);
          const restatementLag = lag + 30 + Math.floor(60 * rng());
          fundamentalLines.push(
            `${instrument.ticker},${periodEnd},${addDays(periodEnd, restatementLag)},${restated.toFixed(6)}`,
          );
        }
      }
    }
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "prices.csv"), `${priceLines.join("\n")}\n`);
  writeFileSync(join(outDir, "universe_history.csv"), `${universeLines.join("\n")}\n`);
  writeFileSync(join(outDir, "universe_current.csv"), `${survivorLines.join("\n")}\n`);
  writeFileSync(join(outDir, "fundamentals.csv"), `${fundamentalLines.join("\n")}\n`);

  return {
    dates,
    priceRows: priceLines.length - 1,
    fundamentalRows: fundamentalLines.length - 1,
    universeRows: universeLines.length - 1,
  };
}
