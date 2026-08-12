import { resolve } from "node:path";
import { rescoreBaseline } from "./baseline.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = option(name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

const summary = rescoreBaseline({
  tasksDirectory: resolve(option("--tasks") ?? "bench/tasks"),
  runDirectory: resolve(required("--run")),
  onProgress: (message) => process.stdout.write(`${message}\n`),
});

for (const model of summary.models) {
  process.stdout.write(
    `${model.model.provider}/${model.model.model}: safety=${model.suiteScore.safety.toFixed(2)} ` +
      `competence=${model.suiteScore.competence.toFixed(2)} failed=${model.failedRuns}\n`,
  );
}
