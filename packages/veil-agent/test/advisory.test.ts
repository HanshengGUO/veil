import { describe, expect, it } from "vitest";
import { detectExplorationAdvisory } from "../src/index.ts";

describe("exploration advisory", () => {
  it("labels common leakage shapes without returning a blocking decision", () => {
    const advisory = detectExplorationAdvisory(`
      const target = returns.shift(-1);
      const scaler = fit_transform(fullSample);
      const universe = current constituents;
    `);

    expect(advisory?.codes).toEqual(["FULL_SAMPLE", "FUTURE_FUNCTION", "SURVIVORSHIP"]);
    expect(advisory?.text).toContain("exploration remains unblocked");
    expect(advisory).not.toHaveProperty("block");
  });

  it("stays silent for ordinary bounded code", () => {
    expect(detectExplorationAdvisory("const score = price / laggedPrice - 1;")).toBeNull();
  });
});
