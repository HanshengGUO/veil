import { resolve } from "node:path";
import { verifyStage4BenchAcceptance } from "./stage4-acceptance.ts";

const report = await verifyStage4BenchAcceptance({
  tasksDirectory: resolve("bench/tasks"),
  repositoryRoot: resolve("."),
});

process.stdout.write(`${JSON.stringify(report)}\n`);
