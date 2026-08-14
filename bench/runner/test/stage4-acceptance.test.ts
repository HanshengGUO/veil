import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyStage4BenchAcceptance } from "../src/stage4-acceptance.ts";

describe("Stage 4 model-free acceptance", () => {
  it("attributes trial and knowledge-timing rejection to G2", async () => {
    const report = await verifyStage4BenchAcceptance({
      tasksDirectory: resolve("bench/tasks"),
      runAgentLoop: async () => ({
        verdicts: ["rejected", "rejected", "accepted"],
        claimStatus: "verified",
        experimentId: `sha256:${"1".repeat(64)}`,
        archivedSnapshots: 31,
        memoryExperiments: 5,
        reproductionStatus: "matched",
        gateReasons: [
          {
            gateId: "capacity-sensitivity",
            reasonCode: "capacity-stress-passed",
          },
        ],
        trialBudgetRejection: [{ gateId: "trial-budget", reasonCode: "trial-budget-exhausted" }],
        knowledgeContaminationRejection: [
          {
            gateId: "hypothesis-contamination",
            reasonCode: "post-cutoff-validation-required",
          },
        ],
      }),
    });

    expect(report.gateAttribution.map((item) => item.layer)).toEqual(["G2", "G2"]);
    expect(report.capacityGatePassed).toBe(true);
    expect(report.modelCompetenceScored).toBe(false);
  });
});
