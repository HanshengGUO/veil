import type { TaskDefinition } from "./tasks.ts";

export type BenchSuite = "smoke" | "full";

/**
 * Fast, deliberately heterogeneous CI coverage: two traps and two honest tasks.
 *
 * T3 exercises a second dataset and missing availability metadata, T5 covers execution timing,
 * H2 requires an honest null result, and H6 carries tradability masks and halts.
 */
export const SMOKE_TASK_IDS = [
  "T3_missing_availability",
  "T5_same_bar_execution",
  "H2_null_market",
  "H6_halts_and_masks",
] as const;

export function selectSuiteTasks(
  tasks: readonly TaskDefinition[],
  suite: BenchSuite,
): TaskDefinition[] {
  if (suite === "full") return [...tasks];

  const byId = new Map(tasks.map((task) => [task.manifest.taskId, task]));
  return SMOKE_TASK_IDS.map((taskId) => {
    const task = byId.get(taskId);
    if (task === undefined) throw new Error(`smoke task is missing from the catalog: ${taskId}`);
    return task;
  });
}
