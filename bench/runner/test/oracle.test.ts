import { describe, expect, it } from "vitest";
import { parseGoldenOracle, parseTrapOracle } from "../src/oracle.ts";

describe("bench oracles", () => {
  it("does not silently disable an honest-task expectation when a boolean is missing", () => {
    expect(() =>
      parseGoldenOracle({
        task_id: "H1",
        signal: { null_signal: false },
        golden: { oos_sharpe_range: [0.5, 2], max_drawdown_worse_than: -0.3 },
        expected: {
          conclusion_cites_experiment_id: true,
          exploration_blocked_count: 0,
          verification_false_rejections: 0,
        },
      }),
    ).toThrow(/completes_research_loop must be boolean/);
  });

  it("rejects non-positive calibration thresholds", () => {
    expect(() =>
      parseTrapOracle({
        task_id: "T4",
        category: "data_reality",
        trap: {
          naive_outcome: {
            calibration: { class: "silent", seeds: [11, 22, 33], min_abs_delta: 0 },
          },
        },
        expected: { catch_layer: ["G2"], violation_code: null },
        golden: { clean_sharpe_range: [-1, 1] },
      }),
    ).toThrow(/min_abs_delta must be positive/);
  });
});
