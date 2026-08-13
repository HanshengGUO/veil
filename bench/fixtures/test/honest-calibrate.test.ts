import { describe, expect, it } from "vitest";
import { assertHonestCalibration, runHonestCalibration } from "../honest-calibrate.ts";

describe("honest task calibration", () => {
  it("keeps every reference result inside its declared golden range", () => {
    const results = runHonestCalibration();
    expect(() => assertHonestCalibration(results)).not.toThrow();
    expect(results).toHaveLength(7);
    expect(results.every((result) => result.passed)).toBe(true);
  }, 60_000);
});
