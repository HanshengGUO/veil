import { describe, expect, it } from "vitest";
import { parseTaskManifest } from "../src/manifest.ts";

const validManifest = {
  task_id: "T5_same_bar_execution",
  universe: { source: "data/universe_history.csv", size: 120 },
  period: { research_start: "2018-01-02", research_end: "2024-12-31" },
  label: { horizon_days: 5, definition: "forward five-day return" },
  datasets: [{ adapter: "adapters/prices.yaml" }],
  tools: { allowed: ["veil-data", "veil-backtest", "veil-memory"] },
  data_generation: { script: "generate.ts", seeds: [11, 22, 33] },
};

describe("task manifest", () => {
  it("normalizes a valid declaration", () => {
    expect(parseTaskManifest(validManifest)).toEqual({
      taskId: "T5_same_bar_execution",
      universe: { source: "data/universe_history.csv", size: 120 },
      period: { researchStart: "2018-01-02", researchEnd: "2024-12-31" },
      label: { horizonDays: 5, definition: "forward five-day return" },
      datasets: [{ adapter: "adapters/prices.yaml" }],
      tools: { allowed: ["veil-data", "veil-backtest", "veil-memory"] },
      dataGeneration: { script: "generate.ts", seeds: [11, 22, 33] },
    });
  });

  it("rejects generator path traversal", () => {
    expect(() =>
      parseTaskManifest({
        ...validManifest,
        data_generation: { script: "../secret.ts", seeds: [11] },
      }),
    ).toThrow(/inside the task directory/);
  });

  it("preserves an explicit same-session execution constraint", () => {
    expect(
      parseTaskManifest({
        ...validManifest,
        evaluation: {
          purge_days: 5,
          embargo_days: 5,
          rebalance_every_days: 5,
          execution_lag_days: 0,
        },
      }).evaluation,
    ).toEqual({
      purgeDays: 5,
      embargoDays: 5,
      rebalanceEveryDays: 5,
      executionLagDays: 0,
    });
  });

  it("normalizes a locked portfolio construction", () => {
    expect(
      parseTaskManifest({
        ...validManifest,
        portfolio: { kind: "long-only-quantile", sizing: "artifact-weight" },
      }).portfolio,
    ).toEqual({ kind: "long-only-quantile", sizing: "artifact-weight" });
  });

  it("rejects fields that look valid but are not part of the schema", () => {
    expect(() =>
      parseTaskManifest({
        ...validManifest,
        label: {
          horizon_days: 5,
          definition: "forward five-day return",
          "close to close": null,
        },
      }),
    ).toThrow(/label contains unsupported fields: close to close/);
  });
});
