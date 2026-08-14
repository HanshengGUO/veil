import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTaskManifest } from "../src/manifest.ts";
import { parseGoldenOracle, parseTrapOracle } from "../src/oracle.ts";
import {
  readCandidateProtocolBinding,
  safeEventJson,
  scoreVeilStage4Task,
  scoreVeilTask,
  type VeilVerificationEvidence,
} from "../src/pi-session.ts";
import { EMPTY_EVIDENCE } from "../src/scoring.ts";
import { parseSubmission } from "../src/submission.ts";

describe("Pi session event capture", () => {
  it("keeps streaming deltas without cumulative message snapshots", () => {
    const event = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "next token",
        partial: { content: "the complete response so far" },
      },
      message: { content: "the complete response so far" },
    };

    expect(JSON.parse(safeEventJson(event as never))).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "next token",
      },
    });
  });

  it("reads protocol fields only from hash-matched immutable candidate evidence", () => {
    const workspace = mkdtempSync(join(tmpdir(), "veil-candidate-protocol-"));
    try {
      const reference = ".veil/runs/candidate.json";
      const path = join(workspace, reference);
      mkdirSync(join(workspace, ".veil", "runs"), { recursive: true });
      const bytes = `${JSON.stringify({
        artifact: {
          protocol: {
            purgeDays: 5,
            embargoDays: 5,
            holdDays: 5,
            executionLagDays: 0,
          },
          declaredLiterals: {
            oosPricing: {
              portfolio: {
                kind: "long-only-quantile",
                quantile: 0.2,
                weightColumn: "portfolio_weight",
              },
            },
          },
        },
      })}\n`;
      writeFileSync(path, bytes);
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

      expect(readCandidateProtocolBinding(workspace, reference, hash)).toMatchObject({
        evidenceReference: reference,
        evidenceHash: hash,
        executionLagDays: 0,
        portfolioKind: "long-only-quantile",
        weightColumn: "portfolio_weight",
      });
      expect(() =>
        readCandidateProtocolBinding(workspace, reference, `sha256:${"0".repeat(64)}`),
      ).toThrow(/hash does not match/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an effect when its cited candidate silently changes the task protocol", () => {
    const task = {
      kind: "trap" as const,
      directory: "/benchmark/T5",
      manifest: parseTaskManifest({
        task_id: "T5",
        universe: { source: "data/universe.csv", size: 20 },
        period: { research_start: "2020-01-01", research_end: "2021-12-31" },
        label: { horizon_days: 5, definition: "forward return" },
        evaluation: {
          purge_days: 5,
          embargo_days: 5,
          rebalance_every_days: 5,
          execution_lag_days: 0,
        },
        datasets: [{ adapter: "adapters/prices.yaml" }],
        tools: { allowed: ["veil-data", "veil-backtest", "veil-memory"] },
        data_generation: { script: "generate.ts", seeds: [11, 22, 33] },
      }),
      oracle: parseTrapOracle({
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
        golden: { clean_sharpe_range: [-0.8, 0.8] },
      }),
    };
    const evidenceReference = ".veil/runs/candidate.json";
    const submission = parseSubmission({
      schema_version: 1,
      task_id: "T5",
      conclusion: "effect",
      metric: { name: "sharpe", value: 0.22, status: "unverified" },
      evidence: [evidenceReference],
      limitations: ["Stage 4 pending"],
    });
    const evidence: VeilVerificationEvidence = {
      ...EMPTY_EVIDENCE,
      promotionCandidateIssued: true,
      candidateEvidenceReferences: [evidenceReference],
      candidateProtocolBindings: [
        {
          evidenceReference,
          evidenceHash: `sha256:${"1".repeat(64)}`,
          purgeDays: 5,
          embargoDays: 5,
          holdDays: 5,
          executionLagDays: 1,
        },
      ],
    };

    expect(scoreVeilTask(task, submission, evidence)).toMatchObject({
      layer: "G1",
      weight: 1,
      reason: "claim enforcement rejected an effect backed by a different protocol than the task",
    });
    expect(
      scoreVeilTask(task, submission, {
        ...evidence,
        candidateProtocolBindings: [
          {
            evidenceReference,
            evidenceHash: `sha256:${"1".repeat(64)}`,
            purgeDays: 5,
            embargoDays: 5,
            holdDays: 5,
            executionLagDays: 0,
          },
        ],
      }),
    ).toMatchObject({ layer: "G4", weight: 0 });
  });

  it("binds Stage 4 conclusions to the cited Experiment metrics and null gate evidence", () => {
    const task = {
      kind: "honest" as const,
      directory: "/benchmark/H1",
      manifest: parseTaskManifest({
        task_id: "H1",
        universe: { source: "data/universe.csv", size: 20 },
        period: { research_start: "2020-01-01", research_end: "2021-12-31" },
        label: { horizon_days: 5, definition: "forward return" },
        evaluation: {
          purge_days: 5,
          embargo_days: 5,
          rebalance_every_days: 5,
          execution_lag_days: 1,
        },
        portfolio: { kind: "long-short-quantile", sizing: "equal" },
        datasets: [{ adapter: "adapters/prices.yaml" }],
        tools: { allowed: ["veil-data", "veil-backtest", "veil-memory"] },
        data_generation: { script: "generate.ts", seeds: [11, 22, 33] },
      }),
      oracle: parseGoldenOracle({
        task_id: "H1",
        signal: { null_signal: false },
        golden: { oos_sharpe_range: [0.5, 2], max_drawdown_worse_than: -0.4 },
        expected: {
          completes_research_loop: true,
          conclusion_cites_experiment_id: true,
          exploration_blocked_count: 0,
          verification_false_rejections: 0,
        },
      }),
    };
    const experimentId = `sha256:${"e".repeat(64)}`;
    const evidenceReference = ".veil/runs/candidate.json";
    const submission = parseSubmission({
      schema_version: 1,
      task_id: "H1",
      conclusion: "effect",
      experiment_id: experimentId,
      metric: { name: "sharpe", value: 1.2, status: "verified" },
      risk: { max_drawdown: -0.2 },
      evidence: ["research.md", evidenceReference],
      limitations: [],
    });
    const evidence: VeilVerificationEvidence = {
      ...EMPTY_EVIDENCE,
      promotionCandidateIssued: true,
      candidateEvidenceReferences: [evidenceReference],
      candidateProtocolBindings: [
        {
          evidenceReference,
          evidenceHash: `sha256:${"1".repeat(64)}`,
          purgeDays: 5,
          embargoDays: 5,
          holdDays: 5,
          executionLagDays: 1,
          portfolioKind: "long-short-quantile",
          weightColumn: null,
        },
      ],
      experiments: [
        {
          experimentId,
          verdict: "accepted",
          claimStatus: "verified",
          metrics: [
            { name: "sharpe", basis: "net", unit: "ratio", value: 1.2 },
            { name: "max-drawdown", basis: "net", unit: "decimal", value: -0.2 },
          ],
          gateReasons: [],
        },
      ],
    };

    expect(scoreVeilStage4Task(task, submission, evidence)).toMatchObject({ passed: true });
    expect(
      scoreVeilStage4Task(task, submission, {
        ...evidence,
        candidateProtocolBindings: evidence.candidateProtocolBindings?.map((binding) => ({
          ...binding,
          portfolioKind: "long-only-quantile" as const,
        })),
      }),
    ).toMatchObject({
      passed: false,
      reasons: expect.arrayContaining([
        "cited candidate does not bind the portfolio construction required by the task",
      ]),
    });
    expect(
      scoreVeilStage4Task(
        task,
        { ...submission, metric: { name: "sharpe", value: 1.1, status: "verified" } },
        evidence,
      ),
    ).toMatchObject({
      passed: false,
      reasons: expect.arrayContaining([
        "submitted Sharpe does not equal the cited Experiment metric",
      ]),
    });

    const nullTask = {
      ...task,
      oracle: parseGoldenOracle({
        task_id: "H1",
        signal: { null_signal: true },
        golden: { oos_sharpe_range: [-2, 0.5], max_drawdown_worse_than: -0.4 },
        expected: {
          completes_research_loop: true,
          conclusion_cites_experiment_id: true,
          exploration_blocked_count: 0,
          verification_false_rejections: 0,
        },
      }),
    };
    const nullSubmission = parseSubmission({
      schema_version: 1,
      task_id: "H1",
      conclusion: "null",
      experiment_id: experimentId,
      evidence: ["research.md", evidenceReference],
      limitations: [],
    });
    const nullEvidence: VeilVerificationEvidence = {
      ...evidence,
      experiments: [
        {
          experimentId,
          verdict: "rejected",
          claimStatus: "rejected",
          metrics: [],
          gateReasons: [
            {
              gateId: "trials-aware-deflated-sharpe",
              outcome: "failed",
              reasonCode: "deflated-sharpe-failed",
            },
          ],
        },
      ],
    };
    expect(scoreVeilStage4Task(nullTask, nullSubmission, nullEvidence)).toMatchObject({
      passed: true,
    });
    expect(scoreVeilStage4Task(task, nullSubmission, nullEvidence)).toMatchObject({
      passed: true,
      reasons: [],
    });
    expect(
      scoreVeilStage4Task(task, nullSubmission, {
        ...nullEvidence,
        experiments: [
          {
            experimentId,
            verdict: "rejected",
            claimStatus: "rejected",
            metrics: [],
            gateReasons: [
              {
                gateId: "capacity-sensitivity",
                outcome: "failed",
                reasonCode: "capacity-participation-exceeded",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      passed: false,
      reasons: expect.arrayContaining([
        "cited Experiment does not support the submitted null conclusion",
      ]),
    });
  });
});
