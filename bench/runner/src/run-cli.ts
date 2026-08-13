import { resolve } from "node:path";
import { parseModelReference, parseProviderEnvironmentOverride } from "./model.ts";
import { type PiTaskProfile, runBarePiTask, runVeilPiTask } from "./pi-session.ts";
import { discoverTasks } from "./tasks.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = option(name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

const taskId = required("--task");
const task = discoverTasks(resolve(option("--tasks") ?? "bench/tasks")).find(
  (candidate) => candidate.manifest.taskId === taskId,
);
if (task === undefined) throw new Error(`unknown task: ${taskId}`);

const timeoutMinutes = Number(option("--timeout-minutes") ?? "20");
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  throw new Error("--timeout-minutes must be positive");
}
const profile = (option("--profile") ?? "bare") as PiTaskProfile;
if (profile !== "bare" && profile !== "veil") {
  throw new Error("--profile must be bare or veil");
}

const runTask = profile === "bare" ? runBarePiTask : runVeilPiTask;
const result = await runTask({
  task,
  model: parseModelReference(required("--model"), option("--thinking") ?? "medium"),
  outputDirectory: resolve(required("--out")),
  providerOverride: parseProviderEnvironmentOverride(
    option("--provider-base-url-env"),
    option("--provider-api-key-env"),
  ),
  variant: option("--variant"),
  timeoutMs: timeoutMinutes * 60 * 1000,
});

process.stdout.write(`${result.taskId}: ${JSON.stringify(result.score)}\n`);
