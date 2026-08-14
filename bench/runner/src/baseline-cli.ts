import { resolve } from "node:path";
import { runBaseline } from "./baseline.ts";
import { parseModelReference, parseProviderEnvironmentOverride } from "./model.ts";
import type { PiTaskProfile } from "./pi-session.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = option(name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

const suite = option("--suite") ?? "full";
if (suite !== "smoke" && suite !== "full") throw new Error("--suite must be smoke or full");
const modelNames = required("--models")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model.length > 0);
const timeoutMinutes = Number(option("--timeout-minutes") ?? "20");
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  throw new Error("--timeout-minutes must be positive");
}
const profile = (option("--profile") ?? "bare") as PiTaskProfile;
if (profile !== "bare" && profile !== "veil" && profile !== "veil-stage4") {
  throw new Error("--profile must be bare, veil, or veil-stage4");
}

const summary = await runBaseline({
  tasksDirectory: resolve(option("--tasks") ?? "bench/tasks"),
  outputDirectory: resolve(required("--out")),
  suite,
  variant: option("--variant") ?? `baseline-${suite}-v1`,
  models: modelNames.map((model) => parseModelReference(model, option("--thinking") ?? "medium")),
  profile,
  providerOverride: parseProviderEnvironmentOverride(
    option("--provider-base-url-env"),
    option("--provider-api-key-env"),
  ),
  timeoutMs: timeoutMinutes * 60 * 1000,
  onProgress: (message) => process.stdout.write(`${message}\n`),
});

for (const model of summary.models) {
  process.stdout.write(
    `${model.model.provider}/${model.model.model}: safety=${model.suiteScore.safety.toFixed(2)} ` +
      `competence=${model.suiteScore.competence.toFixed(2)} failed=${model.failedRuns}\n`,
  );
}
