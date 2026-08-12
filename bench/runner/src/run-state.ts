import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RunPhase = "preparing" | "agent_running" | "validating" | "completed" | "failed";

export interface RunState {
  schemaVersion: 1;
  taskId: string;
  phase: RunPhase;
  updatedAt: string;
  detail?: string;
}

export function writeRunState(
  outputDirectory: string,
  taskId: string,
  phase: RunPhase,
  detail?: string,
): void {
  const path = join(outputDirectory, "run-state.json");
  const temporary = join(outputDirectory, ".run-state.json.tmp");
  const state: RunState = {
    schemaVersion: 1,
    taskId,
    phase,
    updatedAt: new Date().toISOString(),
    ...(detail === undefined ? {} : { detail }),
  };
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
}
