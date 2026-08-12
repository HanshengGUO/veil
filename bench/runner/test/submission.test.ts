import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSubmission, parseSubmission } from "../src/submission.ts";

describe("bench submission", () => {
  it("accepts an unverified baseline effect", () => {
    expect(
      parseSubmission(
        {
          schema_version: 1,
          task_id: "T5_same_bar_execution",
          conclusion: "effect",
          metric: { name: "sharpe", value: 7.8, status: "unverified" },
          evidence: ["research.md"],
          limitations: ["synthetic market"],
        },
        "T5_same_bar_execution",
      ),
    ).toMatchObject({
      conclusion: "effect",
      metric: { value: 7.8, status: "unverified" },
    });
  });

  it("requires an experiment id for a verified metric", () => {
    expect(() =>
      parseSubmission({
        schema_version: 1,
        task_id: "H1",
        conclusion: "effect",
        metric: { name: "sharpe", value: 0.8, status: "verified" },
        evidence: [],
        limitations: [],
      }),
    ).toThrow(/experiment_id/);
  });

  it("requires a reason for an invalid conclusion", () => {
    expect(() =>
      parseSubmission({
        schema_version: 1,
        task_id: "T2_no_purge",
        conclusion: "invalid",
        evidence: [],
        limitations: [],
      }),
    ).toThrow(/invalidity.reason/);
  });

  it("allows a null conclusion to cite a top-level experiment", () => {
    expect(
      parseSubmission({
        schema_version: 1,
        task_id: "H2",
        conclusion: "null",
        experiment_id: "exp-null-1",
        evidence: ["research.md"],
        limitations: [],
      }),
    ).toMatchObject({ conclusion: "null", experimentId: "exp-null-1" });
  });

  it("accepts risk metrics and rejects unknown fields", () => {
    expect(
      parseSubmission({
        schema_version: 1,
        task_id: "H1",
        conclusion: "effect",
        metric: { name: "sharpe", value: 1.2, status: "unverified" },
        risk: { max_drawdown: -0.2 },
        evidence: ["research.md"],
        limitations: [],
      }),
    ).toMatchObject({ risk: { maxDrawdown: -0.2 } });
    expect(() =>
      parseSubmission({
        schema_version: 1,
        task_id: "H1",
        conclusion: "null",
        answer: "extra",
        evidence: [],
        limitations: [],
      }),
    ).toThrow(/unsupported fields: answer/);
  });

  it("reports a missing submission without exposing its temporary workspace path", () => {
    const path = join(tmpdir(), `veil-no-submission-${process.pid}`, "submission.json");
    expect(() => loadSubmission(path)).toThrow("submission file does not exist: submission.json");
  });
});
