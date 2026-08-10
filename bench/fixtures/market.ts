/**
 * Deterministic synthetic markets for bench tasks.
 *
 * Lineage: the approach comes from `examples/golden-path/generate.ts`, and the primitives below are
 * a deliberate copy of it. They are *not* shared code. The golden path is a frozen reference whose
 * metrics are committed and quoted in the README; bench fixtures have to keep growing new knobs
 * (long-biased universes, volatility regimes, fundamentals without availability). Coupling the two
 * would make every bench change a potential reference regression, and would point the referee at one
 * of its own subjects.
 *
 * Determinism rule, inherited and non-negotiable: only + - * / and sqrt. No exp, log or pow, so the
 * same seed produces the same bytes on Linux, macOS and Windows.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MarketSpec {
  seed: number;
  startDate: string;
  endDate: string;
  /** Instruments that survive to the end of the sample. */
  survivors: number;
  /** Instruments that delist part-way through, after drifting down. */
  delisted: number;
  /**
   * Strength of the planted momentum effect, as a fraction of idiosyncratic volatility.
   * Zero means there is nothing to find — which is what a multiple-testing trap needs.
   */
  momentumKappa: number;
  momentumWindow?: number;
  /** Daily drift of instruments on their way out. More negative makes survivorship bias bite harder. */
  delistDriftPerDay?: number;
  haltProbability?: number;
  /**
   * Alternating calm and turbulent periods. With regimes on, a volatility estimated over the whole
   * sample is a poor estimate of local volatility, which is what makes full-sample scaling leak.
   */
  volatilityRegimes?: boolean;
  /**
   * Give each instrument its own regime phase rather than one market-wide schedule. Market-wide
   * regimes shift every instrument together, so cross-sectional ranks barely move and a full-sample
   * estimate leaks almost nothing. Per-instrument phases are what make it bite.
   */
  perInstrumentRegimes?: boolean;
  /**
   * - `none`: prices only.
   * - `with-availability`: quarterly values carrying the date each first became knowable, plus
   *   restatements as separate rows. The honest case.
   * - `restated-only`: final restated values with **no availability column at all**, which is how a
   *   great many vendor dumps actually arrive.
   */
  fundamentals?: "none" | "with-availability" | "restated-only";
}

export interface MarketOutput {
  dates: string[];
  tickers: string[];
  priceRows: number;
  universeRows: number;
  fundamentalRows: number;
  files: string[];
}

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

/** Calm and turbulent stretches of about a year each. Deterministic by day index, not random. */
function regimeFactor(dayIndex: number, enabled: boolean, phase = 0): number {
  if (!enabled) return 1;
  const period = Math.floor(dayIndex / 252) + phase;
  return period % 2 === 0 ? 0.6 : 1.8;
}

interface Instrument {
  ticker: string;
  beta: number;
  idioVol: number;
  price: number;
  drift: number;
  delistIndex: number;
  trailing: number[];
  haltDaysLeft: number;
  /** Offset into the regime schedule, so instruments can be calm while others are turbulent. */
  regimePhase: number;
}

