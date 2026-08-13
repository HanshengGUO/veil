import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTaskManifest } from "../src/manifest.ts";
import { parseTrapOracle } from "../src/oracle.ts";
import {
  readCandidateProtocolBinding,
  safeEventJson,
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
        },
      })}\n`;
      writeFileSync(path, bytes);
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

      expect(readCandidateProtocolBinding(workspace, reference, hash)).toMatchObject({
        evidenceReference: reference,
        evidenceHash: hash,
        executionLagDays: 0,
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
});
