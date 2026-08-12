import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CALIBRATIONS } from "../../fixtures/calibrate.ts";
import { HONEST_REFERENCES } from "../../fixtures/catalog.ts";
import { discoverTasks } from "../src/tasks.ts";

describe("public task catalog", () => {
  it("contains seven calibrated traps and seven calibrated honest tasks", () => {
    const tasks = discoverTasks(resolve("bench/tasks"));

    expect(tasks).toHaveLength(14);
    expect(tasks.filter((task) => task.kind === "trap")).toHaveLength(7);
    expect(tasks.filter((task) => task.kind === "honest")).toHaveLength(7);
    expect(new Set(tasks.map((task) => task.manifest.taskId)).size).toBe(14);
  });

  it("keeps task oracles synchronized with the executable calibration definitions", () => {
    const tasks = discoverTasks(resolve("bench/tasks"));
    const calibrations = new Map(CALIBRATIONS.map((calibration) => [calibration.id, calibration]));

    for (const task of tasks) {
      if (task.kind === "honest") {
        const reference = HONEST_REFERENCES[task.manifest.taskId as keyof typeof HONEST_REFERENCES];
        expect(reference).toBeDefined();
        expect(task.oracle.sharpeRange).toEqual(reference.sharpeRange);
        expect(task.oracle.maxDrawdownWorseThan).toBe(reference.maxDrawdownWorseThan);
        expect(task.oracle.nullSignal).toBe(reference.nullSignal);
        continue;
      }

      const calibration = calibrations.get(task.manifest.taskId);
      expect(calibration).toBeDefined();
      if (calibration === undefined) continue;
      expect(task.oracle.calibration.class).toBe(calibration.class);
      if (calibration.class === "loud" && task.oracle.calibration.class === "loud") {
        expect(task.oracle.calibration.expectedSharpeMin).toBe(calibration.minNaiveSharpe);
        expect(task.oracle.calibration.minDelta).toBe(calibration.minDelta);
      } else if (calibration.class === "silent" && task.oracle.calibration.class === "silent") {
        expect(task.oracle.calibration.minAbsDelta).toBe(calibration.minAbsDelta);
      } else if (
        calibration.class === "structural" &&
        task.oracle.calibration.class === "structural"
      ) {
        expect(task.oracle.calibration.invariant).toBe(calibration.invariant);
      }
    }
  });
});