export function generateMarket(spec: MarketSpec, outDir: string): MarketOutput {
  const momentumWindow = spec.momentumWindow ?? 5;
  const delistDrift = spec.delistDriftPerDay ?? -0.0012;
  const haltProbability = spec.haltProbability ?? 0.0015;
  const regimes = spec.volatilityRegimes ?? false;
  const fundamentalsMode = spec.fundamentals ?? "none";

  const rng = createRng(spec.seed);
  const dates = businessDays(spec.startDate, spec.endDate);
  const total = spec.survivors + spec.delisted;

  const instruments: Instrument[] = [];
  for (let i = 0; i < total; i++) {
    const isDelisted = i >= spec.survivors;
    instruments.push({
      ticker: `SYN${String(i + 1).padStart(3, "0")}`,
      beta: 0.6 + 0.8 * rng(),
      idioVol: 0.012 + 0.016 * rng(),
      price: 10 + 90 * rng(),
      drift: isDelisted ? delistDrift : 0.0001,
      delistIndex: isDelisted ? Math.floor(dates.length * (0.35 + 0.5 * rng())) : -1,
      trailing: [],
      haltDaysLeft: 0,
      regimePhase: spec.perInstrumentRegimes ? Math.floor(4 * rng()) : 0,
    });
  }

  const priceLines: string[] = ["date,ticker,close,volume,tradable"];
  const universeLines: string[] = ["date,ticker"];

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];
    const scale = regimeFactor(d, regimes);
    const marketReturn = 0.0002 + 0.009 * scale * normal(rng);

    for (const instrument of instruments) {
      if (instrument.delistIndex >= 0 && d > instrument.delistIndex) continue;
      universeLines.push(`${date},${instrument.ticker}`);

      if (instrument.haltDaysLeft === 0 && rng() < haltProbability) {
        instrument.haltDaysLeft = 1 + Math.floor(4 * rng());
      }
      if (instrument.haltDaysLeft > 0) {
        instrument.haltDaysLeft -= 1;
        priceLines.push(`${date},${instrument.ticker},${instrument.price.toFixed(4)},0,false`);
        continue;
      }

      const trailing = instrument.trailing;
      let signal = 0;
      if (trailing.length === momentumWindow) {
        let sum = 0;
        for (const value of trailing) sum += value;
        signal = sum / (Math.sqrt(momentumWindow) * instrument.idioVol);
      }

      // Only noise feeds the trailing window: letting the planted component feed itself would
      // compound predictability over the sample, which is a bug the golden path already paid for.
      const idioScale = regimeFactor(d, regimes, instrument.regimePhase);
      const noise = instrument.idioVol * idioScale * normal(rng);
      const idio = noise + spec.momentumKappa * signal * instrument.idioVol;
      const ret = instrument.beta * marketReturn + idio + instrument.drift;

      trailing.push(noise);
      if (trailing.length > momentumWindow) trailing.shift();

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

  mkdirSync(outDir, { recursive: true });
  const files = ["prices.csv", "universe_history.csv", "universe_current.csv"];
  writeFileSync(join(outDir, "prices.csv"), `${priceLines.join("\n")}\n`);
  writeFileSync(join(outDir, "universe_history.csv"), `${universeLines.join("\n")}\n`);
  writeFileSync(join(outDir, "universe_current.csv"), `${survivorLines.join("\n")}\n`);

  let fundamentalRows = 0;
  if (fundamentalsMode !== "none") {
    const withAvailability = fundamentalsMode === "with-availability";
    const header = withAvailability
      ? "ticker,period_end,available_time,earnings_yield"
      : "ticker,period_end,earnings_yield";
    const lines: string[] = [header];
    const quarterEnds = ["03-31", "06-30", "09-30", "12-31"];
    const firstYear = Number(spec.startDate.slice(0, 4)) - 1;
    const lastYear = Number(spec.endDate.slice(0, 4));

    for (const instrument of instruments) {
      const base = 0.02 + 0.06 * rng();
      for (let year = firstYear; year <= lastYear; year++) {
        for (const quarterEnd of quarterEnds) {
          const periodEnd = `${year}-${quarterEnd}`;
          if (periodEnd > spec.endDate) continue;
          const asFirstReported = base + 0.01 * normal(rng);
          const lag = 45 + Math.floor(46 * rng());
          const restated = rng() < 0.12;
          const restatedValue = asFirstReported + 0.004 * normal(rng);

          if (withAvailability) {
            lines.push(
              `${instrument.ticker},${periodEnd},${addDays(periodEnd, lag)},${asFirstReported.toFixed(6)}`,
            );
            if (restated) {
              const restatementLag = lag + 30 + Math.floor(60 * rng());
              lines.push(
                `${instrument.ticker},${periodEnd},${addDays(periodEnd, restatementLag)},${restatedValue.toFixed(6)}`,
              );
            }
          } else {
            // One row per period, carrying the *final* value. Whoever consumes this cannot tell that
            // the number was not knowable until months later, or that it changed.
            const value = restated ? restatedValue : asFirstReported;
            lines.push(`${instrument.ticker},${periodEnd},${value.toFixed(6)}`);
          }
        }
      }
    }

    writeFileSync(join(outDir, "fundamentals.csv"), `${lines.join("\n")}\n`);
    files.push("fundamentals.csv");
    fundamentalRows = lines.length - 1;
  }

  return {
    dates,
    tickers: instruments.map((instrument) => instrument.ticker),
    priceRows: priceLines.length - 1,
    universeRows: universeLines.length - 1,
    fundamentalRows,
    files,
  };
}
