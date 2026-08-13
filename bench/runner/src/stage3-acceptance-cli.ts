import { resolve } from "node:path";
import { verifyStage3BenchAcceptance } from "./stage3-acceptance.ts";

const report = await verifyStage3BenchAcceptance({
  tasksDirectory: resolve("bench/tasks"),
  repositoryRoot: resolve("."),
});

process.stdout.write(`${JSON.stringify(report)}\n`);
