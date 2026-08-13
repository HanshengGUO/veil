import { resolve } from "node:path";
import { verifyCatalog } from "./verify.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const suiteOption = option("--suite") ?? "full";
if (suiteOption !== "smoke" && suiteOption !== "full") {
  throw new Error("--suite must be smoke or full");
}

const result = await verifyCatalog({
  tasksDirectory: resolve(option("--tasks") ?? "bench/tasks"),
  suite: suiteOption,
  variant: option("--variant"),
});

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  for (const task of result.tasks) {
    process.stdout.write(
      `${task.taskId}: seed=${task.seed} files=${task.dataFiles} bytes=${task.dataBytes}\n`,
    );
  }
  process.stdout.write(
    `verified ${result.taskCount} tasks (${result.trapCount} trap, ${result.honestCount} honest)\n`,
  );
}
