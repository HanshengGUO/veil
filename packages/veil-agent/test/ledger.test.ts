import { describe, expect, it } from "vitest";
import {
  createBriefEntry,
  createHypothesisEntry,
  hypothesisRegistrationFromEntry,
  reconstructSessionLedger,
  VEIL_BRIEF_ENTRY,
  VEIL_HYPOTHESIS_ENTRY,
  VEIL_RUN_RESULT_ENTRY,
  VEIL_VERIFICATION_START_ENTRY,
  VeilAgentError,
} from "../src/index.ts";

interface TestEntry {
  readonly type: "custom";
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly customType: string;
  readonly data: unknown;
}

function entry(
  id: string,
  customType: string,
  data: unknown,
  timestamp = "2026-08-13T00:00:00.000Z",
  parentId: string | null = null,
): TestEntry {
  return { type: "custom", id, parentId, timestamp, customType, data };
}

describe("Stage 3 session ledger", () => {
  it("restores only supplied active-branch entries and derives trusted C6 evidence", () => {
    const brief = createBriefEntry("Study point-in-time momentum.", "automatic");
    const hypothesis = createHypothesisEntry({
      hypothesisRef: "momentum-v1",
      statement: "Past winners outperform after a one-session lag.",
      ideaAvailableAt: "2026-08-12T00:00:00.000Z",
      captureMode: "explicit",
    });
    const branch = [
      entry("brief-1", VEIL_BRIEF_ENTRY, brief, "2026-08-13T00:00:00.000Z"),
      entry(
        "hypothesis-1",
        VEIL_HYPOTHESIS_ENTRY,
        hypothesis,
        "2026-08-13T00:00:01.000Z",
        "brief-1",
      ),
      { type: "message", id: "message-1", timestamp: "2026-08-13T00:00:02.000Z" },
    ];
    const ledger = reconstructSessionLedger(branch);

    expect(ledger.briefs).toHaveLength(1);
    expect(ledger.hypotheses).toHaveLength(1);
    const durable = ledger.hypotheses[0];
    if (durable === undefined) throw new Error("durable hypothesis was not restored");
    const registration = hypothesisRegistrationFromEntry(durable);
    expect(registration).toMatchObject({
      hypothesisRef: "momentum-v1",
      registeredAt: "2026-08-13T00:00:01.000Z",
      source: { kind: "explicit", reference: "pi-entry:hypothesis-1" },
    });

    const sibling = entry(
      "hypothesis-sibling",
      VEIL_HYPOTHESIS_ENTRY,
      createHypothesisEntry({
        hypothesisRef: "sibling-v1",
        statement: "A sibling branch idea.",
        ideaAvailableAt: "2026-08-12T00:00:00.000Z",
        captureMode: "automatic",
      }),
      "2026-08-13T00:00:03.000Z",
      "brief-1",
    );
    expect(reconstructSessionLedger([...branch, sibling]).hypotheses).toHaveLength(2);
    expect(reconstructSessionLedger(branch).hypotheses).toHaveLength(1);
  });

  it("fails closed for malformed Veil data and impossible run chronology", () => {
    const brief = createBriefEntry("A valid brief.", "automatic");
    expect(() =>
      reconstructSessionLedger([entry("bad", VEIL_BRIEF_ENTRY, { ...brief, unexpected: true })]),
    ).toThrowError(VeilAgentError);

    expect(() =>
      reconstructSessionLedger([
        entry("result", VEIL_RUN_RESULT_ENTRY, {
          format: VEIL_RUN_RESULT_ENTRY,
          runId: "run:orphan",
          outcome: "rejected",
          candidate: null,
          failureCode: "C1",
          evidenceReference: null,
          evidenceHash: null,
          researchLogReference: ".veil/research-log.md",
        }),
      ]),
    ).toThrow(/no earlier verification start/);
  });

  it("accepts one start and one terminal result without inventing an Experiment", () => {
    const start = {
      format: VEIL_VERIFICATION_START_ENTRY,
      runId: "run:one",
      requestReference: ".veil/promotion.yaml",
      hypothesisRef: "hypothesis-v1",
    } as const;
    const result = {
      format: VEIL_RUN_RESULT_ENTRY,
      runId: "run:one",
      outcome: "rejected",
      candidate: null,
      failureCode: "C2",
      evidenceReference: null,
      evidenceHash: null,
      researchLogReference: ".veil/research-log.md",
    } as const;
    const ledger = reconstructSessionLedger([
      entry("start", VEIL_VERIFICATION_START_ENTRY, start, "2026-08-13T00:00:00.000Z"),
      entry("result", VEIL_RUN_RESULT_ENTRY, result, "2026-08-13T00:00:01.000Z", "start"),
    ]);
    expect(ledger.runResults[0]?.data).toEqual(result);
    expect(JSON.stringify(ledger)).not.toContain("experimentId");
  });
});
