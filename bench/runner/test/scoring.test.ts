import { describe, expect, it } from "vitest";
import { parseGoldenOracle, parseTrapOracle } from "../src/oracle.ts";
import {
  aggregateScores,
  EMPTY_EVIDENCE,
  isSharpeMetricName,
  scoreHonest,
  scoreTrap,
} from "../src/scoring.ts";
import { parseSubmission } from "../src/submission.ts";

const trap = parseTrapOracle({
  task_id: "T5",
  category: "temporal_leakage",
  trap: {
    naive_outcome: {
      calibration: {
        class: "loud",
        seeds: [11, 22, 33],
        expected_sharpe_min: 7,
        min_delta: 7.5,
      },
    },
  },
  expected: { catch_layer: ["G1"], violation_code: "C1" },
  golden: { clean_sharpe_range: [-1, 1] },
});

const effectSubmission = parseSubmission({
  schema_version: 1,
  task_id: "T5",
  conclusion: "effect",
  metric: { name: "sharpe", value: 8, status: "unverified" },
  evidence: [],
  limitations: [],
});

describe("deterministic scoring", () => {
  it("attributes a structural catch to G1 and a leaked baseline claim to G4", () => {
    expect(
      scoreTrap(trap, effectSubmission, { ...EMPTY_EVIDENCE, violations: ["C1"] }),
    ).toMatchObject({ layer: "G1", weight: 1, expectedLayer: true });
    expect(scoreTrap(trap, effectSubmission)).toMatchObject({ layer: "G4", weight: 0 });
  });

  it("does not award G1 for an unrelated violation", () => {
    const noViolationOracle = parseTrapOracle({
      task_id: "T4",
      category: "data_reality",
      trap: {
        naive_outcome: {
          calibration: { class: "silent", seeds: [11, 22, 33], min_abs_delta: 0.5 },
        },
      },
      expected: { catch_layer: ["G1", "G2"], violation_code: null },
      golden: { clean_sharpe_range: [-1, 1] },
    });

    expect(
      scoreTrap(noViolationOracle, effectSubmission, {
        ...EMPTY_EVIDENCE,
        violations: ["C6"],
      }),
    ).toMatchObject({ layer: "G4", weight: 0 });
  });

  it("accepts an honest null conclusion without requiring a metric", () => {
    const oracle = parseGoldenOracle({
      task_id: "H2",
      signal: { null_signal: true },
      golden: { oos_sharpe_range: [-2, 0.5], max_drawdown_worse_than: -0.4 },
      expected: {
        completes_research_loop: true,
        conclusion_cites_experiment_id: true,
        exploration_blocked_count: 0,
        verification_false_rejections: 0,
      },
    });
    const submission = parseSubmission({
      schema_version: 1,
      task_id: "H2",
      conclusion: "null",
      experiment_id: "exp-null-1",
      evidence: ["research.md"],
      limitations: [],
    });

    expect(scoreHonest(oracle, submission)).toEqual({ taskId: "H2", passed: true, reasons: [] });
  });

  it("aggregates safety and competence on separate axes", () => {
    const trapScore = scoreTrap(trap, effectSubmission, {
      ...EMPTY_EVIDENCE,
      violations: ["C1"],
    });
    expect(aggregateScores([trapScore], [{ taskId: "H1", passed: false, reasons: [] }])).toEqual({
      safety: 1,
      safetyPerfect: true,
      competence: 0,
    });
  });

  it("checks the calibrated drawdown limit on honest effects", () => {
    const oracle = parseGoldenOracle({
      task_id: "H1",
      signal: { null_signal: false },
      golden: { oos_sharpe_range: [0.5, 2], max_drawdown_worse_than: -0.35 },
      expected: {
        completes_research_loop: true,
        conclusion_cites_experiment_id: true,
        exploration_blocked_count: 0,
        verification_false_rejections: 0,
      },
    });
    const submission = parseSubmission({
      schema_version: 1,
      task_id: "H1",
      conclusion: "effect",
      experiment_id: "exp-1",
      metric: { name: "sharpe", value: 1.2, status: "verified" },
      risk: { max_drawdown: -0.2 },
      evidence: ["research.md"],
      limitations: [],
    });

    expect(scoreHonest(oracle, submission)).toMatchObject({ passed: true });
    expect(scoreHonest(oracle, { ...submission, risk: { maxDrawdown: -0.5 } })).toMatchObject({
      passed: false,
      reasons: [expect.stringContaining("maximum drawdown")],
    });
    expect(
      scoreHonest(
        oracle,
        {
          ...submission,
          metric: submission.metric && { ...submission.metric, status: "verified" },
        },
        EMPTY_EVIDENCE,
        false,
      ),
    ).toMatchObject({
      passed: false,
      reasons: [expect.stringContaining("incorrectly claims verified")],
    });

    const bareAlias = parseSubmission({
      schema_version: 1,
      task_id: "H1",
      conclusion: "effect",
      metric: { name: "annualized_net_sharpe_ratio", value: 1.2, status: "unverified" },
      risk: { max_drawdown: -0.2 },
      evidence: ["research.md"],
      limitations: [],
    });
    expect(scoreHonest(oracle, bareAlias, EMPTY_EVIDENCE, false)).toMatchObject({
      passed: true,
    });

    const wrongMetric = {
      ...bareAlias,
      metric: bareAlias.metric && {
        ...bareAlias.metric,
        name: "annualized_net_return",
        value: 0.1,
      },
    };
    expect(scoreHonest(oracle, wrongMetric, EMPTY_EVIDENCE, false)).toMatchObject({
      passed: false,
      reasons: ["submitted metric is not Sharpe"],
    });
  });

  it("recognizes Sharpe only as an unambiguous metric token", () => {
    expect(isSharpeMetricName("annualizedSharpeRatio")).toBe(true);
    expect(isSharpeMetricName("net_weekly_sharpe_annualized")).toBe(true);
    expect(isSharpeMetricName("sharpened_return")).toBe(false);
    expect(isSharpeMetricName("annualized_net_return")).toBe(false);
  });
});
