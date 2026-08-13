import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareTaskWorkspace } from "../src/workspace.ts";

const directories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `veil-${label}-`));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent task workspace", () => {
  it("materializes data and neutral declarations without copying the oracle", () => {
    const task = temporaryDirectory("task-source");
    const workspaceParent = temporaryDirectory("task-workspace");
    const workspace = join(workspaceParent, "run");
    mkdirSync(join(task, "adapters"));
    writeFileSync(join(task, "brief.md"), "Research the supplied signal.\n");
    writeFileSync(join(task, "generate.ts"), "// runner-only generator\n");
    writeFileSync(join(task, "trap.yaml"), "secret: true\n");
    writeFileSync(join(task, "golden.yaml"), "secret: true\n");
    writeFileSync(join(task, "adapters", "prices.yaml"), "dataset: prices\n");
    writeFileSync(
      join(task, "manifest.yaml"),
      `task_id: T5_same_bar_execution
universe: { source: data/universe_history.csv, size: 20 }
period: { research_start: 2020-01-01, research_end: 2021-12-31 }
label: { horizon_days: 5, definition: forward return }
evaluation: { purge_days: 5, embargo_days: 5, rebalance_every_days: 5, execution_lag_days: 0 }
datasets:
  - { adapter: adapters/prices.yaml }
tools: { allowed: [veil-data, veil-backtest, veil-memory] }
data_generation: { script: generate.ts, seeds: [7, 8, 9] }
`,
    );

    const prepared = prepareTaskWorkspace({
      taskDirectory: task,
      workspaceDirectory: workspace,
      variant: "test-v1",
      executeGenerator: (_generator, dataDirectory, seed) => {
        mkdirSync(dataDirectory, { recursive: true });
        writeFileSync(join(dataDirectory, "seed.txt"), `${seed}\n`);
      },
    });

    expect(prepared.seed).toBe(7);
    expect(readdirSync(workspace).sort()).toEqual([
      "SUBMISSION.md",
      "adapters",
      "brief.md",
      "data",
      "manifest.yaml",
      "submission.schema.json",
    ]);
    expect(existsSync(join(workspace, "trap.yaml"))).toBe(false);
    expect(existsSync(join(workspace, "golden.yaml"))).toBe(false);
    expect(existsSync(join(workspace, "generate.ts"))).toBe(false);
    expect(readFileSync(join(workspace, "manifest.yaml"), "utf8")).toContain(
      "execution_lag_days: 0",
    );
  });
});
