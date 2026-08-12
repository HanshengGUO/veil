import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { SubmissionInvariant } from "./submission.ts";

export type AttributionLayer = "G1" | "G2" | "G3" | "G4";

export type TrapCalibration =
  | {
      class: "loud";
      seeds: number[];
      expectedSharpeMin: number;
      minDelta: number;
    }
  | {
      class: "silent";
      seeds: number[];
      minAbsDelta: number;
    }
  | {
      class: "structural";
      invariant: SubmissionInvariant;
      reason: string;
    };

export interface TrapOracle {
  kind: "trap";
  taskId: string;
  category: string;
  calibration: TrapCalibration;
  expectedCatchLayers: AttributionLayer[];
  violationCode?: SubmissionInvariant;
  cleanSharpeRange?: readonly [number, number];
}

export interface GoldenOracle {
  kind: "honest";
  taskId: string;
  nullSignal: boolean;
  sharpeRange: readonly [number, number];
  maxDrawdownWorseThan: number;
  expected: {
    completesResearchLoop: boolean;
    conclusionCitesExperimentId: boolean;
    explorationBlockedCount: number;
    verificationFalseRejections: number;
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a string`);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (!Number.isInteger(parsed)) throw new Error(`${path} must be an integer`);
  return parsed;
}

function nonnegativeInteger(value: unknown, path: string): number {
  const parsed = integer(value, path);
  if (parsed < 0) throw new Error(`${path} must not be negative`);
  return parsed;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
  return value;
}

function positive(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed <= 0) throw new Error(`${path} must be positive`);
  return parsed;
}

const LAYERS = new Set<AttributionLayer>(["G1", "G2", "G3", "G4"]);
const INVARIANTS = new Set<SubmissionInvariant>(["C1", "C2", "C3", "C4", "C5", "C6"]);

function invariant(value: unknown, path: string): SubmissionInvariant {
  const parsed = text(value, path) as SubmissionInvariant;
  if (!INVARIANTS.has(parsed)) throw new Error(`${path} is not a C1-C6 invariant`);
  return parsed;
}

function seeds(value: unknown, path: string): number[] {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(`${path} must contain at least three seeds`);
  }
  const parsed = value.map((entry, index) => integer(entry, `${path}[${index}]`));
  if (parsed.some((seed) => seed < 0 || seed > 0xffff_ffff)) {
    throw new Error(`${path} entries must be unsigned 32-bit integers`);
  }
  if (new Set(parsed).size !== parsed.length)
    throw new Error(`${path} must not contain duplicates`);
  return parsed;
}

function range(value: unknown, path: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${path} must have two numbers`);
  const lower = finite(value[0], `${path}[0]`);
  const upper = finite(value[1], `${path}[1]`);
  if (lower > upper) throw new Error(`${path} lower bound exceeds upper bound`);
  return [lower, upper];
}

export function parseTrapOracle(input: unknown): TrapOracle {
  const root = record(input, "trap oracle");
  const trap = record(root.trap, "trap");
  const naive = record(trap.naive_outcome, "trap.naive_outcome");
  const calibration = record(naive.calibration, "trap.naive_outcome.calibration");
  const calibrationClass = text(calibration.class, "calibration.class");

  let normalizedCalibration: TrapCalibration;
  if (calibrationClass === "loud") {
    normalizedCalibration = {
      class: calibrationClass,
      seeds: seeds(calibration.seeds, "calibration.seeds"),
      expectedSharpeMin: finite(calibration.expected_sharpe_min, "calibration.expected_sharpe_min"),
      minDelta: positive(calibration.min_delta, "calibration.min_delta"),
    };
  } else if (calibrationClass === "silent") {
    normalizedCalibration = {
      class: calibrationClass,
      seeds: seeds(calibration.seeds, "calibration.seeds"),
      minAbsDelta: positive(calibration.min_abs_delta, "calibration.min_abs_delta"),
    };
  } else if (calibrationClass === "structural") {
    normalizedCalibration = {
      class: calibrationClass,
      invariant: invariant(calibration.invariant, "calibration.invariant"),
      reason: text(calibration.reason, "calibration.reason"),
    };
  } else {
    throw new Error(`unsupported calibration class: ${calibrationClass}`);
  }

  const expected = record(root.expected, "expected");
  if (!Array.isArray(expected.catch_layer) || expected.catch_layer.length === 0) {
    throw new Error("expected.catch_layer must be a non-empty sequence");
  }
  const expectedCatchLayers = expected.catch_layer.map((value, index) => {
    const layer = text(value, `expected.catch_layer[${index}]`) as AttributionLayer;
    if (!LAYERS.has(layer)) throw new Error(`unsupported attribution layer: ${layer}`);
    return layer;
  });
  if (new Set(expectedCatchLayers).size !== expectedCatchLayers.length) {
    throw new Error("expected.catch_layer must not contain duplicates");
  }
  const violationCode =
    expected.violation_code === null || expected.violation_code === undefined
      ? undefined
      : invariant(expected.violation_code, "expected.violation_code");
  const golden = record(root.golden, "golden");
  const cleanSharpeRange =
    golden.clean_sharpe_range === null
      ? undefined
      : range(golden.clean_sharpe_range, "golden.clean_sharpe_range");

  return {
    kind: "trap",
    taskId: text(root.task_id, "task_id"),
    category: text(root.category, "category"),
    calibration: normalizedCalibration,
    expectedCatchLayers,
    violationCode,
    cleanSharpeRange,
  };
}

export function loadTrapOracle(path: string): TrapOracle {
  return parseTrapOracle(parse(readFileSync(path, "utf8")));
}

export function parseGoldenOracle(input: unknown): GoldenOracle {
  const root = record(input, "golden oracle");
  const signal = record(root.signal, "signal");
  const golden = record(root.golden, "golden");
  const expected = record(root.expected, "expected");
  const maxDrawdownWorseThan = finite(
    golden.max_drawdown_worse_than,
    "golden.max_drawdown_worse_than",
  );
  if (maxDrawdownWorseThan < -1 || maxDrawdownWorseThan > 0) {
    throw new Error("golden.max_drawdown_worse_than must be between -1 and 0");
  }

  return {
    kind: "honest",
    taskId: text(root.task_id, "task_id"),
    nullSignal: boolean(signal.null_signal, "signal.null_signal"),
    sharpeRange: range(golden.oos_sharpe_range, "golden.oos_sharpe_range"),
    maxDrawdownWorseThan,
    expected: {
      completesResearchLoop: boolean(
        expected.completes_research_loop,
        "expected.completes_research_loop",
      ),
      conclusionCitesExperimentId: boolean(
        expected.conclusion_cites_experiment_id,
        "expected.conclusion_cites_experiment_id",
      ),
      explorationBlockedCount: nonnegativeInteger(
        expected.exploration_blocked_count,
        "expected.exploration_blocked_count",
      ),
      verificationFalseRejections: nonnegativeInteger(
        expected.verification_false_rejections,
        "expected.verification_false_rejections",
      ),
    },
  };
}

export function loadGoldenOracle(path: string): GoldenOracle {
  return parseGoldenOracle(parse(readFileSync(path, "utf8")));
}
