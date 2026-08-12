import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadTaskManifest, type TaskManifest } from "./manifest.ts";
import { type GoldenOracle, loadGoldenOracle, loadTrapOracle, type TrapOracle } from "./oracle.ts";

export interface TrapTaskDefinition {
  kind: "trap";
  directory: string;
  manifest: TaskManifest;
  oracle: TrapOracle;
}

export interface HonestTaskDefinition {
  kind: "honest";
  directory: string;
  manifest: TaskManifest;
  oracle: GoldenOracle;
}

export type TaskDefinition = TrapTaskDefinition | HonestTaskDefinition;

export function loadTaskDefinition(directory: string): TaskDefinition {
  const resolved = resolve(directory);
  const manifest = loadTaskManifest(join(resolved, "manifest.yaml"));
  if (manifest.taskId !== basename(resolved)) {
    throw new Error(`task_id ${manifest.taskId} does not match directory ${basename(resolved)}`);
  }
  for (const required of ["brief.md", manifest.dataGeneration.script]) {
    if (!existsSync(join(resolved, required)))
      throw new Error(`${manifest.taskId}: missing ${required}`);
  }
  for (const dataset of manifest.datasets) {
    if (!existsSync(join(resolved, dataset.adapter))) {
      throw new Error(`${manifest.taskId}: missing ${dataset.adapter}`);
    }
  }

  const trapPath = join(resolved, "trap.yaml");
  const goldenPath = join(resolved, "golden.yaml");
  if (existsSync(trapPath) === existsSync(goldenPath)) {
    throw new Error(`${manifest.taskId}: exactly one of trap.yaml or golden.yaml is required`);
  }

  if (existsSync(trapPath)) {
    const oracle = loadTrapOracle(trapPath);
    if (oracle.taskId !== manifest.taskId)
      throw new Error(`${manifest.taskId}: trap task_id mismatch`);
    if (oracle.calibration.class !== "structural") {
      if (oracle.calibration.seeds.join(",") !== manifest.dataGeneration.seeds.join(",")) {
        throw new Error(`${manifest.taskId}: manifest seeds do not match calibrated seeds`);
      }
    }
    return { kind: "trap", directory: resolved, manifest, oracle };
  }

  const oracle = loadGoldenOracle(goldenPath);
  if (oracle.taskId !== manifest.taskId)
    throw new Error(`${manifest.taskId}: golden task_id mismatch`);
  return { kind: "honest", directory: resolved, manifest, oracle };
}

export function discoverTasks(tasksDirectory: string): TaskDefinition[] {
  return readdirSync(tasksDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => loadTaskDefinition(join(tasksDirectory, entry.name)))
    .sort((left, right) => left.manifest.taskId.localeCompare(right.manifest.taskId));
}
