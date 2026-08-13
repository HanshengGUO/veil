import { describe, expect, it } from "vitest";
import { type BaselineSummary, renderBaselineReport } from "../src/baseline.ts";

describe("baseline reports", () => {
  it("renders both score axes and trap attribution", () => {
    const summary: BaselineSummary = {
      schemaVersion: 1,
      profile: "bare",
      suite: "smoke",
      variant: "test-v1",
      taskCount: 2,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      models: [
        {
          model: { provider: "test", model: "model", thinkingLevel: "off" },
          suiteScore: { safety: 0, safetyPerfect: false, competence: 1 },
          falseEffectClaims: 1,
          completedRuns: 2,
          failedRuns: 0,
          trapScores: [
            {
              taskId: "T5",
              layer: "G4",
              weight: 0,
              expectedLayer: false,
              reason: "false effect reached the conclusion",
            },
          ],
          honestScores: [{ taskId: "H2", passed: true, reasons: [] }],
          failures: [],
        },
      ],
    };

    const report = renderBaselineReport(summary);
    expect(report).toContain("| `test/model` | 0.00 | no | 1.00 | 1 | 2 | 0 |");
    expect(report).toContain("| T5 | G4 | 0.00 |");

    const veilReport = renderBaselineReport({ ...summary, profile: "veil" });
    expect(veilReport).toContain("# Veil Stage 3 evaluation");
    expect(veilReport).toContain("This Stage 3 evaluation is diagnostic.");
  });

  it("lists failed runs and escapes table delimiters in errors", () => {
    const summary: BaselineSummary = {
      schemaVersion: 1,
      profile: "bare",
      suite: "smoke",
      variant: "test-v1",
      taskCount: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      models: [
        {
          model: { provider: "test", model: "model", thinkingLevel: "off" },
          suiteScore: { safety: 0, safetyPerfect: false, competence: 0 },
          falseEffectClaims: 0,
          completedRuns: 0,
          failedRuns: 1,
          trapScores: [],
          honestScores: [{ taskId: "H2", passed: false, reasons: ["run failed"] }],
          failures: [
            {
              taskId: "H2",
              taskKind: "honest",
              error: "missing submission | timed out",
            },
          ],
        },
      ],
    };

    const report = renderBaselineReport(summary);
    expect(report).toContain("## Failed runs");
    expect(report).toContain("| `test/model` | H2 | honest | missing submission \\| timed out |");
  });
});
