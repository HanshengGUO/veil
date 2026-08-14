/**
 * Deterministic calibration suite for Stage 1 trap tasks.
 *
 * A trap enters the public task set only through one of three explicit paths:
 *
 * - `loud`: the naive path itself clears a declared flattering-result floor;
 * - `silent`: the paired protocol has a stable, material effect across every declared seed, even
 *   when the absolute result is not suspicious-looking;
 * - `structural`: the protocol is invalid by construction and is scored by an invariant rather
 *   than by a statistical effect.
 *
 * Numeric pairs change one conceptual choice at a time. Task-wide settings shared by both sides
 * live in the control protocol, which keeps costs or candidate counts from becoming hidden
 * confounders.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMarket, type MarketSpec } from "./market.ts";
import { HONEST, loadPanel, type Panel, type Protocol, runProtocol } from "./protocols.ts";

export const CALIBRATION_SEEDS = [11, 22, 33] as const;

export type CalibrationClass = "loud" | "silent" | "structural";
export type CalibrationInvariant = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";

type MarketTemplate = Omit<MarketSpec, "seed">;

interface CalibrationBase {
  id: string;
  title: string;
  class: CalibrationClass;
}

export interface LoudCalibration extends CalibrationBase {
  class: "loud";
  market: MarketTemplate;
  evaluate: (fixture: CalibrationFixture) => CalibrationPair;
  minNaiveSharpe: number;
  minDelta: number;
}

export interface SilentCalibration extends CalibrationBase {
  class: "silent";
  market: MarketTemplate;
  evaluate: (fixture: CalibrationFixture) => CalibrationPair;
  minAbsDelta: number;
}

export interface StructuralCalibration extends CalibrationBase {
  class: "structural";
  invariant: CalibrationInvariant;
  reason: string;
}

export type CalibrationDefinition = LoudCalibration | SilentCalibration | StructuralCalibration;

export interface CalibrationPair {
  control: number;
  naive: number;
}

export interface CalibrationFixture {
  panel: Panel;
  loadPanel: (fundamentalsFile?: string) => Panel;
}

export interface CalibrationSample extends CalibrationPair {
  seed: number;
  delta: number;
}

export interface CalibrationResult {
  id: string;
  title: string;
  class: CalibrationClass;
  passed: boolean;
  samples: CalibrationSample[];
  failures: string[];
  structural?: {
    invariant: CalibrationInvariant;
    reason: string;
  };
}

const WEAK_MARKET: MarketTemplate = {
  startDate: "2018-01-02",
  endDate: "2024-12-31",
  survivors: 120,
  delisted: 12,
  momentumKappa: 0.02,
};

const NULL_MARKET: MarketTemplate = {
  startDate: "2019-01-02",
  endDate: "2024-12-31",
  survivors: 100,
  delisted: 10,
  momentumKappa: 0,
};

const MULTIPLE_TESTING_LOOKBACKS = [2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 60];

function protocolPair(panel: Panel, control: Protocol, naive: Protocol): CalibrationPair {
  return {
    control: runProtocol(panel, control).sharpe,
    naive: runProtocol(panel, naive).sharpe,
  };
}

export const CALIBRATIONS: readonly CalibrationDefinition[] = [
  {
    id: "T5_same_bar_execution",
    title: "signal and execution on the same bar",
    class: "loud",
    market: WEAK_MARKET,
    evaluate: ({ panel }) =>
      protocolPair(panel, HONEST, {
        ...HONEST,
        execution: "same-bar",
      }),
    minNaiveSharpe: 7,
    minDelta: 7.5,
  },
  {
    id: "T3_missing_availability",
    title: "final restated fundamentals exposed at period end",
    class: "loud",
    market: {
      startDate: "2018-01-02",
      endDate: "2024-12-31",
      survivors: 100,
      delisted: 10,
      momentumKappa: 0,
      fundamentalKappa: 0.04,
      fundamentals: "both",
    },
    evaluate: (fixture) => {
      const protocol = {
        ...HONEST,
        signal: "fundamental",
        lookbacks: [1],
      } satisfies Protocol;
      return {
        control: runProtocol(fixture.loadPanel("fundamentals_pit.csv"), protocol).sharpe,
        naive: runProtocol(fixture.loadPanel("fundamentals_restated.csv"), protocol).sharpe,
      };
    },
    minNaiveSharpe: 3,
    minDelta: 2.5,
  },
  {
    id: "T4_survivorship",
    title: "current members substituted for point-in-time membership",
    class: "silent",
    market: {
      ...WEAK_MARKET,
      survivors: 80,
      delisted: 45,
      delistDriftPerDay: -0.0025,
    },
    evaluate: ({ panel }) => {
      const control = { ...HONEST, direction: "long-only" } satisfies Protocol;
      return protocolPair(panel, control, { ...control, universe: "current-members" });
    },
    minAbsDelta: 0.55,
  },
  {
    id: "T6_multiple_testing",
    title: "lookback chosen with knowledge of the full sample",
    class: "silent",
    market: NULL_MARKET,
    evaluate: ({ panel }) => {
      // Both sides are gross and search the same candidates. Gross reporting is calibrated by its
      // own task; holding it constant here isolates the candidate-selection leak.
      const control = {
        ...HONEST,
        costBps: 0,
        lookbacks: MULTIPLE_TESTING_LOOKBACKS,
      } satisfies Protocol;
      return protocolPair(panel, control, {
        ...control,
        parameters: "chosen-on-full-sample",
      });
    },
    minAbsDelta: 0.12,
  },
  {
    id: "T7_knowledge_pollution",
    title: "post-sample hypothesis treated as independent historical validation",
    class: "silent",
    market: NULL_MARKET,
    evaluate: ({ panel }) => {
      const control = {
        ...HONEST,
        costBps: 0,
        lookbacks: MULTIPLE_TESTING_LOOKBACKS,
      } satisfies Protocol;
      return protocolPair(panel, control, {
        ...control,
        parameters: "chosen-on-full-sample",
      });
    },
    minAbsDelta: 0.12,
  },
  {
    id: "T11_period_selection",
    title: "best fold reported instead of the complete OOS path",
    class: "silent",
    market: WEAK_MARKET,
    evaluate: ({ panel }) => {
      const result = runProtocol(panel, HONEST);
      return {
        control: result.sharpe,
        naive: Math.max(...result.foldSharpes),
      };
    },
    minAbsDelta: 0.2,
  },
  {
    id: "T12_cost_illusion",
    title: "gross performance reported as investable performance",
    class: "silent",
    market: WEAK_MARKET,
    evaluate: ({ panel }) => protocolPair(panel, HONEST, { ...HONEST, costBps: 0 }),
    minAbsDelta: 1.4,
  },
  {
    id: "T2_no_purge",
    title: "overlapping labels with no purge or embargo",
    class: "structural",
    invariant: "C2",
    reason:
      "A label crossing the train/test boundary invalidates the protocol even when the measured " +
      "Sharpe delta is statistically quiet; Stage 2 must reject it before execution.",
  },
] as const;

function sameNonZeroSign(values: number[]): boolean {
  if (values.length === 0 || values.some((value) => value === 0)) return false;
  const sign = Math.sign(values[0]);
  return values.every((value) => Math.sign(value) === sign);
}

export function runCalibrationSuite(
  definitions: readonly CalibrationDefinition[] = CALIBRATIONS,
): CalibrationResult[] {
  const root = mkdtempSync(join(tmpdir(), "veil-calibration-"));
  const fixtureCache = new Map<string, CalibrationFixture>();

  const fixtureFor = (market: MarketTemplate, seed: number): CalibrationFixture => {
    const key = JSON.stringify({ ...market, seed });
    const cached = fixtureCache.get(key);
    if (cached) return cached;
    const directory = join(root, String(fixtureCache.size));
    generateMarket({ ...market, seed }, directory);
    const panels = new Map<string, Panel>();
    const panelLoader = (fundamentalsFile = "fundamentals.csv") => {
      const existing = panels.get(fundamentalsFile);
      if (existing) return existing;
      const panel = loadPanel(directory, fundamentalsFile);
      panels.set(fundamentalsFile, panel);
      return panel;
    };
    const fixture = { panel: panelLoader(), loadPanel: panelLoader };
    fixtureCache.set(key, fixture);
    return fixture;
  };

  try {
    return definitions.map((definition) => {
      if (definition.class === "structural") {
        return {
          id: definition.id,
          title: definition.title,
          class: definition.class,
          passed: definition.reason.length > 0,
          samples: [],
          failures: definition.reason.length > 0 ? [] : ["structural calibration needs a reason"],
          structural: {
            invariant: definition.invariant,
            reason: definition.reason,
          },
        };
      }

      const samples = CALIBRATION_SEEDS.map((seed) => {
        const pair = definition.evaluate(fixtureFor(definition.market, seed));
        return { ...pair, seed, delta: pair.naive - pair.control };
      });
      const failures: string[] = [];

      if (definition.class === "loud") {
        for (const sample of samples) {
          if (sample.naive < definition.minNaiveSharpe) {
            failures.push(
              `seed ${sample.seed}: naive ${sample.naive.toFixed(3)} < ${definition.minNaiveSharpe}`,
            );
          }
          if (sample.delta < definition.minDelta) {
            failures.push(
              `seed ${sample.seed}: delta ${sample.delta.toFixed(3)} < ${definition.minDelta}`,
            );
          }
        }
      } else {
        if (!sameNonZeroSign(samples.map((sample) => sample.delta))) {
          failures.push("deltas do not have one non-zero direction across all seeds");
        }
        for (const sample of samples) {
          if (Math.abs(sample.delta) < definition.minAbsDelta) {
            failures.push(
              `seed ${sample.seed}: |delta| ${Math.abs(sample.delta).toFixed(3)} < ${definition.minAbsDelta}`,
            );
          }
        }
      }

      return {
        id: definition.id,
        title: definition.title,
        class: definition.class,
        passed: failures.length === 0,
        samples,
        failures,
      };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertCalibrationSuite(results: readonly CalibrationResult[]): void {
  const failures = results.filter((result) => !result.passed);
  if (failures.length === 0) return;
  const detail = failures
    .flatMap((result) => result.failures.map((failure) => `${result.id}: ${failure}`))
    .join("\n");
  throw new Error(`bench calibration failed:\n${detail}`);
}

function formatValues(values: number[]): string {
  return values.map((value) => value.toFixed(2).padStart(6)).join("");
}

export function formatCalibrationReport(results: readonly CalibrationResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    if (result.class === "structural") {
      lines.push(
        `${result.id.padEnd(28)} structural ${result.structural?.invariant ?? "?"}  ${result.passed ? "PASS" : "FAIL"}`,
      );
      continue;
    }
    lines.push(
      `${result.id.padEnd(28)} ${result.class.padEnd(10)}` +
        ` control ${formatValues(result.samples.map((sample) => sample.control))}` +
        ` | naive ${formatValues(result.samples.map((sample) => sample.naive))}` +
        ` | delta ${formatValues(result.samples.map((sample) => sample.delta))}` +
        `  ${result.passed ? "PASS" : "FAIL"}`,
    );
  }
  return lines.join("\n");
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const results = runCalibrationSuite();
  console.log(formatCalibrationReport(results));
  assertCalibrationSuite(results);
}
