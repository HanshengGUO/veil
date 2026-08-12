import { describe, expect, it } from "vitest";
import { selectTaskSeed } from "../src/seed.ts";

describe("task seed derivation", () => {
  it("is deterministic and variant-sensitive", () => {
    expect(selectTaskSeed("T5_same_bar_execution", [11, 22, 33], "smoke-v1")).toBe(11);
    expect(selectTaskSeed("T5_same_bar_execution", [11, 22, 33], "smoke-v1")).toBe(
      selectTaskSeed("T5_same_bar_execution", [11, 22, 33], "smoke-v1"),
    );
    expect(selectTaskSeed("T5_same_bar_execution", [11, 22, 33], "seed:11")).toBe(11);
  });

  it("rejects a seed outside the calibrated bank", () => {
    expect(() => selectTaskSeed("T5", [11, 22, 33], "seed:44")).toThrow(/not in/);
    expect(() => selectTaskSeed("T5", [-1], "default")).toThrow(/unsigned 32-bit/);
  });
});
