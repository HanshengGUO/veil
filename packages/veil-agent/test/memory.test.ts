import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  executeVeilMemoryTool,
  experimentMemoryContext,
  type HypothesisEntryData,
  VEIL_EXPERIMENT_ENTRY,
  type VEIL_HYPOTHESIS_ENTRY,
  VEIL_VERIFICATION_START_ENTRY,
  VeilAgentError,
} from "../src/index.ts";

describe("veil-memory", () => {
  it("strictly registers once and reports branch-local Stage 3 scope", () => {
    const entries: Array<{
      readonly type: "custom";
      readonly id: string;
      readonly parentId: string | null;
      readonly timestamp: string;
      readonly customType: string;
      readonly data: unknown;
    }> = [];
    const appendEntry = (customType: typeof VEIL_HYPOTHESIS_ENTRY, data: HypothesisEntryData) => {
      entries.push({
        type: "custom",
        id: `entry-${entries.length + 1}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-08-13T00:00:01.000Z",
        customType,
        data,
      });
    };
    const context = {
      getBranch: () => entries,
      appendEntry,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    };
    const first = executeVeilMemoryTool(
      {
        action: "register_hypothesis",
        hypothesis_ref: "momentum-v1",
        statement: "Past winners outperform after a one-session lag.",
      },
      context,
    );
    const second = executeVeilMemoryTool(
      {
        action: "register_hypothesis",
        hypothesis_ref: "momentum-v1",
        statement: "Past winners outperform after a one-session lag.",
      },
      context,
    );
    const status = executeVeilMemoryTool({ action: "status" }, context);

    expect(first.result).toMatchObject({ created: true, captureMode: "explicit" });
    expect(second.result).toMatchObject({ created: false });
    expect(entries).toHaveLength(1);
    expect(status.result).toMatchObject({
      scope: "active-session-branch",
      counts: { hypotheses: 1, completedRuns: 0 },
      experimentCount: 0,
    });
    expect(JSON.stringify(status)).not.toContain("experimentId");

    expect(() =>
      executeVeilMemoryTool(
        {
          action: "register_hypothesis",
          hypothesis_ref: "momentum-v1",
          statement: "A changed statement under the same reference.",
        },
        context,
      ),
    ).toThrowError(VeilAgentError);

    expect(() => executeVeilMemoryTool({ action: "status", statement: "unused" }, context)).toThrow(
      /fields unused/,
    );

    expect(() =>
      executeVeilMemoryTool(
        {
          action: "register_hypothesis",
          hypothesis_ref: "future-v1",
          statement: "An idea from the future.",
          idea_available_at: "2026-08-14T00:00:00.000Z",
        },
        context,
      ),
    ).toThrow(/no later than registration/);
  });

  it("retrieves Experiment families and derives the observable trial-count lower bound", () => {
    const hypothesis = {
      format: "veil.hypothesis.v0",
      hypothesisRef: "momentum-v1",
      statement: "Past winners outperform after costs.",
      ideaAvailableAt: "2026-08-12T00:00:00.000Z",
      captureMode: "explicit",
    } as const;
    const experiment = experimentRecord();
    const entries = [
      durable("hypothesis", "veil.hypothesis.v0", hypothesis, "2026-08-13T00:00:00.000Z"),
      durable(
        "start",
        VEIL_VERIFICATION_START_ENTRY,
        {
          format: VEIL_VERIFICATION_START_ENTRY,
          runId: "run:one",
          requestReference: ".veil/promotion.yaml",
          hypothesisRef: "momentum-v1",
        },
        "2026-08-13T00:00:01.000Z",
      ),
      durable("experiment", VEIL_EXPERIMENT_ENTRY, experiment, "2026-08-13T00:00:03.000Z"),
    ];
    const context = {
      getBranch: () => entries,
      appendEntry: () => undefined,
    };

    expect(executeVeilMemoryTool({ action: "status" }, context).result).toMatchObject({
      experimentCount: 1,
    });
    expect(executeVeilMemoryTool({ action: "list_experiments" }, context).result).toEqual([
      expect.objectContaining({ experimentId: experiment.experimentId, verdict: "rejected" }),
    ]);
    expect(
      executeVeilMemoryTool(
        { action: "get_experiment", experiment_id: experiment.experimentId },
        context,
      ).result,
    ).toMatchObject({ claimStatus: "rejected" });
    expect(
      executeVeilMemoryTool({ action: "family", hypothesis_ref: "momentum-v1" }, context).result,
    ).toMatchObject({ hypothesisRef: "momentum-v1", experiments: [{ verdict: "rejected" }] });
    expect(
      executeVeilMemoryTool({ action: "trial_evidence", hypothesis_ref: "momentum-v1" }, context)
        .result,
    ).toMatchObject({
      sessionAttemptIds: ["run:one"],
      familyExperimentIds: [experiment.experimentId],
    });
    expect(experimentMemoryContext(entries)).toContain("cost-sensitivity:cost-stress-failed");
  });
});

function durable(id: string, customType: string, data: unknown, timestamp: string) {
  return {
    type: "custom" as const,
    id,
    parentId: null,
    timestamp,
    customType,
    data,
  };
}

function experimentRecord() {
  const body = {
    format: "veil.experiment-memory.v0",
    experimentId: hash("a"),
    hypothesisRef: "momentum-v1",
    candidateHash: hash("b"),
    artifactHash: hash("c"),
    parameterLockHash: hash("d"),
    dataset: {
      dataset: "prices",
      version: "v1",
      declarationHash: hash("e"),
      degradations: [],
    },
    issuedAt: "2026-08-13T00:00:02.000Z",
    verdict: "rejected",
    claimStatus: "rejected",
    effectiveTrials: 3,
    metrics: [
      {
        name: "sharpe",
        scope: "walk-forward-oos",
        basis: "net",
        unit: "ratio",
        value: 1.2,
      },
    ],
    gateReasons: [
      {
        gateId: "cost-sensitivity",
        outcome: "failed",
        reasonCode: "cost-stress-failed",
      },
    ],
    lessons: ["Revisit turnover."],
  } as const;
  return {
    ...body,
    memoryHash: `sha256:${createHash("sha256")
      .update("veil.experiment-memory.v0")
      .update("\0")
      .update(canonical(body))
      .digest("hex")}`,
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function canonical(input: unknown): string {
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "number" ||
    typeof input === "string"
  ) {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  const root = input as Record<string, unknown>;
  return `{${Object.keys(root)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(root[key])}`)
    .join(",")}}`;
}
