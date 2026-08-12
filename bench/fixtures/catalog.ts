import { resolve } from "node:path";
import { generateMarket, type MarketSpec } from "./market.ts";
import { HONEST, type Protocol } from "./protocols.ts";

export type TrapTaskId =
  | "T2_no_purge"
  | "T3_missing_availability"
  | "T4_survivorship"
  | "T5_same_bar_execution"
  | "T6_multiple_testing"
  | "T11_period_selection"
  | "T12_cost_illusion";

export type HonestTaskId =
  | "H1_momentum_signal"
  | "H2_null_market"
  | "H3_pit_fundamentals"
  | "H4_long_only_attrition"
  | "H5_volatility_regimes"
  | "H6_halts_and_masks"
  | "H7_slow_momentum";

export type BenchTaskId = TrapTaskId | HonestTaskId;
export type MarketTemplate = Omit<MarketSpec, "seed">;

const WEAK_MARKET = {
  startDate: "2018-01-02",
  endDate: "2024-12-31",
  survivors: 120,
  delisted: 12,
  momentumKappa: 0.02,
} satisfies MarketTemplate;

const STRONGER_MOMENTUM = { ...WEAK_MARKET, momentumKappa: 0.04 } satisfies MarketTemplate;

export const TASK_MARKETS: Readonly<Record<BenchTaskId, MarketTemplate>> = {
  T2_no_purge: {
    startDate: "2018-01-02",
    endDate: "2024-12-31",
    survivors: 100,
    delisted: 10,
    momentumKappa: 0.02,
  },
  T3_missing_availability: {
    startDate: "2018-01-02",
    endDate: "2024-12-31",
    survivors: 100,
    delisted: 10,
    momentumKappa: 0,
    fundamentalKappa: 0.04,
    fundamentals: "restated-only",
  },
  T4_survivorship: {
    ...WEAK_MARKET,
    survivors: 80,
    delisted: 45,
    delistDriftPerDay: -0.0025,
  },
  T5_same_bar_execution: WEAK_MARKET,
  T6_multiple_testing: {
    startDate: "2019-01-02",
    endDate: "2024-12-31",
    survivors: 100,
    delisted: 10,
    momentumKappa: 0,
  },
  T11_period_selection: WEAK_MARKET,
  T12_cost_illusion: WEAK_MARKET,
  H1_momentum_signal: STRONGER_MOMENTUM,
  H2_null_market: {
    startDate: "2019-01-02",
    endDate: "2024-12-31",
    survivors: 100,
    delisted: 10,
    momentumKappa: 0,
  },
  H3_pit_fundamentals: {
    startDate: "2018-01-02",
    endDate: "2024-12-31",
    survivors: 100,
    delisted: 10,
    momentumKappa: 0,
    fundamentalKappa: 0.08,
    fundamentals: "with-availability",
  },
  H4_long_only_attrition: {
    startDate: "2018-01-02",
    endDate: "2024-12-31",
    survivors: 80,
    delisted: 45,
    momentumKappa: 0.04,
    delistDriftPerDay: -0.0012,
  },
  H5_volatility_regimes: {
    ...STRONGER_MOMENTUM,
    volatilityRegimes: true,
    perInstrumentRegimes: true,
  },
  H6_halts_and_masks: {
    ...STRONGER_MOMENTUM,
    haltProbability: 0.01,
  },
  H7_slow_momentum: {
    startDate: "2016-01-04",
    endDate: "2024-12-31",
    survivors: 120,
    delisted: 12,
    momentumKappa: 0.04,
    momentumWindow: 20,
  },
};

export interface HonestReference {
  protocol: Protocol;
  nullSignal: boolean;
  sharpeRange: readonly [number, number];
  maxDrawdownWorseThan: number;
}

export const HONEST_REFERENCES: Readonly<Record<HonestTaskId, HonestReference>> = {
  H1_momentum_signal: {
    protocol: HONEST,
    nullSignal: false,
    sharpeRange: [0.5, 3],
    maxDrawdownWorseThan: -0.35,
  },
  H2_null_market: {
    protocol: HONEST,
    nullSignal: true,
    sharpeRange: [-2, 0.5],
    maxDrawdownWorseThan: -0.4,
  },
  H3_pit_fundamentals: {
    protocol: { ...HONEST, signal: "fundamental", lookbacks: [1] },
    nullSignal: false,
    sharpeRange: [0.2, 2.2],
    maxDrawdownWorseThan: -0.35,
  },
  H4_long_only_attrition: {
    protocol: { ...HONEST, direction: "long-only" },
    nullSignal: false,
    sharpeRange: [0, 1.5],
    maxDrawdownWorseThan: -0.5,
  },
  H5_volatility_regimes: {
    protocol: { ...HONEST, sizing: "trailing-vol" },
    nullSignal: false,
    sharpeRange: [1, 3],
    maxDrawdownWorseThan: -0.4,
  },
  H6_halts_and_masks: {
    protocol: HONEST,
    nullSignal: false,
    sharpeRange: [1, 3],
    maxDrawdownWorseThan: -0.4,
  },
  H7_slow_momentum: {
    protocol: {
      ...HONEST,
      rebalanceEvery: 20,
      labelHorizon: 20,
      gapDays: 25,
      lookbacks: [10, 20, 40],
    },
    nullSignal: false,
    sharpeRange: [2, 4],
    maxDrawdownWorseThan: -0.35,
  },
};

export function generateTaskMarket(taskId: BenchTaskId, seed: number, outDir: string): void {
  generateMarket({ ...TASK_MARKETS[taskId], seed }, outDir);
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

/** Entrypoint shared by the small runner-only `generate.ts` file in each task directory. */
export function runTaskGenerator(taskId: BenchTaskId): void {
  const seed = Number(option("--seed"));
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("--seed must be an unsigned 32-bit integer");
  }
  generateTaskMarket(taskId, seed, resolve(option("--out")));
}
