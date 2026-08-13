import { resolve } from "node:path";
import { verifyStage2BenchAcceptance } from "./stage2-acceptance.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const report = await verifyStage2BenchAcceptance({
  tasksDirectory: resolve(option("--tasks") ?? "bench/tasks"),
});

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const probe of report.trapProbes) {
    process.stdout.write(
      `${probe.taskId}: ${probe.outcome} (${probe.invariant ?? "declaration"})\n`,
    );
  }
  process.stdout.write(
    `accepted ${report.honestTasks.length} honest tasks; exploration blocks: ${report.explorationBlockedCount}\n`,
  );
}
