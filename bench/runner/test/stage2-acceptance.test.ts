import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyStage2BenchAcceptance } from "../src/stage2-acceptance.ts";

describe("Stage 2 bench acceptance", () => {
  it("catches T1-T5 mechanisms without rejecting honest tasks or blocking exploration", async () => {
    const report = await verifyStage2BenchAcceptance({
      tasksDirectory: resolve("bench/tasks"),
    });

    expect(report.publicTaskCount).toBe(15);
    expect(report.catalogAdapterCount).toBe(17);
    expect(
      report.trapProbes.map((probe) => [probe.taskId, probe.outcome, probe.invariant]),
    ).toEqual([
      ["T1_full_sample_normalization", "isolated", "C1"],
      ["T2_no_purge", "blocked", "C2"],
      ["T3_missing_availability", "degraded", "C1"],
      ["T4_survivorship", "degraded", null],
      ["T5_same_bar_execution", "blocked", "C1"],
    ]);
    expect(report.honestTasks).toHaveLength(7);
    expect(report.honestTasks.every((task) => task.outcome === "accepted")).toBe(true);
    expect(report.explorationBlockedCount).toBe(0);
    expect(JSON.stringify(report)).not.toContain(resolve("."));
    expect(JSON.stringify(report)).not.toContain("source.connection");
  });
});
