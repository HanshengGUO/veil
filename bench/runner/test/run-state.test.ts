import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunState } from "../src/run-state.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("run phase checkpoints", () => {
  it("atomically replaces the prior phase without leaving a temporary file", () => {
    const output = mkdtempSync(join(tmpdir(), "veil-run-state-"));
    directories.push(output);

    writeRunState(output, "H2_null_market", "preparing");
    writeRunState(output, "H2_null_market", "completed", "preflight passed");

    expect(JSON.parse(readFileSync(join(output, "run-state.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      taskId: "H2_null_market",
      phase: "completed",
      detail: "preflight passed",
    });
    expect(existsSync(join(output, ".run-state.json.tmp"))).toBe(false);
  });
});
