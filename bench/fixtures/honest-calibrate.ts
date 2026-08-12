import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CALIBRATION_SEEDS } from "./calibrate.ts";
import { generateTaskMarket, HONEST_REFERENCES, type HonestTaskId } from "./catalog.ts";
import { loadPanel, runProtocol } from "./protocols.ts";

export interface HonestCalibrationResult {
  id: HonestTaskId;
  sharpes: number[];
  maxDrawdowns: number[];
  range: readonly [number, number];
  maxDrawdownWorseThan: number;
  passed: boolean;
}

export function runHonestCalibration(): HonestCalibrationResult[] {
  const root = mkdtempSync(join(tmpdir(), "veil-honest-calibration-"));
  try {
    return (Object.entries(HONEST_REFERENCES) as Array<[HonestTaskId, HonestReferenceEntry]>).map(
      ([id, reference], taskIndex) => {
        const metrics = CALIBRATION_SEEDS.map((seed, seedIndex) => {
          const directory = join(root, `${taskIndex}-${seedIndex}`);
          generateTaskMarket(id, seed, directory);
          return runProtocol(loadPanel(directory), reference.protocol);
        });
        const sharpes = metrics.map((result) => result.sharpe);
        const maxDrawdowns = metrics.map((result) => result.maxDrawdown);
        return {
          id,
          sharpes,
          maxDrawdowns,
          range: reference.sharpeRange,
          maxDrawdownWorseThan: reference.maxDrawdownWorseThan,
          passed:
            sharpes.every(
              (sharpe) => sharpe >= reference.sharpeRange[0] && sharpe <= reference.sharpeRange[1],
            ) && maxDrawdowns.every((drawdown) => drawdown >= reference.maxDrawdownWorseThan),
        };
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type HonestReferenceEntry = (typeof HONEST_REFERENCES)[HonestTaskId];

export function assertHonestCalibration(results: readonly HonestCalibrationResult[]): void {
  const failed = results.filter((result) => !result.passed);
  if (failed.length === 0) return;
  throw new Error(
    `honest calibration failed:\n${failed
      .map(
        (result) =>
          `${result.id}: Sharpe ${result.sharpes.map((value) => value.toFixed(3)).join(", ")} ` +
          `range [${result.range.join(", ")}], maxDD ` +
          `${result.maxDrawdowns.map((value) => value.toFixed(3)).join(", ")} floor ` +
          `${result.maxDrawdownWorseThan}`,
      )
      .join("\n")}`,
  );
}

export function formatHonestCalibration(results: readonly HonestCalibrationResult[]): string {
  return results
    .map(
      (result) =>
        `${result.id.padEnd(28)} Sharpe ${result.sharpes
          .map((value) => value.toFixed(2).padStart(6))
          .join("")} | maxDD ${result.maxDrawdowns
          .map((value) => value.toFixed(2).padStart(6))
          .join(
            "",
          )} | range [${result.range.join(", ")}], DD >= ${result.maxDrawdownWorseThan}  ${result.passed ? "PASS" : "FAIL"}`,
    )
    .join("\n");
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const results = runHonestCalibration();
  console.log(formatHonestCalibration(results));
  assertHonestCalibration(results);
}
