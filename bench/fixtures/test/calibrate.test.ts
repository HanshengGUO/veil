import { describe, expect, it } from "vitest";
import {
  assertCalibrationSuite,
  CALIBRATION_SEEDS,
  CALIBRATIONS,
  runCalibrationSuite,
} from "../calibrate.ts";

describe("trap calibration", () => {
  it("passes every declared numeric and structural criterion", () => {
    const results = runCalibrationSuite();

    expect(() => assertCalibrationSuite(results)).not.toThrow();
    expect(results).toHaveLength(CALIBRATIONS.length);
    expect(results.filter((result) => result.class === "structural")).toHaveLength(1);
    for (const result of results) {
      expect(result.passed).toBe(true);
      expect(result.samples).toHaveLength(
        result.class === "structural" ? 0 : CALIBRATION_SEEDS.length,
      );
    }
  }, 30_000);
});
