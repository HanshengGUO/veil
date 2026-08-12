import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SMOKE_TASK_IDS, selectSuiteTasks } from "../src/suite.ts";
import { discoverTasks } from "../src/tasks.ts";

describe("bench suites", () => {
  it("keeps a two-trap, two-honest smoke suite", () => {
    const smoke = selectSuiteTasks(discoverTasks(resolve("bench/tasks")), "smoke");

    expect(smoke.map((task) => task.manifest.taskId)).toEqual(SMOKE_TASK_IDS);
    expect(smoke.filter((task) => task.kind === "trap")).toHaveLength(2);
    expect(smoke.filter((task) => task.kind === "honest")).toHaveLength(2);
  });
});
